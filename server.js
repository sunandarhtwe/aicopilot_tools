const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');

loadDotEnv(path.join(__dirname, '.env'));

let XLSX = null;
try { XLSX = require('xlsx'); } catch (_) { XLSX = null; }

const app = express();
const PORT = process.env.PORT || 3000;
// --- Copilot Bridge configuration ------------------------------------------
// This server no longer calls OpenAI directly. Instead it talks to the local
// "DAT Copilot Bridge" VS Code extension (see /copilot-bridge folder), which
// runs inside VS Code, uses the vscode.lm API to reach the signed-in user's
// GitHub Copilot subscription, and exposes a small local HTTP endpoint.
// The extension MUST be running (VS Code open, extension activated) before
// clicking "Generate Test Cases", otherwise generation falls back to the
// document-based (non-AI) engine.
const COPILOT_BRIDGE_URL = process.env.COPILOT_BRIDGE_URL || 'http://127.0.0.1:4321/generate';
const COPILOT_MODEL_FAMILY = process.env.COPILOT_MODEL_FAMILY || ''; // e.g. 'gpt-4o', 'claude-3.5-sonnet' — empty = bridge default
const COPILOT_TIMEOUT_MS = Number(process.env.COPILOT_TIMEOUT_MS || 120000);
// --- Copilot prompt size budget ---------------------------------------------
// GitHub Copilot's chat models (reached via vscode.lm inside the bridge
// extension) have a much smaller per-message context window than a direct
// OpenAI API call — sending the same ~150k-character prompts that worked
// fine against gpt-4o's API used to work now fails with
// "Message exceeds token limit". These caps keep the combined prompt small
// enough to fit reliably. All are configurable via .env if a given Copilot
// model turns out to tolerate more (or less).
const COPILOT_MAX_DOC_CHARS = Number(process.env.COPILOT_MAX_DOC_CHARS || 8000);
const COPILOT_MAX_SAMPLE_CHARS = Number(process.env.COPILOT_MAX_SAMPLE_CHARS || 1500);
const COPILOT_MAX_KNOWLEDGE_CHARS = Number(process.env.COPILOT_MAX_KNOWLEDGE_CHARS || 5000);
const COPILOT_MAX_ANALYSIS_CHARS = Number(process.env.COPILOT_MAX_ANALYSIS_CHARS || 5000);
// Hard final safety cap applied to the fully-assembled prompt right before
// it's sent to the bridge, regardless of how the pieces above add up.
const COPILOT_MAX_TOTAL_PROMPT_CHARS = Number(process.env.COPILOT_MAX_TOTAL_PROMPT_CHARS || 18000);
// ---------------------------------------------------------------------------

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const GENERATED_DIR = path.join(__dirname, 'generated');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(GENERATED_DIR, { recursive: true });

app.use(cors());
app.use(express.json({ limit: '30mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/generated', express.static(GENERATED_DIR));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safe = decodeFileName(file.originalname).replace(/[\\/:*?"<>|]/g, '_');
    cb(null, `${Date.now()}_${safe}`);
  }
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(decodeFileName(file.originalname)).toLowerCase();
    const ok = ['.xlsx', '.xls', '.pdf', '.docx', '.doc', '.pptx', '.txt', '.md', '.csv'].includes(ext);
    cb(ok ? null : new Error(`Unsupported file type: ${ext}`), ok);
  },
  limits: { fileSize: 50 * 1024 * 1024, files: 20 }
});
let uploadedFiles = [];
let latestCases = [];
let latestSavedCases = []; // ⑤/⑥: last Saved/generated snapshot used by Cancel to revert edits
let latestMeta = {};
let latestCoverage = null; // V2.2: Coverage Engine result for the most recent generation

// --- Test Case Type profiles ------------------------------------------------
// ② User selects one of these before Generate. Each profile changes wording
// injected into both AI prompts (analysis + case generation) so Copilot
// produces the right granularity/scope of test case.
const TEST_TYPE_PROFILES = {
  integration: {
    label: '結合テスト (Integration Test)',
    analysisHint: '画面間・機能間の連携、DB更新、外部/内部インターフェース呼び出し、業務フロー全体の整合性を重視してください。',
    caseHint: '結合テストとして、画面遷移・DB反映・他機能との連携・業務フロー全体を通したテストケースを作成してください。単一関数の内部ロジックだけを検証するテストは作らないでください。'
  },
  unit: {
    label: '単体テスト (Unit Test)',
    analysisHint: '個々の入力項目・関数・バリデーションロジック単位での境界値・異常値・条件分岐を重視してください。画面遷移やDB間連携などの結合観点は最小限にしてください。',
    caseHint: '単体テストとして、個々の入力項目・関数・条件分岐単位の境界値／異常値／同値分割テストケースを作成してください。ケースは1機能・1項目・1条件にできるだけ絞り込み、複数画面をまたぐ結合シナリオは作らないでください。'
  },
  comprehensive: {
    label: '総合テスト (Comprehensive Test)',
    analysisHint: '単体レベルの入力チェックから結合レベルの画面遷移・DB連携、さらに異常系・非機能観点（性能・排他制御・権限）まで幅広く整理してください。',
    caseHint: '総合テストとして、単体レベルの入力チェックから結合レベルの画面遷移・DB連携、業務シナリオ全体、異常系、権限/排他制御まで幅広く網羅するテストケースを作成してください。'
  }
};
// ---------------------------------------------------------------------------

// --- V2.2: In-memory Knowledge Base Cache ---------------------------------
// Caches parsed rows per file so re-generating with the same uploaded files
// does not re-parse the document every time. Cleared on server restart
// (in-memory only by design) and on graceful shutdown.
const knowledgeBaseCache = new Map(); // key: `${path}::${size}::${mtimeMs}` -> { rows, classification, cachedAt }

function cacheKeyFor(filePath) {
  try {
    const st = fs.statSync(filePath);
    return `${filePath}::${st.size}::${st.mtimeMs}`;
  } catch (_) {
    return `${filePath}::unknown`;
  }
}

function getCachedRows(filePath) {
  const key = cacheKeyFor(filePath);
  const hit = knowledgeBaseCache.get(key);
  return hit ? hit : null;
}

function setCachedRows(filePath, rows, classification) {
  const key = cacheKeyFor(filePath);
  knowledgeBaseCache.set(key, { rows, classification, cachedAt: Date.now() });
}

function clearKnowledgeBaseCache() {
  const size = knowledgeBaseCache.size;
  knowledgeBaseCache.clear();
  return size;
}
// ---------------------------------------------------------------------------

// --- V2.2: Document Classifier --------------------------------------------
// Classifies an uploaded design document into a category based on its file
// name and the text content extracted from it. Pure heuristic (no AI call)
// so it works even when the OpenAI API is not configured. The result is
// surfaced in the generation log AND fed into the AI prompt as context so
// the model can weight evidence according to the kind of document it came
// from (e.g. DB definition rows vs. screen design rows vs. error tables).
const DOCUMENT_TYPE_RULES = [
  { type: '基本設計書', re: /(基本設計書|概要設計書|基本設計)/ },
  { type: '詳細設計書', re: /(詳細設計書|詳細設計|機能設計書)/ },
  { type: 'DB定義書', re: /(DB定義書|テーブル定義書|テーブル仕様書|ER図|データ定義)/ },
  { type: '画面設計書', re: /(画面設計書|画面仕様書|画面遷移図|UI設計)/ },
  { type: 'エラーメッセージ一覧', re: /(エラーメッセージ一覧|メッセージ一覧|エラーコード一覧)/ },
  { type: 'テストケース（参考）', re: /(テストケース|テスト仕様書|試験項目)/ },
  { type: '提案書／その他資料', re: /(提案書|proposal|議事録|手順書)/i }
];

function classifyDocument(originalName, rows) {
  const sampleText = (rows || []).slice(0, 80).map(r => r.text).join(' ');
  const haystack = `${originalName} ${sampleText}`;

  const scored = DOCUMENT_TYPE_RULES.map(rule => ({
    type: rule.type,
    score: (haystack.match(rule.re) || []).length
  })).filter(r => r.score > 0);

  scored.sort((a, b) => b.score - a.score);

  // Secondary signal: row-shape heuristics when filename/content gave no hit.
  let type = scored.length ? scored[0].type : null;
  if (!type) {
    const dbLike = (rows || []).filter(r => /(DB|テーブル|カラム|レコード|型|PK|FK)/.test(r.text)).length;
    const screenLike = (rows || []).filter(r => /(画面|ボタン|メニュー|遷移)/.test(r.text)).length;
    const errorLike = (rows || []).filter(r => /(エラー|メッセージ|E\d{3,}|\b\d{4,5}\b)/.test(r.text)).length;
    const best = [['DB定義書', dbLike], ['画面設計書', screenLike], ['エラーメッセージ一覧', errorLike]]
      .sort((a, b) => b[1] - a[1])[0];
    type = best && best[1] > 0 ? best[0] : '一般資料';
  }

  const confidence = scored.length
    ? Math.min(1, scored[0].score / 5)
    : 0.3;

  return { fileName: originalName, documentType: type, confidence: Number(confidence.toFixed(2)) };
}
// ---------------------------------------------------------------------------

app.post('/api/upload', upload.array('documents', 20), (req, res) => {
  uploadedFiles = (req.files || []).map((f) => ({
    originalName: decodeFileName(f.originalname),
    fileName: f.filename,
    path: f.path,
    size: f.size,
    mimetype: f.mimetype
  }));
  res.json({ ok: true, files: uploadedFiles.map(publicFileInfo) });
});

// Health endpoint — polled by the DAT Copilot Bridge extension's watchdog so
// it can automatically quit VS Code shortly after this server goes away
// (e.g. the user closed the cmd window without a clean Ctrl+C).
app.get('/api/health', (req, res) => res.json({ ok: true, service: 'dat-ai-testcase-generator', time: Date.now() }));

app.get('/api/files', (req, res) => res.json({ files: uploadedFiles.map(publicFileInfo) }));

app.post('/api/generate', async (req, res) => {
  const { keyword = '', notes = '', author = 'AI Test Case Generator (Copilot Bridge Smart QA)', testType = 'integration' } = req.body || {};
  if (!keyword.trim()) return res.status(400).json({ ok: false, message: '機能名／キーワードを入力してください。' });
  if (!TEST_TYPE_PROFILES[testType]) return res.status(400).json({ ok: false, message: `不正なtest case type: ${testType}` });

  const log = [];
  const effectiveFiles = uploadedFiles.length ? uploadedFiles : scanExistingUploads();
  if (!uploadedFiles.length && effectiveFiles.length) log.push(`Existing uploads folderから ${effectiveFiles.length} file(s) を読み込みました。`);

  const docResult = await collectDocumentText(effectiveFiles, keyword, notes, log);
  const sampleText = await collectGeneratedSampleText(log);
  const deterministicKnowledge = extractDeterministicKnowledge(docResult.allRows, keyword, notes, docResult.documentClassifications);

  let generated = null;
  let source = 'document-fallback';
  let smartAnalysis = null;

  try {
    log.push(`GitHub Copilot Bridgeへ接続中: ${COPILOT_BRIDGE_URL}`);
    log.push(`Test Case Type: ${TEST_TYPE_PROFILES[testType].label}`);
    log.push('Stage 1: Business Rule / Error Message / Screen Flow extraction');
    smartAnalysis = await generateByCopilotObject(buildSmartAnalysisPrompt(keyword, notes, docResult.relevantText || docResult.allText, deterministicKnowledge, sampleText, testType));

    log.push('Stage 2: Test case generation');
    const prompt = buildSmartTestCasePrompt(keyword, notes, docResult.relevantText || docResult.allText, deterministicKnowledge, smartAnalysis, sampleText, testType);
    generated = await generateByCopilot(prompt);
    source = 'copilot-bridge-smart-qa';
    log.push(`Copilot Bridge: request completed${COPILOT_MODEL_FAMILY ? ` (model family: ${COPILOT_MODEL_FAMILY})` : ''}`);
  } catch (err) {
    log.push(`Copilot Bridge not reachable/failed. Document-based fallback cases will be generated.`);
    log.push(String(err.message || err));
    generated = buildDocumentBasedCases(keyword, notes, docResult.matches, docResult.allRows);
  }

  const beforeDedupeCount = Array.isArray(generated) ? generated.length : 0;
  latestCases = dedupeGeneratedCases(normalizeCases(generated, keyword));
  if (beforeDedupeCount && beforeDedupeCount !== latestCases.length) {
    log.push(`Duplicate removal: ${beforeDedupeCount} → ${latestCases.length} 件（重複 ${beforeDedupeCount - latestCases.length} 件を除去）`);
  }
  latestMeta = { keyword, notes, author, date: new Date().toISOString().slice(0, 10), source, smartAnalysis, testType, testTypeLabel: TEST_TYPE_PROFILES[testType].label };
  latestSavedCases = latestCases; // ⑤/⑥: baseline snapshot for Save/Cancel round-trip

  // V2.2/V3.2: Coverage Engine — pass keyword+notes so user-specified topics
  // also appear as candidates in the coverage report, not only document-extracted ones.
  latestCoverage = buildCoverageReport(deterministicKnowledge, latestCases, keyword, notes);
  coverageLogLines(latestCoverage).forEach(line => log.push(line));

  const excelUrl = await writeExcel(latestCases, latestMeta, latestCoverage);
  res.json({
    ok: true,
    source,
    log,
    meta: latestMeta,
    cases: latestCases,
    excelUrl,
    matchedCount: docResult.matches.length,
    parsedFiles: docResult.parsedFiles,
    documentClassifications: docResult.documentClassifications,
    smartAnalysis,
    coverage: latestCoverage
  });
});

app.get('/api/download/latest', async (req, res) => {
  if (!latestCases.length) return res.status(404).send('No generated test cases.');
  const filePath = await writeExcel(latestCases, latestMeta, latestCoverage);
  res.download(path.join(__dirname, filePath.replace(/^\//, '')));
});

// ⑤ Save: the frontend posts the full (edited) case table here after the
// user clicks "Save". Only once this succeeds does /api/download/latest (or
// the download button) reflect the edited content — this endpoint also
// becomes the new "last saved" baseline that Cancel reverts to.
app.post('/api/update-cases', async (req, res) => {
  const { cases } = req.body || {};
  if (!Array.isArray(cases) || !cases.length) {
    return res.status(400).json({ ok: false, message: '保存するテストケースがありません。' });
  }
  latestCases = cases.map((c, i) => ({
    no: safeText(c.no) || `TC${String(i + 1).padStart(3, '0')}`,
    category: safeText(c.category),
    testItem: safeText(c.testItem),
    precondition: safeText(c.precondition),
    steps: safeText(c.steps),
    inputData: safeText(c.inputData),
    expectedResult: safeText(c.expectedResult),
    priority: safeText(c.priority)
  }));
  latestSavedCases = latestCases; // ⑥: becomes the new Cancel baseline
  const excelUrl = await writeExcel(latestCases, latestMeta, latestCoverage);
  res.json({ ok: true, cases: latestCases, excelUrl });
});

// ⑥ Cancel: returns the last-saved baseline (last successful /api/generate
// or /api/update-cases) so the frontend can restore the preview table to
// what it looked like before the user's unsaved edits.
app.get('/api/cases/saved', (req, res) => {
  res.json({ ok: true, cases: latestSavedCases, meta: latestMeta });
});

// ④ Clear in-memory state and Knowledge Base Cache on demand.
// Called by the frontend immediately before each /api/generate so each
// generation starts clean — no stale cases, no stale parsed-document cache.
app.post('/api/clear', (req, res) => {
  const cleared = clearKnowledgeBaseCache();
  uploadedFiles = [];
  latestCases = [];
  latestSavedCases = [];
  latestMeta = {};
  latestCoverage = null;
  res.json({ ok: true, clearedCacheEntries: cleared });
});

function loadDotEnv(envPath) {
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] == null) process.env[key] = value;
  }
}

function publicFileInfo(f) {
  return { originalName: f.originalName, fileName: f.fileName, size: f.size, mimetype: f.mimetype };
}

function decodeFileName(name) {
  try {
    const decoded = Buffer.from(name, 'latin1').toString('utf8');
    return decoded.includes('�') ? name : decoded;
  } catch (_) { return name; }
}


function scanExistingUploads() {
  if (!fs.existsSync(UPLOAD_DIR)) return [];
  return fs.readdirSync(UPLOAD_DIR)
    .map(fileName => {
      const full = path.join(UPLOAD_DIR, fileName);
      const st = fs.statSync(full);
      if (!st.isFile()) return null;
      const originalName = fileName.replace(/^\d+_/, '');
      return { originalName, fileName, path: full, size: st.size, mimetype: '' };
    })
    .filter(Boolean);
}

async function collectGeneratedSampleText(log) {
  if (!fs.existsSync(GENERATED_DIR)) return '';
  const files = fs.readdirSync(GENERATED_DIR)
    .filter(n => /\.(xlsx|xls|json|txt|md)$/i.test(n))
    .map(n => ({ name: n, path: path.join(GENERATED_DIR, n), mtime: fs.statSync(path.join(GENERATED_DIR, n)).mtimeMs }))
    .sort((a,b) => b.mtime - a.mtime)
    .slice(0, 3);
  const chunks = [];
  for (const f of files) {
    try {
      const ext = path.extname(f.name).toLowerCase();
      if (ext === '.xlsx') {
        const rows = await parseFileToRows({ path: f.path, originalName: f.name }, ext);
        chunks.push(`【Generated sample: ${f.name}】\n` + rows.slice(0, 60).map(r => r.text).join('\n'));
      } else if (ext === '.xls' && XLSX) {
        const rows = parseWithXlsx(f.path);
        chunks.push(`【Generated sample: ${f.name}】\n` + rows.slice(0, 60).map(r => r.text).join('\n'));
      } else {
        chunks.push(`【Generated sample: ${f.name}】\n` + fs.readFileSync(f.path, 'utf8').slice(0, 8000));
      }
    } catch (e) {
      log.push(`Generated sample parse skipped ${f.name}: ${e.message}`);
    }
  }
  if (chunks.length) log.push(`Generated folder reference: ${chunks.length} file(s)`);
  return chunks.join('\n\n').slice(0, 20000);
}

async function collectDocumentText(files, keyword, notes, log) {
  const allRows = [];
  const parsedFiles = [];
  const documentClassifications = [];

  for (const file of files) {
    const ext = path.extname(file.originalName).toLowerCase();
    try {
      // V2.2: Knowledge Base Cache — reuse parsed rows + classification when
      // the same file (path+size+mtime) was already parsed before, instead
      // of re-parsing the document on every /api/generate call.
      const cached = getCachedRows(file.path);
      let rows, classification;
      if (cached) {
        rows = cached.rows;
        classification = cached.classification;
        log.push(`Cache hit ${file.originalName}: ${rows.length} row(s)/line(s) (Knowledge Base Cache)`);
      } else {
        rows = await parseFileToRows(file, ext);
        classification = classifyDocument(file.originalName, rows);
        setCachedRows(file.path, rows, classification);
        log.push(`Parsed ${file.originalName}: ${rows.length} row(s)/line(s)`);
      }

      rows.forEach((r, idx) => allRows.push({ ...r, fileName: file.originalName, rowNo: idx + 1 }));
      parsedFiles.push({ fileName: file.originalName, ext, rows: rows.length, ok: true, documentType: classification.documentType });
      documentClassifications.push(classification);
      log.push(`Document Classifier: ${file.originalName} → ${classification.documentType} (confidence ${classification.confidence})`);
    } catch (e) {
      parsedFiles.push({ fileName: file.originalName, ext, rows: 0, ok: false, error: e.message });
      log.push(`Parse failed ${file.originalName}: ${e.message}`);
    }
  }

  const terms = buildSearchTerms(`${keyword} ${notes || ''}`);
  const scored = allRows.map(r => ({ ...r, score: scoreText(r.text, terms) })).filter(r => r.score > 0);
  scored.sort((a, b) => b.score - a.score);

  let matches = expandContextRows(allRows, scored.slice(0, 120), 3).slice(0, 220);
  if (matches.length === 0 && allRows.length) {
    matches = allRows.filter(r => isLikelySpecRow(r.text)).slice(0, 80);
  }
  if (matches.length === 0) matches = allRows.slice(0, 80);

  const allText = allRows.map(r => `[${r.fileName}${r.sheet ? ' / ' + r.sheet : ''} R${r.rowNo}] ${r.text}`).join('\n').slice(0, 80000);
  const relevantText = matches.map(r => `[${r.fileName}${r.sheet ? ' / ' + r.sheet : ''} R${r.rowNo}] ${r.text}`).join('\n').slice(0, 60000);
  log.push(`Keyword search matched: ${matches.length} row(s)/line(s)`);

  return { allRows, matches, allText, relevantText, parsedFiles, documentClassifications };
}

async function parseFileToRows(file, ext) {
  if (ext === '.txt' || ext === '.md' || ext === '.csv') {
    const text = fs.readFileSync(file.path, 'utf8');
    return text.split(/\r?\n/).map(x => cleanText(x)).filter(Boolean).map(text => ({ text }));
  }
  if (ext === '.docx') {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ path: file.path });
    return result.value.split(/\r?\n/).map(x => cleanText(x)).filter(Boolean).map(text => ({ text }));
  }
  if (ext === '.doc') {
    // Legacy .doc is binary. This best-effort extraction may not be perfect.
    const buf = fs.readFileSync(file.path);
    const text = buf.toString('utf8').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ');
    return text.split(/\r?\n|\s{3,}/).map(x => cleanText(x)).filter(x => x.length > 3).map(text => ({ text }));
  }

  if (ext === '.pptx') {
    const JSZip = require('jszip');
    const zip = await JSZip.loadAsync(fs.readFileSync(file.path));
    const rows = [];
    const names = Object.keys(zip.files)
      .filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n) || /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n))
      .sort((a,b) => a.localeCompare(b, undefined, { numeric: true }));
    for (const name of names) {
      const xml = await zip.files[name].async('string');
      const text = cleanText(xml
        .replace(/<a:br\s*\/?>/g, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'"));
      if (text) rows.push({ sheet: name.replace(/^ppt\//, ''), text });
    }
    return rows;
  }

  if (ext === '.pdf') {
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(fs.readFileSync(file.path));
    return data.text.split(/\r?\n/).map(x => cleanText(x)).filter(Boolean).map(text => ({ text }));
  }
  if (ext === '.xlsx') {
    // ExcelJS keeps formatting stable for xlsx.
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file.path);
    const rows = [];
    wb.worksheets.forEach((ws) => {
      ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        const values = row.values.slice(1).map(cellToText).filter(Boolean);
        const text = cleanText(values.join(' | '));
        if (text) rows.push({ sheet: ws.name, rowNo: rowNumber, text });
      });
    });
    return rows;
  }
  if (ext === '.xls') {
    if (!XLSX) throw new Error('To read .xls files, please run: npm install xlsx');
    return parseWithXlsx(file.path);
  }
  throw new Error(`Unsupported file extension: ${ext}`);
}

function parseWithXlsx(filePath) {
  const wb = XLSX.readFile(filePath, { cellDates: true });
  const rows = [];
  wb.SheetNames.forEach(sheetName => {
    const sheet = wb.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    data.forEach((arr, idx) => {
      const text = cleanText(arr.map(cellToText).filter(Boolean).join(' | '));
      if (text) rows.push({ sheet: sheetName, rowNo: idx + 1, text });
    });
  });
  return rows;
}

function cellToText(v) {
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v.text) return String(v.text);
    if (v.richText) return v.richText.map(x => x.text || '').join('');
    if (v.result != null) return String(v.result);
    if (v.formula) return String(v.formula);
    if (v instanceof Date) return v.toISOString().slice(0, 10);
  }
  return String(v);
}

function cleanText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}


function expandContextRows(allRows, matchedRows, radius = 2) {
  const keys = new Set();
  const result = [];
  const add = (r) => {
    const key = `${r.fileName}::${r.sheet || ''}::${r.rowNo}`;
    if (!keys.has(key)) { keys.add(key); result.push(r); }
  };
  for (const m of matchedRows) {
    for (const r of allRows) {
      if (r.fileName === m.fileName && (r.sheet || '') === (m.sheet || '') && Math.abs((r.rowNo || 0) - (m.rowNo || 0)) <= radius) add(r);
    }
  }
  return result;
}

function buildSearchTerms(keyword) {
  const base = String(keyword || '').trim();
  const terms = new Set([base]);
  base.split(/[\s　,、/・()（）\[\]【】]+/).filter(Boolean).forEach(t => terms.add(t));
  const synonyms = {
    '購入注文': ['購入', '注文', '申込', '買付', '登録', '確認', '完了'],
    '定時定額': ['定時', '定額', '積立', '新規', '申込', '金額', '契約', '定時定額（新規）'],
    'ログイン': ['ログイン', 'ID', 'パスワード', '認証'],
    '運用報告書': ['運用報告書', '報告書', '交付', '閲覧'],
    'DB': ['DB', 'テーブル', '登録', '更新', '削除', 'レコード'],
    '非課税口座簡易開設申込日': ['非課税口座簡易開設申込日', '簡易開設', '申込日', '先日付', 'NISA', 'NISA注文チェック', 'エラーメッセージ', '日付'],
    '先日付': ['先日付', '未来日', '日付チェック', 'NISA注文チェック', 'エラー', 'メッセージ'],
    'NISA': ['NISA', '非課税', '非課税口座', '注文チェック', '口座開設']
  };
  Object.entries(synonyms).forEach(([k, vals]) => {
    if (base.includes(k)) vals.forEach(v => terms.add(v));
  });
  return [...terms].filter(Boolean);
}

function scoreText(text, terms) {
  const t = String(text || '').toLowerCase();
  let score = 0;
  terms.forEach(term => {
    const q = String(term).toLowerCase();
    if (!q) return;
    if (t.includes(q)) score += q.length >= 4 ? 5 : 3;
  });
  if (isLikelySpecRow(text)) score += 2;
  return score;
}

function isLikelySpecRow(text) {
  return /(画面|ボタン|リンク|チェック|エラー|入力|表示|遷移|登録|更新|削除|DB|テーブル|確認|項目|条件|必須|上限|下限|正常|異常)/.test(text);
}

function extractDeterministicKnowledge(rows, keyword, notes, documentClassifications) {
  const all = (rows || []).map(r => ({ ...r, text: cleanText(r.text) })).filter(r => r.text);
  const baseTerms = buildSearchTerms(`${keyword} ${notes || ''}`);
  const focusRows = all
    .map((r, idx) => ({ ...r, __idx: idx, score: scoreText(r.text, baseTerms) + (/(エラー|メッセージ|チェック|条件|画面|遷移|入力|項目|日付|NISA|非課税|DB|テーブル|登録|更新|口座|受付|不可|必須|上限|下限|同日|翌|先日付|未来日)/.test(r.text) ? 4 : 0) }))
    .filter(r => r.score > 0 || /(\b\d{4,5}\b|E\d{3,}|エラー|メッセージ|画面|遷移|チェック|必須|NISA|非課税)/i.test(r.text))
    .sort((a,b) => b.score - a.score)
    .slice(0, 260);

  const errorMessages = extractErrorMessageCandidates(all, focusRows).slice(0, 120);
  const screenTransitions = extractScreenTransitionCandidates(all, focusRows).slice(0, 120);
  const validationRules = extractValidationRuleCandidates(all, focusRows).slice(0, 160);
  const inputFields = extractInputFieldCandidates(all, focusRows).slice(0, 120);
  const dbOrInterfaceChecks = focusRows
    .filter(r => /(DB|テーブル|登録|更新|削除|レコード|ステータス|状態|IF|インターフェース|連携|作成|保存)/i.test(r.text))
    .map(r => ({ rule: r.text, source: rowSource(r) }))
    .slice(0, 80);

  return {
    // V2.2: Document Classifier output, passed through so the AI prompt can
    // weight evidence by document type (e.g. trust DB definition documents
    // for dbOrInterfaceChecks, screen design docs for screenTransitions).
    documentClassification: documentClassifications || [],
    focusTerms: baseTerms.slice(0, 50),
    errorMessages,
    screenTransitions,
    validationRules,
    inputFields,
    dbOrInterfaceChecks,
    evidenceRows: focusRows.map(rowRef).slice(0, 140)
  };
}

function rowRef(r) {
  return `[${r.fileName || ''}${r.sheet ? ' / ' + r.sheet : ''} R${r.rowNo || ''}] ${r.text}`;
}

function rowSource(r) {
  return `${r.fileName || ''}${r.sheet ? ' / ' + r.sheet : ''} R${r.rowNo || ''}`.trim();
}

function contextForRow(all, target, radius = 2) {
  return all.filter(r => r.fileName === target.fileName && (r.sheet || '') === (target.sheet || '') && Math.abs((r.rowNo || 0) - (target.rowNo || 0)) <= radius)
    .map(r => r.text)
    .filter(Boolean)
    .join(' / ');
}

function extractErrorMessageCandidates(all, focusRows) {
  const rows = focusRows.filter(r => /(\b\d{4,5}\b|E\d{3,}|エラー|メッセージ|受付不可|受付できません|入力してください|指定してください|表示|不可|警告)/i.test(r.text));
  const out = [];
  for (const r of rows) {
    const ctx = contextForRow(all, r, 2);
    const codes = r.text.match(/\b\d{4,5}\b|E\d{3,}/g) || (ctx.match(/\b\d{4,5}\b|E\d{3,}/g) || []);
    const msg = extractLikelyMessage(ctx || r.text);
    if (codes.length) {
      [...new Set(codes)].forEach(code => out.push({ code, message: msg || '要確認', condition: extractLikelyCondition(ctx || r.text), source: rowSource(r), context: shorten(ctx || r.text, 240) }));
    } else {
      out.push({ code: '要確認', message: msg || shorten(r.text, 120), condition: extractLikelyCondition(ctx || r.text), source: rowSource(r), context: shorten(ctx || r.text, 240) });
    }
  }
  return dedupeBy(out, x => `${x.code}::${x.message}::${x.source}`);
}

function extractLikelyMessage(text) {
  const s = cleanText(text);
  const quoted = s.match(/[「『](.*?)(?:」|』)/);
  if (quoted && /(エラー|不可|ください|ません|表示|受付|指定|入力)/.test(quoted[1])) return quoted[1];
  const parts = s.split(/\s*[|／/。]\s*/).map(cleanText).filter(Boolean);
  const hit = parts.find(p => /(エラー|不可|ください|ません|表示|受付|指定|入力|確認)/.test(p) && p.length <= 140);
  return hit || '';
}

function extractLikelyCondition(text) {
  const s = cleanText(text);
  const parts = s.split(/\s*[|／/。]\s*/).map(cleanText).filter(Boolean);
  const hit = parts.find(p => /(場合|とき|時|条件|チェック|先日付|未来日|過去日|同日|翌|NISA|非課税|未入力|上限|下限|口座)/.test(p) && p.length <= 160);
  return hit || '要確認';
}

function extractScreenTransitionCandidates(all, focusRows) {
  const rows = focusRows.filter(r => /(画面|メニュー|ボタン|リンク|遷移|ログイン|確認|完了|戻る|次へ|登録|押下|クリック|選択)/.test(r.text));
  const out = [];
  for (const r of rows) {
    const ctx = contextForRow(all, r, 2);
    const screens = [...new Set((ctx.match(/[\w一-龠ぁ-んァ-ヶー（）()・／/\- ]{2,40}(?:画面|メニュー|ボタン|リンク|確認|完了|一覧|入力|申込|注文)/g) || []).map(cleanText))].slice(0, 8);
    out.push({ flow: screens.length ? screens.join(' → ') : shorten(r.text, 160), operation: extractOperation(ctx || r.text), source: rowSource(r), context: shorten(ctx || r.text, 260) });
  }
  return dedupeBy(out, x => `${x.flow}::${x.source}`);
}

function extractOperation(text) {
  const s = cleanText(text);
  const parts = s.split(/\s*[|／/。]\s*/).map(cleanText).filter(Boolean);
  const hit = parts.find(p => /(クリック|押下|選択|入力|表示|遷移|ログイン|登録|確認|戻る|次へ)/.test(p) && p.length <= 140);
  return hit || '要確認';
}

function extractValidationRuleCandidates(all, focusRows) {
  const rows = focusRows.filter(r => /(必須|未入力|入力|チェック|上限|下限|日付|先日付|未来日|過去日|同日|翌営業日|営業日|NISA|非課税|口座|フラグ|状態|桁|文字|半角|全角|範囲|不可|可能|エラー)/.test(r.text));
  const out = [];
  for (const r of rows) {
    const ctx = contextForRow(all, r, 1);
    out.push({ rule: shorten(ctx || r.text, 220), field: extractFieldName(ctx || r.text), boundaryValues: extractBoundaryValues(ctx || r.text), expected: extractLikelyMessage(ctx || r.text) || '仕様通りにチェックされること', source: rowSource(r) });
  }
  return dedupeBy(out, x => `${x.field}::${x.rule}`);
}

function extractFieldName(text) {
  const s = cleanText(text);
  const patterns = [
    /([\w一-龠ぁ-んァ-ヶー（）()・／/\-]{2,40}(?:日|日付|区分|番号|コード|金額|数量|フラグ|状態|口座|項目|ID|パスワード))/,
    /([\w一-龠ぁ-んァ-ヶー（）()・／/\-]{2,40})[:：]/
  ];
  for (const p of patterns) { const m = s.match(p); if (m) return cleanText(m[1]); }
  return '要確認';
}

function extractBoundaryValues(text) {
  const hits = String(text).match(/(\d{4}[\/\-年]\d{1,2}[\/\-月]\d{1,2}日?|\d+[,.]?\d*円|\d+桁|\d+文字|0円|未入力|空白|同日|翌営業日|先日付|未来日|過去日|上限|下限|ON|OFF|0|1)/g) || [];
  return [...new Set(hits)].slice(0, 12);
}

function extractInputFieldCandidates(all, focusRows) {
  const out = [];
  for (const r of focusRows) {
    const ctx = contextForRow(all, r, 1);
    const names = ctx.match(/[\w一-龠ぁ-んァ-ヶー（）()・／/\-]{2,35}(?:日|日付|区分|番号|コード|金額|数量|フラグ|状態|口座|ID|パスワード|項目)/g) || [];
    names.forEach(name => out.push({ name: cleanText(name), values: extractBoundaryValues(ctx), source: rowSource(r) }));
  }
  return dedupeBy(out, x => `${x.name}::${x.source}`);
}

function dedupeBy(arr, keyFn) {
  const seen = new Set();
  return arr.filter(x => { const k = keyFn(x); if (seen.has(k)) return false; seen.add(k); return true; });
}

function buildSmartAnalysisPrompt(keyword, notes, docText, knowledge, sampleText, testType = 'integration') {
  const profile = TEST_TYPE_PROFILES[testType] || TEST_TYPE_PROFILES.integration;
  docText = String(docText || '').slice(0, COPILOT_MAX_DOC_CHARS);
  sampleText = String(sampleText || '').slice(0, COPILOT_MAX_SAMPLE_CHARS);
  const knowledgeText = JSON.stringify(knowledge, null, 2).slice(0, COPILOT_MAX_KNOWLEDGE_CHARS);
  return `あなたは日本の金融系システム(SONAR/投信注文)の上級QAアナリストです。
DAT Copilot Bridge Smart QA Engineとして、アップロード資料とAdditional Notesを分析し、テストケース生成のための中間分析結果をJSONで作成してください。

【テストケース種別】
${profile.label}
${profile.analysisHint}

【最重要ルール】
- Additional Notesを最優先してください。ただしNotesに書かれた観点だけに限定せず、資料から関連する観点を漏れなく抽出してください。
- 「プログラムが抽出した候補」内の documentClassification は各アップロード資料の種別（基本設計書／詳細設計書／DB定義書／画面設計書／エラーメッセージ一覧など）です。種別に応じて根拠の重み付けをしてください（例：DB定義書はdbOrInterfaceChecksの根拠として優先、画面設計書はscreenTransitionsの根拠として優先、エラーメッセージ一覧はerrorMessagesの根拠として優先）。
- Error Message Extraction、Screen Transition Analysis、Validation Analysisを必ず実施してください。
- エラーコード/メッセージ、画面遷移、入力チェック、日付条件、NISA条件、口座状態、DB/IF、権限、状態遷移を分けて整理してください。
- 推測で作らないでください。資料から不明なものは「要確認」としてください。
- 出力はJSONオブジェクトのみ。Markdown禁止。

【対象機能】
${keyword}

【Additional Notes】
${notes || '指定なし'}

【プログラムが抽出した候補】
${knowledgeText}

【過去に生成されたテストケース例（あれば粒度の参考。内容を盲信しない）】
${sampleText || 'なし'}

【資料抜粋】
${docText || 'なし'}

【返却JSON形式】
{
  "targetFunction": "...",
  "focusFromNotes": ["..."],
  "businessRules": [{"rule":"...", "source":"..."}],
  "errorMessages": [{"code":"...", "message":"...", "condition":"...", "source":"..."}],
  "screenTransitions": [{"from":"...", "to":"...", "operation":"...", "source":"..."}],
  "validationRules": [{"field":"...", "condition":"...", "validValues":["..."], "invalidValues":["..."], "expected":"...", "source":"..."}],
  "inputFields": [{"name":"...", "values":["..."], "source":"..."}],
  "dbOrInterfaceChecks": [{"rule":"...", "source":"..."}],
  "candidateCategories": ["..."],
  "scenarioOutline": ["..."],
  "openQuestions": ["..."]
}`;
}

function buildSmartTestCasePrompt(keyword, notes, docText, knowledge, analysis, sampleText, testType = 'integration') {
  const profile = TEST_TYPE_PROFILES[testType] || TEST_TYPE_PROFILES.integration;
  docText = String(docText || '').slice(0, COPILOT_MAX_DOC_CHARS);
  sampleText = String(sampleText || '').slice(0, COPILOT_MAX_SAMPLE_CHARS);
  const analysisText = JSON.stringify(analysis || {}, null, 2).slice(0, COPILOT_MAX_ANALYSIS_CHARS);
  const knowledgeText = JSON.stringify(knowledge || {}, null, 2).slice(0, COPILOT_MAX_KNOWLEDGE_CHARS);
  return `あなたは日本の金融系システム(SONAR/投信注文)のテスト設計者です。
DAT Copilot Bridge Smart QA Engineとして、資料分析結果をもとにDAT向けの詳細な${profile.label}ケースを作成してください。

【テストケース種別】
${profile.label}
${profile.caseHint}

【対象機能】
${keyword}

【Additional Notes（最優先）】
${notes || '指定なし'}

【中間分析結果】
${analysisText}

【プログラム抽出候補】
${knowledgeText}

【過去生成サンプル（出力粒度の参考。完全コピー禁止）】
${sampleText || 'なし'}

【資料抜粋】
${docText || 'なし'}

【生成方針】
- Additional Notesで指定された内容を必ず中心にしてください。
- ただし、エラーコード/エラーメッセージだけに限定しないでください。関連する screen transition、input validation、date boundary、NISA condition、account status、DB/IF、authority、normal/abnormal cases も、資料に根拠があるものはすべて含めてください。
- Error Message Extractionの結果がある場合、expectedResultにエラーコード・メッセージ・受付可否・遷移可否を具体的に入れてください。
- Screen Transition Analysisの結果がある場合、stepsにログイン → メニュー選択 → 対象画面 → 入力 → 確認/登録 → 結果確認までを具体化してください。
- Validation Analysisの結果がある場合、正常値/異常値/境界値（同日、翌営業日、先日付、未入力、上限超過など）ごとにケース化してください。
- Categoryは固定リストから選ばず、内容に合わせて動的に作成してください。例：NISA申込日チェック、先日付注文チェック、簡易開設申込状態チェック、画面遷移、入力値検証、DB更新確認。
- 件数は固定しないでください。必要十分な件数のみ生成してください。20件未満でも20件以上でも構いません。水増し禁止。
- Genericな「画面遷移」「DB更新」「入力チェック」だけのケースは禁止です。対象機能・条件・項目名が分かる具体的なテスト項目にしてください。
- inputDataは必ず具体的な「項目名 = 値」の形式で書いてください。JSONオブジェクト、[object Object]、Valid Data、Sample Dataは禁止です。
- 値を資料から導ける場合は実際の値/例を作ってください。例：非課税口座簡易開設申込日 = 2026/07/10、注文日 = 2026/07/10、NISAフラグ = 0。
- 値が判断できない場合は「項目名 = 要確認」としてください。
- expectedResultは「どの画面で何が起きるか」「どのエラー/文言が出るか」「DB/状態がどうなるか」を具体的に書いてください。
- 資料にないエラー文言は作らず「該当メッセージは要確認」としてください。
- 資料から判断できない点は推測せず、precondition/inputData/expectedResult内に「要確認」と記載してください。

【出力形式】
必ずJSON配列のみを返してください。Markdownや説明文は禁止です。
各要素は以下のキーのみを持つこと：
no, category, testItem, precondition, steps, inputData, expectedResult, priority

【inputDataの良い例】
非課税口座簡易開設申込日 = 2026/07/10\n注文日 = 2026/07/10\nNISAフラグ = 0\nファンドコード = 要確認\n積立金額 = 10,000円

【expectedResultの良い例】
確認ボタン押下後、NISA注文チェックによりエラー14840が表示され、注文受付不可となること。次画面へ遷移しないこと。
`;
}

// Backward-compatible alias.
function buildPrompt(keyword, notes, docText) {
  const knowledge = extractDeterministicKnowledge([], keyword, notes);
  return buildSmartTestCasePrompt(keyword, notes, docText, knowledge, null, '', 'integration');
}

// --- Copilot Bridge client --------------------------------------------------
// Calls the local "DAT Copilot Bridge" VS Code extension instead of OpenAI.
// The bridge exposes POST /generate accepting { system, prompt, modelFamily }
// and returns { ok, text } where `text` is the raw model completion text
// (same contract the OpenAI code used to get from choices[0].message.content).
// See /copilot-bridge/extension.js for the server implementation.
async function callCopilotBridge(system, prompt) {
  // Final safety net: whatever the individual piece-level caps above add up
  // to, never send more than this many characters to Copilot. Truncating
  // from the end preserves the instructions/rules block (which comes first
  // in both prompt builders) at the cost of the least-recently-added context
  // (doc excerpt), which is the safest place to lose detail.
  if (prompt.length > COPILOT_MAX_TOTAL_PROMPT_CHARS) {
    prompt = prompt.slice(0, COPILOT_MAX_TOTAL_PROMPT_CHARS) + '\n...(文字数上限のため以降省略)';
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COPILOT_TIMEOUT_MS);
  try {
    let resp;
    try {
      resp = await fetch(COPILOT_BRIDGE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ system, prompt, modelFamily: COPILOT_MODEL_FAMILY || undefined }),
        signal: controller.signal
      });
    } catch (networkErr) {
      throw new Error(`DAT Copilot Bridge拡張機能に接続できません（${COPILOT_BRIDGE_URL}）。VS Codeを開き、拡張機能が起動していることを確認してください。詳細: ${networkErr.message}`);
    }

    const bodyText = await resp.text();
    if (!resp.ok) {
      throw new Error(`Copilot Bridge HTTP ${resp.status}: ${bodyText.slice(0, 500)}`);
    }
    let data;
    try { data = JSON.parse(bodyText); } catch (_) { throw new Error('Copilot Bridge did not return valid JSON.'); }
    if (!data.ok) throw new Error(data.message || 'Copilot Bridge returned an error.');
    return data.text || '';
  } finally {
    clearTimeout(timer);
  }
}

async function generateByCopilot(prompt) {
  const text = await callCopilotBridge(
    'You are a Japanese financial-system QA test designer. Return only a valid JSON array. Do not use markdown.',
    prompt
  );
  return JSON.parse(extractJson(text));
}

function extractJsonObject(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('AI response is not JSON object.');
  return text.slice(start, end + 1);
}

async function generateByCopilotObject(prompt) {
  const text = await callCopilotBridge(
    'You are a Japanese financial-system QA analyst. Return only a valid JSON object. Do not use markdown.',
    prompt
  );
  return JSON.parse(extractJsonObject(text));
}

function extractJson(text) {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) throw new Error('AI response is not JSON array.');
  return text.slice(start, end + 1);
}

function buildDocumentBasedCases(keyword, notes, matches, allRows) {
  const rows = (matches && matches.length ? matches : allRows || []).map(r => r.text).filter(Boolean);
  const buttonRows = pickRows(rows, /(ボタン|リンク|メニュー|画面へ|遷移)/, 5);
  const checkRows = pickRows(rows, /(チェック|必須|未入力|上限|下限|エラー|入力)/, 6);
  const dbRows = pickRows(rows, /(DB|テーブル|登録|更新|削除|レコード)/, 3);
  const normalRows = pickRows(rows, /(正常|表示|確認|完了)/, 4);

  const cases = [];
  const add = (category, item, precondition, steps, inputData, expectedResult, priority='High') => {
    cases.push({
      no: `TC${String(cases.length + 1).padStart(3, '0')}`,
      category, testItem: item, precondition, steps, inputData, expectedResult, priority
    });
  };

  add('画面遷移', `${keyword}画面を表示する`, 'ログイン済み', `1. メニューを選択\n2. ${keyword}メニューまたは対象リンクをクリック`, '-', `${keyword}画面が正常に表示されること`, 'High');

  buttonRows.forEach(r => {
    const label = extractActionLabel(r) || '対象ボタン/リンク';
    add('画面遷移', `${label}押下時の遷移確認`, `${keyword}画面を表示`, `1. ${keyword}画面を表示\n2. 「${label}」をクリック`, '-', summarizeExpected(r, `${label}押下後、仕様通りの画面へ遷移すること`), 'High');
  });

  checkRows.forEach(r => {
    const item = shorten(r, 38);
    add('入力チェック', item, `${keyword}画面を表示`, `1. 該当項目に条件に合わない値を入力\n2. 登録/確認ボタンをクリック`, extractInputData(r), summarizeExpected(r, '仕様に従ったエラーメッセージが表示されること'), 'High');
  });

  normalRows.forEach(r => {
    add('正常系', shorten(r, 38), `${keyword}画面を表示`, `1. 各項目を正常に入力\n2. 確認/登録ボタンをクリック`, extractInputData(r), summarizeExpected(r, '正常に処理されること'), 'High');
  });

  dbRows.forEach(r => {
    add('DBチェック', shorten(r, 38), '登録/更新処理後', '1. 対象処理を実行する\n2. DBまたは出力結果を確認する', extractInputData(r), summarizeExpected(r, 'DBの対象テーブルに正しく反映されること'), 'High');
  });

  // Only add generic templates when the uploaded documents did not produce enough evidence-based cases.
  // These are not used to force a fixed count; they only prevent an empty/too-small fallback result.
  const templates = [
    ['入力チェック', '必須項目未入力チェック', `${keyword}画面を表示`, '1. 必須項目を空白にする\n2. 登録/確認ボタンをクリック', '必須項目: 空白', '必須項目の未入力エラーが表示されること', 'High'],
    ['入力チェック', '入力値の上限チェック', `${keyword}画面を表示`, '1. 上限を超える値を入力\n2. 登録/確認ボタンをクリック', '金額/数量: 上限超過', '上限超過エラーが表示されること', 'High'],
    ['異常系', 'キャンセル/戻るボタン確認', `${keyword}画面を表示`, '1. 任意項目を入力\n2. キャンセル/戻るボタンをクリック', '-', '前画面へ戻る、または入力内容が仕様通り保持/破棄されること', 'Medium'],
    ['異常系', 'セッションタイムアウト確認', `${keyword}画面を表示`, '1. 一定時間操作しない\n2. 画面操作を実施する', '-', 'セッションタイムアウトメッセージが表示され、ログイン画面へ遷移すること', 'Medium'],
    ['正常系', '確認画面で登録処理を行う', '確認画面を表示', '1. 確認画面の内容を確認\n2. 登録ボタンをクリック', '-', '登録が正常に完了し、完了画面が表示されること', 'High']
  ];
  if (cases.length < 3) {
    for (const t of templates) {
      if (cases.length >= 5) break;
      add(...t);
    }
  }
  // Do not force a fixed number of cases. Return all evidence-based cases generated from the uploaded documents.
  return dedupeCases(cases).slice(0, 120);
}

function pickRows(rows, regex, max) {
  return rows.filter(r => regex.test(r)).slice(0, max);
}
function shorten(s, n) { s = cleanText(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function extractActionLabel(s) {
  const m = String(s).match(/[「\[]?([^「」\[\]|]{1,20}?(?:ボタン|リンク|メニュー|アンカー))[」\]]?/);
  return m ? cleanText(m[1]) : '';
}
function extractInputData(s) {
  const hits = String(s).match(/(金額[:：]?[\d,]+|数量[:：]?[\d,]+|ID|パスワード|必須項目|空白|上限|下限|0円|未入力)/g);
  return hits ? [...new Set(hits)].join('\n') : '-';
}
function summarizeExpected(source, fallback) {
  const s = cleanText(source);
  if (!s) return fallback;
  if (/(表示される|遷移する|登録される|更新される|エラー|メッセージ|確認する|出力する)/.test(s)) {
    return `${shorten(s, 70)} こと`;
  }
  return fallback;
}
function dedupeCases(cases) {
  const seen = new Set();
  return cases.filter(c => {
    const k = c.category + c.testItem;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).map((c, i) => ({ ...c, no: `TC${String(i + 1).padStart(3, '0')}` }));
}

// ③ Duplicate removal for AI-generated results shown in the Preview.
// Keys on normalized testItem+expectedResult (not raw inputData/steps, which
// legitimately vary case-to-case) so near-identical cases the model may
// restate with slightly different wording are still treated as duplicates.
function dedupeGeneratedCases(cases) {
  const seen = new Set();
  return cases.filter(c => {
    const key = normalizeForMatch(`${c.testItem}::${c.expectedResult}`);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((c, i) => ({ ...c, no: `TC${String(i + 1).padStart(3, '0')}` }));
}

function normalizeCases(items, keyword) {
  const arr = Array.isArray(items) ? items : [];
  return arr.slice(0, Number(process.env.MAX_TEST_CASES || 120)).map((x, i) => ({
    no: safeText(x.no) || `TC${String(i + 1).padStart(3, '0')}`,
    category: safeText(x.category) || inferCategory(x, keyword),
    testItem: safeText(x.testItem) || `${keyword}の確認`,
    precondition: safeText(x.precondition) || `${keyword}画面を表示`,
    steps: safeText(x.steps) || '1. 対象画面を表示\n2. 操作を実施する',
    inputData: safeText(x.inputData) || '-',
    expectedResult: safeText(x.expectedResult) || `${keyword}が正しく処理されること`,
    priority: safeText(x.priority) || 'High'
  }));
}

function safeText(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(safeText).filter(Boolean).join('\n');
  if (typeof v === 'object') return Object.entries(v).map(([k,val]) => `${k}: ${safeText(val)}`).join('\n');
  return String(v).replace(/\[object Object\]/g, '').trim();
}

function inferCategory(x, keyword) {
  const t = `${safeText(x.testItem)} ${safeText(x.steps)} ${safeText(x.expectedResult)} ${keyword}`;
  if (/NISA|非課税/.test(t)) return 'NISA注文チェック';
  if (/日付|先日付|未来日/.test(t)) return '日付チェック';
  if (/エラー|メッセージ/.test(t)) return 'エラー表示';
  if (/DB|テーブル/.test(t)) return 'DBチェック';
  if (/遷移|画面/.test(t)) return '画面遷移';
  return '正常系';
}

// --- V3.2: Coverage Engine -------------------------------------------------
// Compares extracted knowledge candidates against generated test cases using
// character bigram overlap — tolerates paraphrasing and particle changes.
//
// V3.2 improvements vs V2.2:
//  - keyword/notes terms are now included as first-class candidates so
//    user-specified topics always contribute to the coverage score.
//  - Anchor threshold for medium-length field/screen names lowered from 0.7
//    to 0.45 — 0.7 was too strict for 6-16 char Japanese field names that
//    the AI naturally restates with minor variation.
//  - Single-pass anchor+full combined check: if full-text overlap >= 0.30
//    alone, the candidate counts as covered even without a strict anchor hit,
//    because a 30% bigram overlap on a domain-specific sentence already
//    implies strong topical relevance.
function normalizeForMatch(s) {
  return cleanText(s).toLowerCase().replace(/[「」『』\s、。，,\.→]/g, '');
}

function caseHaystack(c) {
  return normalizeForMatch(`${c.category} ${c.testItem} ${c.precondition} ${c.steps} ${c.inputData} ${c.expectedResult}`);
}

function shingles(text, n = 2) {
  const s = normalizeForMatch(text);
  const grams = new Set();
  for (let i = 0; i <= s.length - n; i++) grams.add(s.slice(i, i + n));
  // Error codes as whole tokens
  const codes = s.match(/\d{3,5}|e\d{3,}/g) || [];
  codes.forEach(c => grams.add(c));
  return grams;
}

function overlapRatio(candidateText, haystackText) {
  const candidateGrams = shingles(candidateText, 2);
  if (!candidateGrams.size) return 0;
  const haystackGrams = shingles(haystackText, 2);
  let overlap = 0;
  candidateGrams.forEach(g => { if (haystackGrams.has(g)) overlap++; });
  return overlap / candidateGrams.size;
}

function isCandidateCovered(anchorText, fullText, caseHaystacks) {
  const anchor = normalizeForMatch(anchorText);
  const full = normalizeForMatch(fullText || anchorText);
  if (!anchor || anchor === '要確認') return false;

  return caseHaystacks.some(h => {
    // Fast path: full-text bigram overlap alone is sufficient at 0.30
    // (domain sentences share enough distinctive bigrams to avoid false positives)
    const fullOvr = overlapRatio(full, h);
    if (fullOvr >= 0.30) return true;

    // Anchor gate: require the identifying label to appear before counting overlap
    let anchorMatches;
    if (anchor.length <= 4) {
      anchorMatches = h.includes(anchor);           // exact for codes / very short names
    } else if (anchor.length <= 16) {
      anchorMatches = overlapRatio(anchor, h) >= 0.45; // field/screen names (lowered from 0.7)
    } else {
      anchorMatches = overlapRatio(anchor, h) >= 0.22; // long anchor = itself a sentence
    }
    if (!anchorMatches) return false;
    if (full === anchor) return true;               // anchor-only candidate
    return fullOvr >= 0.20;                         // lenient once anchor is confirmed
  });
}

// Label helpers — each returns { anchor, full, display }
function errorMessageLabel(x) {
  const hasCode = x.code && x.code !== '要確認';
  const hasMessage = x.message && x.message !== '要確認';
  const anchor = hasCode ? x.code : (hasMessage ? x.message : '');
  const full = hasMessage ? `${hasCode ? x.code + ' ' : ''}${x.message}` : anchor;
  return { anchor, full, display: full || anchor || '要確認' };
}
function screenTransitionLabel(x) {
  const anchor = x.flow && x.flow !== '要確認' ? x.flow : (x.operation || '');
  const full = `${anchor} ${x.operation && x.operation !== '要確認' ? x.operation : ''}`.trim();
  return { anchor, full: full || anchor, display: full || anchor || '要確認' };
}
function validationRuleLabel(x) {
  const anchor = x.field && x.field !== '要確認' ? x.field : (x.rule ? x.rule.slice(0, 20) : '');
  const full = x.rule || anchor;
  return { anchor, full: full || anchor, display: full || anchor || '要確認' };
}
function dbCheckLabel(x) {
  const full = x.rule || '';
  return { anchor: full, full, display: full || '要確認' };
}

// V3.2: build keyword/notes candidates so user-specified topics always show
// up in the coverage denominator.
function buildKeywordCandidates(keyword, notes) {
  const raw = `${keyword} ${notes || ''}`.trim();
  // Split on Japanese/ASCII delimiters and filter to meaningful chunks
  const terms = raw.split(/[、。，,\s\n]+/).map(s => s.trim()).filter(s => s.length >= 2);
  return [...new Set(terms)].map(term => ({ term }));
}

function buildCoverageReport(knowledge, cases, keyword, notes) {
  const caseHaystacks = (cases || []).map(caseHaystack);

  const evaluate = (items, labelFn) => {
    const list = items || [];
    const details = list.map(item => {
      const { anchor, full, display } = labelFn(item);
      return { item: display, covered: isCandidateCovered(anchor, full, caseHaystacks) };
    });
    const coveredCount = details.filter(d => d.covered).length;
    return {
      total: list.length,
      covered: coveredCount,
      coveragePercent: list.length ? Number(((coveredCount / list.length) * 100).toFixed(1)) : null,
      details
    };
  };

  const errorMessages = evaluate(knowledge.errorMessages, errorMessageLabel);
  const screenTransitions = evaluate(knowledge.screenTransitions, screenTransitionLabel);
  const validationRules = evaluate(knowledge.validationRules, validationRuleLabel);
  const dbOrInterfaceChecks = evaluate(knowledge.dbOrInterfaceChecks, dbCheckLabel);

  // Keyword/notes coverage: each term the user specified should appear in at least one test case
  const kwCandidates = buildKeywordCandidates(keyword || '', notes || '');
  const keywordTerms = {
    total: kwCandidates.length,
    covered: 0,
    coveragePercent: null,
    details: kwCandidates.map(({ term }) => {
      const covered = isCandidateCovered(term, term, caseHaystacks);
      return { item: term, covered };
    })
  };
  keywordTerms.covered = keywordTerms.details.filter(d => d.covered).length;
  keywordTerms.coveragePercent = keywordTerms.total
    ? Number(((keywordTerms.covered / keywordTerms.total) * 100).toFixed(1))
    : null;

  const sections = { keywordTerms, errorMessages, screenTransitions, validationRules, dbOrInterfaceChecks };
  const totalCandidates = Object.values(sections).reduce((sum, s) => sum + s.total, 0);
  const totalCovered = Object.values(sections).reduce((sum, s) => sum + s.covered, 0);
  const overallCoveragePercent = totalCandidates
    ? Number(((totalCovered / totalCandidates) * 100).toFixed(1))
    : null;

  return { generatedCaseCount: (cases || []).length, overallCoveragePercent, totalCandidates, totalCovered, sections };
}

function coverageLogLines(coverage) {
  const pct = v => (v == null ? 'N/A' : `${v}%`);
  const lines = [
    `Coverage Engine: ${coverage.generatedCaseCount} test case(s) generated.`,
    `Coverage Engine: Overall coverage ${pct(coverage.overallCoveragePercent)} (${coverage.totalCovered}/${coverage.totalCandidates} candidate(s)).`
  ];
  const labelMap = {
    keywordTerms: 'Keyword/Notes Terms',
    errorMessages: 'Error Messages',
    screenTransitions: 'Screen Transitions',
    validationRules: 'Validation Rules',
    dbOrInterfaceChecks: 'DB/IF Checks'
  };
  Object.entries(coverage.sections).forEach(([key, s]) => {
    lines.push(`Coverage Engine: ${labelMap[key] || key} ${pct(s.coveragePercent)} (${s.covered}/${s.total})`);
  });
  return lines;
}
// ---------------------------------------------------------------------------

async function writeExcel(cases, meta, coverage) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Generated Test Cases');
  ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
  const metaRows = [
    ['機能名', meta.keyword || ''],
    ['テストケース種別', meta.testTypeLabel || ''],
    ['作成日', meta.date || new Date().toISOString().slice(0,10)],
    ['作成者', meta.author || 'AI Test Case Generator (Phase 1)'],
    ['備考', meta.notes || '入力チェック、画面遷移、DB更新、異常系も含めて']
  ];
  ws.addRows(metaRows);
  ws.addRow([]);
  const header = ['No', 'Category', 'Test Item', 'Precondition', 'Steps', 'Input Data', 'Expected Result', 'Priority'];
  ws.addRow(header);
  cases.forEach(c => ws.addRow([c.no, c.category, c.testItem, c.precondition, c.steps, c.inputData, c.expectedResult, c.priority]));
  ws.columns = [
    { width: 10 }, { width: 16 }, { width: 32 }, { width: 26 }, { width: 48 }, { width: 24 }, { width: 52 }, { width: 12 }
  ];
  ws.eachRow((row, rowNumber) => {
    row.eachCell((cell) => {
      cell.alignment = { vertical: 'middle', wrapText: true };
      cell.border = { top:{style:'thin'}, left:{style:'thin'}, bottom:{style:'thin'}, right:{style:'thin'} };
    });
    if (rowNumber === 7) {
      row.font = { bold: true };
      row.height = 24;
      const fills = ['D9EAD3','D9EAD3','D9EAD3','D9EAD3','FFF2CC','CFE2F3','FCE5CD','EADCF8'];
      row.eachCell((cell, idx) => cell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb: fills[idx-1] || 'D9EAD3' } });
    } else if (rowNumber <= 5) {
      row.getCell(1).font = { bold: true };
      row.getCell(1).fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'F3F4F6' } };
    }
  });

  // V2.2: Coverage Engine — write a second sheet summarizing how much of the
  // extracted knowledge (error messages / screen transitions / validation
  // rules / DB-IF checks) is actually referenced by the generated cases.
  if (coverage) {
    const cs = wb.addWorksheet('Coverage Report');
    cs.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
    cs.addRow(['Coverage Engine - Summary']);
    cs.addRow(['Generated Test Cases', coverage.generatedCaseCount]);
    cs.addRow(['Overall Coverage', coverage.overallCoveragePercent == null ? 'N/A' : `${coverage.overallCoveragePercent}%`]);
    cs.addRow(['Total Candidates', coverage.totalCandidates]);
    cs.addRow(['Total Covered', coverage.totalCovered]);
    cs.addRow([]);

    const labelMap = {
      errorMessages: 'Error Messages',
      screenTransitions: 'Screen Transitions',
      validationRules: 'Validation Rules',
      dbOrInterfaceChecks: 'DB/IF Checks'
    };
    const sectionHeaderRowNumbers = [];
    Object.entries(coverage.sections).forEach(([key, s]) => {
      const headerRow = cs.addRow([labelMap[key] || key, `${s.covered}/${s.total} (${s.coveragePercent == null ? 'N/A' : s.coveragePercent + '%'})`]);
      sectionHeaderRowNumbers.push(headerRow.number);
      cs.addRow(['Item', 'Covered?']);
      s.details.forEach(d => cs.addRow([d.item, d.covered ? '✓' : '✗']));
      cs.addRow([]);
    });

    cs.columns = [{ width: 70 }, { width: 20 }];
    cs.eachRow((row, rowNumber) => {
      row.eachCell((cell) => {
        cell.alignment = { vertical: 'middle', wrapText: true };
      });
      if (rowNumber === 1) row.font = { bold: true, size: 13 };
      if (sectionHeaderRowNumbers.includes(rowNumber)) {
        row.font = { bold: true };
        row.eachCell((cell) => cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'D9EAD3' } });
      }
    });
  }

  const fileName = `testcases_${Date.now()}.xlsx`;
  const abs = path.join(GENERATED_DIR, fileName);
  await wb.xlsx.writeFile(abs);
  return `/generated/${fileName}`;
}

const server = app.listen(PORT, () => console.log(`DAT AI Test Case Generator running: http://localhost:${PORT}`));

// --- V2.2: Browser Close Cleanup -------------------------------------------
// start_DAT_AI_Tool.bat launches this server and opens it in the default
// browser. When the user closes the browser/terminal window (Ctrl+C on the
// .bat, or the OS sending SIGTERM/SIGINT), make sure we shut down cleanly:
// stop accepting new connections, clear in-memory state (uploadedFiles,
// latestCases, latestCoverage and the Knowledge Base Cache) so nothing
// lingers if the process is ever kept alive by a supervisor/relaunch, and
// only then exit. This avoids orphaned listeners and makes restart-on-close
// behavior predictable.
let shuttingDown = false;
async function cleanupAndExit(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[Browser Close Cleanup] Received ${signal}. Shutting down DAT AI Test Case Generator...`);

  const clearedCacheEntries = clearKnowledgeBaseCache();
  uploadedFiles = [];
  latestCases = [];
  latestSavedCases = [];
  latestMeta = {};
  latestCoverage = null;
  console.log(`[Browser Close Cleanup] Knowledge Base Cache cleared (${clearedCacheEntries} entr${clearedCacheEntries === 1 ? 'y' : 'ies'}). In-memory state reset.`);

  // Fast-path: tell the DAT Copilot Bridge extension to quit VS Code right
  // away instead of waiting for its watchdog to notice this server is gone.
  // Best-effort only — if the bridge isn't running, this just resolves/fails
  // silently and the bridge's own watchdog is the fallback.
  await notifyCopilotBridgeShutdown();

  server.close(() => {
    console.log('[Browser Close Cleanup] HTTP server closed. Goodbye.');
    process.exit(0);
  });

  // Safety net: force-exit if something keeps the event loop alive.
  setTimeout(() => process.exit(0), 3000).unref();
}

async function notifyCopilotBridgeShutdown() {
  try {
    const shutdownUrl = COPILOT_BRIDGE_URL.replace(/\/generate\/?$/, '/shutdown');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    await fetch(shutdownUrl, { method: 'POST', signal: controller.signal }).catch(() => {});
    clearTimeout(timer);
  } catch (_) { /* ignore — bridge not running */ }
}

['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, () => cleanupAndExit(sig)));
process.on('exit', () => { /* no-op: real cleanup already done in cleanupAndExit */ });
// ---------------------------------------------------------------------------
