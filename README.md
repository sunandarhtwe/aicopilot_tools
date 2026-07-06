# DAT AI Test Case Generator v4.0 - GitHub Copilot Bridge Edition

## What changed vs the OpenAI version (V4 openai zip)

1. **AI backend swapped**: OpenAI API calls removed. This server now calls the
   local **DAT Copilot Bridge** VS Code extension (`/copilot-bridge`), which
   uses `vscode.lm` to reach the signed-in user's GitHub Copilot subscription.
   No API key/billing needed — just a Copilot seat.
2. **Fully automated launch**: double-clicking `start_DAT_Copilot_Tool.bat`
   silently launches VS Code (minimized) with the bridge if it isn't already
   running — no manual VS Code interaction needed day-to-day (after a
   one-time setup, see below).
3. **Auto-close**: when you close the tool, the bridge/VS Code shuts itself
   back down automatically (fast path on clean exit + a watchdog backup for
   abrupt closes). See `copilot-bridge/README.md` for details.
4. **Test Case Type selector**: choose 結合テスト (Integration) / 単体テスト
   (Unit) / 総合テスト (Comprehensive) *before* generating. The selection
   changes both AI prompt stages and is recorded in the generated Excel.
5. **Duplicate removal**: generated cases are de-duplicated (by normalized
   test item + expected result) before being shown in the Preview.
6. **Editable preview** (unchanged from V4 openai): every cell is directly
   editable.
7. **Save required before download**: editing any cell disables the download
   button and shows an "unsaved changes" badge + Save/Cancel buttons.
   **Save** posts the edits to the server, regenerates the `.xlsx`, and
   re-enables downloading.
8. **Cancel button**: discards in-progress edits and restores the table to
   the last saved/generated state.

## Architecture

```
Browser (public/index.html + script.js)
        │  (upload docs, keyword/notes, test case type, generate/save/cancel)
        ▼
Node/Express server.js  (this project)
        │  POST /generate  { system, prompt }
        ▼
DAT Copilot Bridge (VS Code extension, /copilot-bridge, port 4321)
        │  vscode.lm.sendRequest(...)
        ▼
GitHub Copilot (signed-in VS Code account)
```

## Setup

### 1. One-time: install the DAT Copilot Bridge extension

Run `copilot-bridge/install-extension.bat` **once** per PC. This packages
and installs the extension into VS Code so it auto-starts every time VS Code
opens — you won't need to touch VS Code manually after this. Full details in
`copilot-bridge/README.md`.

### 2. Install packages for this server

```bash
npm install
```

### 3. Create `.env` (or just let the launcher create it for you)

```bash
cp .env.example .env
```
(Windows: `copy .env.example .env`)

### 4. Run

Just double-click:

```
start_DAT_Copilot_Tool.bat
```

It will auto-launch the bridge if needed, wait for it to come online, start
the server, and open your browser. When you're done, close the cmd window
(or Ctrl+C) — the bridge/VS Code will close itself automatically shortly
after.

Alternatively, run manually:

```bash
npm start
```

Open:

```text
http://localhost:3000
```

(Manual `npm start` doesn't auto-launch VS Code — start the bridge yourself
first, per `copilot-bridge/README.md`, if you're not using the .bat file.)

## Fallback behavior

If the DAT Copilot Bridge extension isn't running, isn't reachable, or
GitHub Copilot returns an error, generation automatically falls back to the
document-based (non-AI) engine — it extracts keyword-matching rows straight
from the uploaded documents instead of failing outright. The log panel in
the UI will say "Copilot Bridge not reachable/failed" when this happens.

## Notes

- 会社機密資料・顧客情報を Copilot に送信する前に、必ず会社／DIR 側の利用ルール
  （GitHub Copilot Business/Enterprise の Data retention 設定含む）を確認して
  ください。
- 生成されたテストケース件数は固定していません。Test Case Type と資料内容に
  応じて必要十分な件数のみ生成します。
- 根拠がない値やエラーメッセージは推測せず「要確認」と出力します。
