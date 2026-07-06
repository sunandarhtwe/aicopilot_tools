const documentsInput = document.getElementById('documents');
const fileList = document.getElementById('fileList');
const generateBtn = document.getElementById('generateBtn');
const keyword = document.getElementById('keyword');
const notes = document.getElementById('notes');
const count = document.getElementById('count');
const caseBody = document.getElementById('caseBody');
const downloadBtn = document.getElementById('downloadBtn');
const message = document.getElementById('message');
const log = document.getElementById('log');
const jaBtn = document.getElementById('jaBtn');
const enBtn = document.getElementById('enBtn');
const coveragePanel = document.getElementById('coveragePanel');
const coverageCards = document.getElementById('coverageCards');
const testTypeGroup = document.getElementById('testTypeGroup');
const dirtyBadge = document.getElementById('dirtyBadge');
const saveEditBtn = document.getElementById('saveEditBtn');
const cancelEditBtn = document.getElementById('cancelEditBtn');

// Columns in table order — used both to render <td> cells and to read them
// back when collecting edits for Save. Keeping this as a single source of
// truth avoids column-order bugs between render and collect.
const CASE_FIELDS = ['no', 'category', 'testItem', 'precondition', 'steps', 'inputData', 'expectedResult', 'priority'];

const I18N = {
  ja: {
    appTitle: 'AI テストケース ジェネレーター', navGenerate: 'テストケース生成',
    uploadTitle: '設計書をアップロード', dropStrong: 'ここにファイルをドラッグ＆ドロップ', dropEm: 'またはクリックして選択', dropSmall: 'PDF / Word / Excel / Text',
    step1: 'ドキュメントアップロード', step2: 'キーワード入力', step3: '生成', keywordLabel: '対象機能／キーワード', notesLabel: '追加観点（任意）', generateBtn: '✣ テストケースを生成', generating: '生成中...',
    testTypeLabel: 'テストケース種別', testTypeIntegration: '結合テスト (Integration)', testTypeUnit: '単体テスト (Unit)', testTypeComprehensive: '総合テスト (Comprehensive)',
    previewTitle: '生成済みテストケース プレビュー', downloadBtn: '⬇ Excel ダウンロード', placeholder: 'ドキュメントをアップロードして「テストケースを生成」をクリックしてください。', logTitle: 'ログ', coverageTitle: 'カバレッジ（資料抽出候補との一致率）',
    executeTitle: '実行結果（Phase 2 予定）', executedSuites: '実行済みテストスイート', successRate: '成功率', playwrightPlan: 'Playwright 実行機能を追加予定',
    uploaded: n => `${n}件のドキュメントをアップロードしました。`, generatingLog: 'テストケースを生成中...', generationCompleted: n => `Generation Completed\n${n}件のテストケースを生成しました。内容を確認の上、Excelとしてダウンロードしてください。`,
    metaFunction: '機能名', metaDate: '作成日', metaAuthor: '作成者', metaNote: '備考', metaTestType: 'テストケース種別', author: 'DAT-SONAR-FR', thNo: 'No', thCat: 'カテゴリ', thItem: 'テスト項目', thPre: '前提条件', thSteps: '操作手順', thInput: '入力データ', thExpected: '期待結果', thPriority: '優先度',
    unsavedBadge: '未保存の変更', saveBtn: '💾 保存', cancelBtn: 'キャンセル', saving: '保存中...', savedMsg: '変更を保存しました。', saveFailed: '保存に失敗しました', mustSaveFirst: '編集内容を保存してからダウンロードしてください。'
  },
  en: {
    appTitle: 'AI Test Case Generator', navGenerate: 'Generate Test Cases',
    uploadTitle: 'Upload Design Documents', dropStrong: 'Drag & drop files here', dropEm: 'or click to select', dropSmall: 'PDF / Word / Excel / Text',
    step1: 'Upload Documents', step2: 'Input Keyword', step3: 'Generate', keywordLabel: 'Target Function / Keyword', notesLabel: 'Additional Notes (Optional)', generateBtn: '✣ Generate Test Cases', generating: 'Generating...',
    testTypeLabel: 'Test Case Type', testTypeIntegration: 'Integration Test', testTypeUnit: 'Unit Test', testTypeComprehensive: 'Comprehensive Test',
    previewTitle: 'Generated Test Case Preview', downloadBtn: '⬇ Download Excel', placeholder: 'Upload documents and click Generate Test Cases.', logTitle: 'Log', coverageTitle: 'Coverage (match rate vs. extracted candidates)',
    executeTitle: 'Execution Result (Phase 2 Plan)', executedSuites: 'Executed Test Suites', successRate: 'Success Rate', playwrightPlan: 'Playwright execution feature will be added',
    uploaded: n => `Uploaded ${n} document(s).`, generatingLog: 'Generating test cases...', generationCompleted: n => `Generation Completed\n${n} test cases were generated. Please review the content and download it as Excel.`,
    metaFunction: 'Function Name', metaDate: 'Created Date', metaAuthor: 'Author', metaNote: 'Notes', metaTestType: 'Test Case Type', author: 'DAT-SONAR-FR', thNo: 'No', thCat: 'Category', thItem: 'Test Item', thPre: 'Precondition', thSteps: 'Steps', thInput: 'Input Data', thExpected: 'Expected Result', thPriority: 'Priority',
    unsavedBadge: 'Unsaved changes', saveBtn: '💾 Save', cancelBtn: 'Cancel', saving: 'Saving...', savedMsg: 'Changes saved.', saveFailed: 'Save failed', mustSaveFirst: 'Please save your edits before downloading.'
  }
};
let currentLang = localStorage.getItem('dat_ai_lang') || 'ja';

// `latestCases`/`latestMeta` reflect what's currently rendered in the table
// (including any not-yet-saved edits, kept in sync so language switching
// doesn't wipe them out). `savedCases` is the last confirmed baseline from
// either /api/generate or /api/update-cases — this is what Cancel reverts to.
let latestCases = [];
let latestMeta = {};
let savedCases = [];
let isDirty = false;

function t(key, ...args) { const v = I18N[currentLang][key]; return typeof v === 'function' ? v(...args) : (v || key); }
function applyLanguage(lang) {
  if (isDirty) latestCases = collectCasesFromTable(); // preserve unsaved edits across language toggle
  currentLang = lang; localStorage.setItem('dat_ai_lang', lang); document.documentElement.lang = lang;
  jaBtn.classList.toggle('active', lang === 'ja'); enBtn.classList.toggle('active', lang === 'en');
  document.querySelectorAll('[data-i18n]').forEach(el => { const v = t(el.dataset.i18n); if (typeof v === 'string') el.textContent = v; });
  if (!latestCases.length) caseBody.innerHTML = `<tr><td colspan="9" class="placeholder">${escapeHtml(t('placeholder'))}</td></tr>`; else renderCases(latestCases, latestMeta);
  if (!generateBtn.disabled) generateBtn.textContent = t('generateBtn');
  updateDirtyUi();
}
jaBtn.addEventListener('click', () => applyLanguage('ja'));
enBtn.addEventListener('click', () => applyLanguage('en'));

// only one view now; keep switchView minimal for upload redirect
function switchView(view) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const el = document.getElementById(`${view}View`);
  if (el) el.classList.add('active');
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.view === view));
}
document.querySelectorAll('.nav-item').forEach(btn => btn.addEventListener('click', () => switchView(btn.dataset.view)));

notes.addEventListener('input', () => count.textContent = notes.value.length); count.textContent = notes.value.length;

function selectedTestType() {
  const checked = testTypeGroup ? testTypeGroup.querySelector('input[name="testType"]:checked') : null;
  return checked ? checked.value : 'integration';
}

documentsInput.addEventListener('change', async () => {
  const files = [...documentsInput.files]; if (!files.length) return;
  renderFiles(files.map(f => ({ originalName: f.name, size: f.size, uploading: true })));
  const form = new FormData(); files.forEach(f => form.append('documents', f));
  const res = await fetch('/api/upload', { method: 'POST', body: form }); const data = await res.json();
  const uploadedFiles = data.files || [];
  renderFiles(uploadedFiles); setLog(t('uploaded', uploadedFiles.length || files.length));
});

// One click: upload + keyword/notes + test case type are already chosen by
// this point, so a single click of Generate runs the whole pipeline end to end.
generateBtn.addEventListener('click', async () => {
  // Clear preview table immediately when generate is clicked
  clearPreview();
  // Clear server-side cache and memory before generating
  try { await fetch('/api/clear', { method: 'POST' }); } catch (_) { }
  clearMessage(); setLoading(true); setLog(t('generatingLog'));
  try {
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword: keyword.value, notes: notes.value, testType: selectedTestType() })
    });
    const data = await res.json(); if (!res.ok || !data.ok) throw new Error(data.message || 'Generate failed');
    latestCases = data.cases || []; latestMeta = data.meta || {};
    savedCases = latestCases.map(c => ({ ...c })); // baseline for Save/Cancel
    renderCases(latestCases, latestMeta);
    setDirty(false);
    downloadBtn.href = data.excelUrl; downloadBtn.classList.remove('disabled');
    renderCoverage(data.coverage);
    showMessage('ok', t('generationCompleted', latestCases.length)); setLog([`Source: ${data.source}`, ...(data.log || [])].join('\n'));
  } catch (e) { showMessage('err', e.message || String(e)); setLog(e.stack || String(e)); }
  finally { setLoading(false); }
});

// Save: collect current (edited) table content and push it to the server.
// Only after this succeeds is the download link refreshed and re-enabled.
saveEditBtn.addEventListener('click', async () => {
  const cases = collectCasesFromTable();
  saveEditBtn.disabled = true; const originalLabel = saveEditBtn.textContent; saveEditBtn.textContent = t('saving');
  try {
    const res = await fetch('/api/update-cases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cases })
    });
    const data = await res.json(); if (!res.ok || !data.ok) throw new Error(data.message || 'Save failed');
    latestCases = data.cases; savedCases = data.cases.map(c => ({ ...c }));
    renderCases(latestCases, latestMeta);
    downloadBtn.href = data.excelUrl; downloadBtn.classList.remove('disabled');
    setDirty(false);
    showMessage('ok', t('savedMsg'));
  } catch (e) {
    showMessage('err', `${t('saveFailed')}: ${e.message || e}`);
  } finally {
    saveEditBtn.disabled = false; saveEditBtn.textContent = originalLabel;
  }
});

// Cancel: discard in-progress edits and restore the last saved snapshot
// (either the original generation result, or the last successful Save).
cancelEditBtn.addEventListener('click', () => {
  latestCases = savedCases.map(c => ({ ...c }));
  renderCases(latestCases, latestMeta);
  setDirty(false);
  clearMessage();
});

function clearPreview() {
  latestCases = []; latestMeta = {}; savedCases = [];
  caseBody.innerHTML = `<tr><td colspan="9" class="placeholder">${escapeHtml(t('placeholder'))}</td></tr>`;
  downloadBtn.href = '#'; downloadBtn.classList.add('disabled');
  if (coveragePanel) coveragePanel.classList.add('hidden');
  if (coverageCards) coverageCards.innerHTML = '';
  setDirty(false);
}

function renderCoverage(coverage) {
  if (!coverage || !coveragePanel || !coverageCards) { if (coveragePanel) coveragePanel.classList.add('hidden'); return; }
  const labelMap = { keywordTerms: 'Keyword/Notes', errorMessages: 'Error Messages', screenTransitions: 'Screen Transitions', validationRules: 'Validation Rules', dbOrInterfaceChecks: 'DB/IF Checks' };
  const pct = v => v == null ? 'N/A' : `${v}%`;
  const cards = [`<div><strong>${pct(coverage.overallCoveragePercent)}</strong><span>Overall (${coverage.totalCovered}/${coverage.totalCandidates})</span></div>`];
  Object.entries(coverage.sections || {}).forEach(([key, s]) => {
    cards.push(`<div><strong>${pct(s.coveragePercent)}</strong><span>${labelMap[key] || key} (${s.covered}/${s.total})</span></div>`);
  });
  coverageCards.innerHTML = cards.join('');
  coveragePanel.classList.remove('hidden');
}

function renderFiles(files) { fileList.innerHTML = files.map(f => `<div class="file-item"><div class="file-icon">${iconFor(f.originalName)}</div><div><div class="file-name">${escapeHtml(f.originalName)}</div><div class="file-size">${formatSize(f.size)}</div></div><div class="check">✓</div></div>`).join(''); }

// Editable table: data cells use contenteditable; header/meta rows stay read-only.
// Each editable <td> carries data-field so collectCasesFromTable() can read
// it back reliably regardless of column order.
function renderCases(cases, meta = {}) {
  let row = 1; const html = [];
  [[t('metaFunction'), meta.keyword || keyword.value],
   [t('metaTestType'), meta.testTypeLabel || t(`testType${capitalize(selectedTestType())}`)],
   [t('metaDate'), meta.date || new Date().toISOString().slice(0, 10)],
   [t('metaAuthor'), t('author')],
   [t('metaNote'), meta.notes || notes.value]]
    .forEach(([k, v]) => html.push(`<tr><td class="rownum">${row++}</td><td class="meta-key">${k}</td><td class="meta-val" colspan="7">${escapeHtml(v)}</td></tr>`));
  html.push(`<tr><td class="rownum">${row++}</td><td colspan="8"></td></tr>`);
  html.push(`<tr><td class="rownum">${row++}</td><th class="h-no">${t('thNo')}</th><th class="h-cat">${t('thCat')}</th><th class="h-item">${t('thItem')}</th><th class="h-pre">${t('thPre')}</th><th class="h-steps">${t('thSteps')}</th><th class="h-input">${t('thInput')}</th><th class="h-expected">${t('thExpected')}</th><th class="h-priority">${t('thPriority')}</th></tr>`);
  cases.forEach((c, idx) => html.push(
    `<tr data-case-row="${idx}">` +
    `<td class="rownum">${row++}</td>` +
    CASE_FIELDS.map(f => `<td class="editable" data-field="${f}" contenteditable="true">${escapeHtml(c[f])}</td>`).join('') +
    `</tr>`
  ));
  caseBody.innerHTML = html.join('');
}

// Reads the current (possibly edited) contents of every case row back out of
// the DOM, in CASE_FIELDS order, producing plain objects ready to POST.
function collectCasesFromTable() {
  const rows = [...caseBody.querySelectorAll('tr[data-case-row]')];
  return rows.map(tr => {
    const obj = {};
    CASE_FIELDS.forEach(f => {
      const cell = tr.querySelector(`td[data-field="${f}"]`);
      obj[f] = cell ? cell.textContent.trim() : '';
    });
    return obj;
  });
}

function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

// Detect edits made directly in the contenteditable cells and flip into the
// "dirty" state: shows Save/Cancel + unsaved-changes badge, and disables the
// download link until the user explicitly saves.
caseBody.addEventListener('input', (e) => {
  if (e.target && e.target.classList && e.target.classList.contains('editable')) {
    setDirty(true);
  }
});

function setDirty(v) {
  isDirty = v;
  updateDirtyUi();
}

function updateDirtyUi() {
  dirtyBadge.classList.toggle('hidden', !isDirty);
  saveEditBtn.classList.toggle('hidden', !isDirty);
  cancelEditBtn.classList.toggle('hidden', !isDirty);
  if (isDirty) {
    downloadBtn.classList.add('disabled');
    downloadBtn.title = t('mustSaveFirst');
  } else if (latestCases.length) {
    downloadBtn.classList.remove('disabled');
    downloadBtn.title = '';
  }
}

downloadBtn.addEventListener('click', (e) => {
  if (isDirty || downloadBtn.classList.contains('disabled')) {
    e.preventDefault();
    showMessage('err', t('mustSaveFirst'));
  }
});

function setLoading(v) { generateBtn.disabled = v; generateBtn.textContent = v ? t('generating') : t('generateBtn'); }
function showMessage(type, text) { message.className = `message ${type}`; message.textContent = text; }
function clearMessage() { message.className = 'message hidden'; message.textContent = ''; }
function setLog(text) { log.textContent = text; }
function iconFor(name = '') { const n = name.toLowerCase(); if (n.endsWith('.xlsx') || n.endsWith('.xls')) return '📗'; if (n.endsWith('.docx') || n.endsWith('.doc')) return '📘'; if (n.endsWith('.pdf')) return '📕'; return '📄'; }
function formatSize(bytes = 0) { if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`; return `${(bytes / 1024 / 1024).toFixed(2)} MB`; }
function escapeHtml(s = '') { return String(s).replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c])); }
applyLanguage(currentLang);
