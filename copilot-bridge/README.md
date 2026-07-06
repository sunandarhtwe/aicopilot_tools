# DAT Copilot Bridge (VS Code Extension)

This extension lets the **DAT AI Test Case Generator** web tool use your
personal **GitHub Copilot** subscription instead of an OpenAI API key.

## Why this exists

GitHub Copilot does not offer a plain server-to-server API like OpenAI's.
The only supported way to reach a Copilot chat model programmatically is
VS Code's built-in `vscode.lm` (Language Model) API, which only runs **inside
VS Code**, using whichever account is signed in to Copilot in that window.

So the architecture is:

```
Browser (index.html)  ─►  Node server.js (Express, port 3000+)  ─►  DAT Copilot Bridge (this extension, port 4321)  ─►  GitHub Copilot (via vscode.lm)
```

`start_DAT_Copilot_Tool.bat` (in the project root) automates this whole
chain — see "Day-to-day use" below. VS Code itself still has to run (Copilot
only works from inside VS Code), but you no longer have to open or click
anything in it yourself.

## One-time setup (run once per PC)

1. Make sure the `code` command works from a terminal. If `where code` shows
   nothing: open VS Code → Ctrl+Shift+P → **"Shell Command: Install 'code'
   command in PATH"**.
2. Double-click **`install-extension.bat`** in this folder. It will:
   - package this extension into a `.vsix` (needs internet access once, to
     fetch the `vsce` packaging tool), and
   - install that `.vsix` into your VS Code permanently.
3. That's it — from now on, whenever VS Code opens, this extension
   auto-starts the bridge server in the background (no F5, no opening this
   folder, no clicking anything).

> Re-run `install-extension.bat` any time `extension.js` or `package.json`
> in this folder changes (including updates from a new zip) — the installed
> `.vsix` is a snapshot and won't pick up edits automatically.

## Day-to-day use

Just double-click **`start_DAT_Copilot_Tool.bat`** in the project root. It
will:

1. Check if the bridge is already running (`http://127.0.0.1:4321/health`).
2. If not, silently launch VS Code **minimized** (`code --new-window ... `)
   so the already-installed extension auto-starts the bridge. No VS Code
   window interaction needed.
3. Wait (up to 30s) for the bridge to come online.
4. Register the web tool's port with the bridge, so the bridge can watch it.
5. Start the Node web server and open your browser.

You do not need to manually open VS Code for normal use — only for the
one-time `install-extension.bat` step above.

### Auto-close behavior

When you close the tool (Ctrl+C in the cmd window, or just closing it), two
things try to shut the bridge/VS Code back down automatically:

- **Fast path**: the Node server directly tells the bridge to quit on a clean
  exit (e.g. Ctrl+C).
- **Watchdog (backup)**: the bridge itself polls the Node server's
  `/api/health` every few seconds. If the Node server stops responding for
  ~15 seconds (e.g. the cmd window was closed abruptly with the X button,
  which doesn't always let the fast path run), the bridge quits VS Code on
  its own.

This means if VS Code was auto-launched by `start_DAT_Copilot_Tool.bat`
(rather than one you already had open for other work), it will close itself
within a few seconds to ~15 seconds of you finishing. If the bridge was
already running before you started the tool (e.g. you keep VS Code open all
day), the launcher won't touch that VS Code window — the watchdog also
recognizes that case is fine and simply keeps watching.

## Alternative: manual debug run (for editing this extension)

If you're modifying `extension.js` itself, skip `install-extension.bat` and
instead:

1. Open this `copilot-bridge` folder in VS Code.
2. Press **F5** ("Run Extension") — opens an Extension Development Host with
   your latest changes, without needing to re-package/reinstall each time.

## Settings

Open VS Code Settings and search "DAT Copilot Bridge":

| Setting | Default | Purpose |
|---|---|---|
| `datCopilotBridge.port` | `4321` | Local port. Must match `COPILOT_BRIDGE_URL` in the web tool's `.env`. |
| `datCopilotBridge.modelFamily` | *(empty)* | Force a specific Copilot model, e.g. `gpt-4o` or `claude-3.5-sonnet`. Leave empty for the default. |
| `datCopilotBridge.autoStart` | `true` | Start the bridge server automatically when VS Code launches. |
| `datCopilotBridge.autoQuitOnNodeServerExit` | `true` | Auto-quit VS Code once the watched Node server stops responding. |
| `datCopilotBridge.watchdogIntervalMs` | `5000` | How often the watchdog checks the Node server's health. |
| `datCopilotBridge.watchdogFailureThreshold` | `3` | Consecutive failed checks before auto-quitting. |

## Commands (Ctrl+Shift+P)

- **DAT Copilot Bridge: Start Bridge Server**
- **DAT Copilot Bridge: Stop Bridge Server**
- **DAT Copilot Bridge: Show Status**

## Requirements

- VS Code 1.90+
- An active GitHub Copilot subscription, signed in inside VS Code
- The DAT AI Test Case Generator's `.env` pointing at this bridge:
  ```
  COPILOT_BRIDGE_URL=http://127.0.0.1:4321/generate
  ```

## Troubleshooting

- **"Message exceeds token limit" (HTTP 500 from the bridge), but pasting
  the same document into Copilot Chat manually works fine** — this was a
  real bug: the bridge used to take whatever model `vscode.lm` returned
  first, which is not necessarily the same (larger-context) model the Chat
  panel defaults to. Fixed: the bridge now picks whichever available Copilot
  model has the **largest context window** automatically. Run
  **DAT Copilot Bridge: List Available Copilot Models** (Ctrl+Shift+P) to see
  exactly which models you have access to and which one the bridge is
  choosing (★). If you'd rather pin a specific one, set
  `datCopilotBridge.modelFamily` in VS Code settings (or `COPILOT_MODEL_FAMILY`
  in the web tool's `.env`) to the family name shown in that list. The web
  tool's own size caps (`COPILOT_MAX_DOC_CHARS` etc.) still apply on top of
  this as a safety margin — lower them further if a particular model still
  rejects the request.
- **"Copilot Bridge not reachable/failed" in the web tool's log** — the
  extension isn't running yet, or the port doesn't match. Give it a few more
  seconds on first launch, or check the VS Code status bar.
- **"No GitHub Copilot chat model is available"** — sign in to GitHub
  Copilot in VS Code (Accounts icon, bottom-left) and make sure your
  subscription is active.
- **VS Code keeps closing itself while you're still using it for other
  work** — that only happens to a VS Code window this tool auto-launched
  AND only after the Node web tool itself has stopped responding. If you
  want to keep a bridge-enabled VS Code window open long-term regardless,
  open VS Code yourself first (so `BRIDGE_WAS_ALREADY_RUNNING` is detected)
  before running `start_DAT_Copilot_Tool.bat`.
- **`install-extension.bat` fails to package** — usually a proxy/internet
  issue reaching the npm registry for the `vsce` tool. Retry on a network
  with registry access.
