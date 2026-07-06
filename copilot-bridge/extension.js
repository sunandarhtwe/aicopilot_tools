// DAT Copilot Bridge
// -----------------------------------------------------------------------------
// Runs inside VS Code. Starts a local HTTP server that the DAT AI Test Case
// Generator (Node/Express web tool) calls instead of the OpenAI API. Requests
// are forwarded to the signed-in user's GitHub Copilot subscription via the
// built-in vscode.lm (Language Model) API, and the raw completion text is
// returned as JSON — matching the same "system + prompt in, text out" shape
// the web tool previously used with OpenAI's chat completions endpoint.
//
// It also runs a small watchdog: once the web tool tells us which port it's
// listening on (POST /register-node-port), the bridge periodically checks
// that server's /api/health endpoint. If the web tool disappears (cmd window
// closed, process killed, etc.) for a few checks in a row, the bridge quits
// VS Code automatically — so users don't have to remember to close VS Code
// by hand. The web tool also calls POST /shutdown directly on a clean exit
// (Ctrl+C) for a faster response than waiting on the watchdog.
// -----------------------------------------------------------------------------

const vscode = require('vscode');
const http = require('http');

let server = null;
let statusBarItem = null;
let watchedNodePort = null;
let watchdogTimer = null;
let watchdogFailures = 0;

function activate(context) {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'datCopilotBridge.showStatus';
  context.subscriptions.push(statusBarItem);
  setStatus('stopped');

  context.subscriptions.push(
    vscode.commands.registerCommand('datCopilotBridge.start', () => startServer()),
    vscode.commands.registerCommand('datCopilotBridge.stop', () => stopServer()),
    vscode.commands.registerCommand('datCopilotBridge.showStatus', () => showStatus()),
    vscode.commands.registerCommand('datCopilotBridge.listModels', () => listModels())
  );

  const cfg = vscode.workspace.getConfiguration('datCopilotBridge');
  if (cfg.get('autoStart', true)) {
    startServer();
  }

  context.subscriptions.push({ dispose: () => stopServer() });
}

function deactivate() {
  stopServer();
}

function setStatus(state, extra = '') {
  if (!statusBarItem) return;
  if (state === 'running') {
    statusBarItem.text = `$(check) DAT Copilot Bridge: ${extra}`;
    statusBarItem.tooltip = 'DAT Copilot Bridge is running. Click for status / stop.';
  } else if (state === 'error') {
    statusBarItem.text = `$(error) DAT Copilot Bridge: error`;
    statusBarItem.tooltip = extra || 'DAT Copilot Bridge failed to start.';
  } else {
    statusBarItem.text = `$(circle-slash) DAT Copilot Bridge: stopped`;
    statusBarItem.tooltip = 'Click to start the DAT Copilot Bridge server.';
  }
  statusBarItem.show();
}

function startServer() {
  if (server) {
    vscode.window.showInformationMessage('DAT Copilot Bridge is already running.');
    return;
  }
  const cfg = vscode.workspace.getConfiguration('datCopilotBridge');
  const port = Number(cfg.get('port', 4321));

  server = http.createServer((req, res) => handleRequest(req, res));
  server.on('error', (err) => {
    setStatus('error', err.message);
    vscode.window.showErrorMessage(`DAT Copilot Bridge failed to start on port ${port}: ${err.message}`);
    server = null;
  });
  server.listen(port, '127.0.0.1', () => {
    setStatus('running', `port ${port}`);
    vscode.window.showInformationMessage(`DAT Copilot Bridge is running on http://127.0.0.1:${port}`);
  });
}

function stopServer() {
  stopWatchdog();
  if (!server) return;
  server.close();
  server = null;
  setStatus('stopped');
}

function showStatus() {
  if (server) {
    const watching = watchedNodePort ? ` Watching Node server on port ${watchedNodePort}.` : ' Not watching any Node server yet.';
    vscode.window.showInformationMessage(`DAT Copilot Bridge is running.${watching}`);
  } else {
    vscode.window
      .showInformationMessage('DAT Copilot Bridge is stopped.', 'Start now')
      .then((choice) => { if (choice === 'Start now') startServer(); });
  }
}

// Diagnostic: lists every Copilot model this VS Code account can see, along
// with its context window size, so it's easy to check which one the bridge
// will pick (largest maxInputTokens) vs. what's available to try forcing
// via datCopilotBridge.modelFamily.
async function listModels() {
  try {
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    if (!models || !models.length) {
      vscode.window.showWarningMessage('No GitHub Copilot chat models found. Make sure you are signed in to Copilot.');
      return;
    }
    const sorted = [...models].sort((a, b) => (b.maxInputTokens || 0) - (a.maxInputTokens || 0));
    const lines = sorted.map((m, i) =>
      `${i === 0 ? '★ ' : '  '}${m.family} (${m.name || m.id}) — maxInputTokens: ${m.maxInputTokens ?? 'unknown'}`
    );
    const picked = sorted[0];
    const message = `Copilot models available (★ = what the bridge picks by default):\n\n${lines.join('\n')}`;
    console.log('[DAT Copilot Bridge] ' + message);
    vscode.window.showInformationMessage(
      `Bridge will use: ${picked.family} (maxInputTokens: ${picked.maxInputTokens ?? 'unknown'}). Full list logged to the Extension Host console.`,
      'Show all in a message'
    ).then((choice) => {
      if (choice) vscode.window.showInformationMessage(lines.join(' | '));
    });
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to list Copilot models: ${err.message || err}`);
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; if (data.length > 30 * 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

async function handleRequest(req, res) {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      return sendJson(res, 200, { ok: true, status: 'running', watchedNodePort });
    }

    if (req.method === 'POST' && req.url === '/register-node-port') {
      const body = await readJsonBody(req);
      const port = Number(body.port);
      if (!port || port < 1 || port > 65535) return sendJson(res, 400, { ok: false, message: 'Invalid port.' });
      watchedNodePort = port;
      watchdogFailures = 0;
      startWatchdog();
      return sendJson(res, 200, { ok: true, watchedNodePort });
    }

    if (req.method === 'POST' && req.url === '/shutdown') {
      sendJson(res, 200, { ok: true, message: 'Quitting VS Code shortly.' });
      setTimeout(() => quitVSCode(), 200);
      return;
    }

    if (req.method !== 'POST' || req.url !== '/generate') {
      return sendJson(res, 404, { ok: false, message: 'Not found. POST /generate is the only generation endpoint.' });
    }

    const body = await readJsonBody(req);
    const system = String(body.system || '');
    const prompt = String(body.prompt || '');
    const requestedFamily = String(body.modelFamily || '').trim();
    if (!prompt) return sendJson(res, 400, { ok: false, message: 'Missing "prompt" in request body.' });

    const cfg = vscode.workspace.getConfiguration('datCopilotBridge');
    const family = requestedFamily || String(cfg.get('modelFamily', '') || '').trim();

    const text = await askCopilot(system, prompt, family);
    sendJson(res, 200, { ok: true, text });
  } catch (err) {
    sendJson(res, 500, { ok: false, message: err.message || String(err) });
  }
}

// --- Watchdog ---------------------------------------------------------------
// Polls the Node web tool's /api/health. If it fails several times in a row,
// assumes the user closed the tool (cmd window, browser session, whatever)
// and quits VS Code so the bridge doesn't linger silently in the background.
function startWatchdog() {
  stopWatchdog();
  const cfg = vscode.workspace.getConfiguration('datCopilotBridge');
  if (!cfg.get('autoQuitOnNodeServerExit', true)) return;
  const intervalMs = Number(cfg.get('watchdogIntervalMs', 5000));
  const threshold = Number(cfg.get('watchdogFailureThreshold', 3));

  watchdogTimer = setInterval(() => {
    if (!watchedNodePort) return;
    pingHealth(watchedNodePort, (alive) => {
      if (alive) {
        watchdogFailures = 0;
      } else {
        watchdogFailures++;
        if (watchdogFailures >= threshold) {
          stopWatchdog();
          quitVSCode();
        }
      }
    });
  }, intervalMs);
}

function stopWatchdog() {
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
}

function pingHealth(port, cb) {
  const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 2500 }, (res) => {
    res.resume();
    cb(res.statusCode >= 200 && res.statusCode < 300);
  });
  req.on('timeout', () => { req.destroy(); cb(false); });
  req.on('error', () => cb(false));
}

function quitVSCode() {
  vscode.commands.executeCommand('workbench.action.quit');
}
// ---------------------------------------------------------------------------

// Sends one request to GitHub Copilot via vscode.lm and returns the
// concatenated response text. Throws with a user-facing message on failure
// (no Copilot models available, user declined consent, quota exceeded, etc).
async function askCopilot(system, prompt, family) {
  const selector = { vendor: 'copilot' };
  if (family) selector.family = family;

  let models = await vscode.lm.selectChatModels(selector);
  if ((!models || !models.length) && family) {
    // Fall back to any Copilot model if the requested family isn't available.
    models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
  }
  if (!models || !models.length) {
    throw new Error('No GitHub Copilot chat model is available. Make sure you are signed in to GitHub Copilot in VS Code and have an active subscription.');
  }
  // When no specific family was requested, don't just take whichever model
  // happened to come back first — that's often a smaller/faster model, not
  // the one the Copilot Chat panel defaults to in its UI (which is why
  // pasting the same document into Chat manually can work while this failed:
  // Chat's default model has a larger context window than models[0] here).
  // Pick the model with the largest maxInputTokens instead.
  const model = family
    ? models[0]
    : models.reduce((best, m) => (m.maxInputTokens || 0) > (best.maxInputTokens || 0) ? m : best, models[0]);

  const combinedPrompt = system ? `${system}\n\n${prompt}` : prompt;
  const messages = [vscode.LanguageModelChatMessage.User(combinedPrompt)];

  const cts = new vscode.CancellationTokenSource();
  try {
    // Proactive check: if the model exposes its input token limit, compare
    // against it before sending, so a too-large prompt fails with a clear,
    // actionable message instead of a generic error from deep inside the request.
    if (typeof model.countTokens === 'function' && typeof model.maxInputTokens === 'number' && model.maxInputTokens > 0) {
      try {
        const tokenCount = await model.countTokens(combinedPrompt, cts.token);
        if (tokenCount > model.maxInputTokens) {
          throw new Error(`Prompt too large for this Copilot model: ${tokenCount} tokens > ${model.maxInputTokens} max. Reduce COPILOT_MAX_DOC_CHARS/COPILOT_MAX_KNOWLEDGE_CHARS/COPILOT_MAX_TOTAL_PROMPT_CHARS in the web tool's .env.`);
        }
      } catch (countErr) {
        // If counting itself fails, don't block the request on it — just
        // proceed and let the real sendRequest call surface any real error.
        if (countErr && /Prompt too large/.test(countErr.message)) throw countErr;
      }
    }

    const chatResponse = await model.sendRequest(messages, {}, cts.token);
    let text = '';
    for await (const fragment of chatResponse.text) {
      text += fragment;
    }
    if (!text.trim()) throw new Error('GitHub Copilot returned an empty response.');
    return text;
  } catch (err) {
    if (err instanceof vscode.LanguageModelError) {
      throw new Error(`GitHub Copilot error (${err.code}): ${err.message}`);
    }
    throw err;
  } finally {
    cts.dispose();
  }
}

module.exports = { activate, deactivate };
