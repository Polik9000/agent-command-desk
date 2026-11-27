# Agent Command Desk

A small local desktop window for **Claude Code**. Pick an allowlisted account and project, chat with streamed answers,
see every tool call (edits as diffs), plan first and approve with one click, send messages while Claude works, queue the
next ones and attach screenshots or PDFs.

No dependencies – just Node.js built-ins, a Chrome app window and the official `claude` CLI you are already logged into.
Runs on Windows and macOS (experimental). The UI is in Czech.

> Not affiliated with Anthropic. "Claude" is a trademark of Anthropic. The app runs the unmodified `claude` binary under
> your own login and never reads or stores credentials.

![Start screen](docs/screenshots/01-start.png)

| Conversation with tool cards and a diff | Claude working: message sent mid-run, queue, attachments |
|---|---|
| ![Conversation](docs/screenshots/02-konverzace.png) | ![Working](docs/screenshots/03-prace-fronta-prilohy.png) |

| Plan waiting for approval |
|---|
| ![Plan](docs/screenshots/04-plan.png) |

## Features
- **Chat with Claude Code** – streamed answers, tool cards (Edit/MultiEdit/Write shown as diffs, Bash commands, results),
  clear "denied" badges, model and cost of the last run in the footer.
- **Accounts with an allowlist** – each account is a separate Claude Code config directory with an expected e-mail,
  verified via `claude auth status`. Any other login (e.g. a personal account) cannot be used, not even by mistake.
- **Projects** – only allowlisted folders; git branch and number of changes shown in the header.
- **Auto / Plan** – Plan writes a plan and changes nothing; **Approve plan** continues in Auto in the same session.
- **Model and effort** – the *Model* button next to Auto/Plan offers presets (*Rychlé* = Sonnet + low effort,
  *Běžná práce* = account default, *Důkladné* = Opus + high effort) or any allowlisted model and effort level. The choice
  is remembered per account, applies from the next message (also inside a running session) and queued messages keep
  theirs. The footer shows the model Claude Code actually used; effort is marked *požadováno* (requested) because the
  CLI does not report it back.
- **Sessions** – list with history, resume any session, Stop kills the whole process tree.
- **Send now** – while Claude works, *Poslat hned* passes your message into the running turn; Claude picks it up at the
  next step (like in the Claude Code terminal) and the message shows when it was read.
- **Message queue** – *Do fronty* keeps messages until the run finishes, then sends them one by one to the same session.
  Reorder (arrows or drag the ⠿ handle), edit, remove, pause. Stop, an error, a usage limit or a plan waiting for approval
  pauses the queue – nothing is sent on its own after an interruption.
- **Attachments** – drag & drop into the window, paste a screenshot with Ctrl+V or use *Přiložit*. Images (png, jpg, gif,
  webp), PDF and text files (txt, md, csv, json, log); type checked by content, size limited, stored outside the repo and
  deleted after 7 days. Claude can read only the current account's and project's attachment folder.
- **Comfortable typing** – Enter after `1. item`, `- item` or `- [ ] item` continues the list, Enter on an empty item ends
  it, Shift+Enter is a plain new line.
- **Notifications** (optional, footer toggle) – when Claude finishes, a plan waits or a limit is hit while the window is
  in the background; the window title gets a ● marker.
- **Usage limits** – warning when an account gets close; when it hits the limit, one click switches to another account
  and resends.
- **Your own name and look** – one config value and one CSS file (see *Customize*).
- **Security** – loopback only, per-launch token, Host/Origin checks, strict CSP, permission mode only `auto` or `plan`
  (never `bypassPermissions`). Details in [docs/security.md](docs/security.md).

### Keyboard
| Keys | Action |
|---|---|
| Ctrl+Enter | Send; while Claude works: send now into the running turn |
| Ctrl+Shift+Enter | While Claude works: add to the queue |
| Enter | New line; continues a numbered/bulleted list |
| Shift+Enter | Plain new line (no list continuation) |
| Ctrl+V | Paste text, or a screenshot as an attachment |
| Ctrl+Enter / Esc (editing a queued message) | Save / cancel |

## Requirements
- **Windows 10/11** or **macOS** (macOS is *experimental*: covered by CI tests, not yet tried by hand).
- Node.js ≥ 22 and Google Chrome.
- Claude Code installed with the native installer (`~/.local/bin/claude` or `%USERPROFILE%\.local\bin\claude.exe`).
  On Windows the npm `claude.cmd` shim is rejected on purpose (no shell); set `claudeExe` to a real `.exe` instead.

## Setup
1. **Clone** the repo anywhere: `git clone https://github.com/Polik9000/agent-command-desk.git`
2. **Give each account its own Claude Code config directory** and log in once:
   - Windows – create `%USERPROFILE%\bin\claude-work.cmd`:
     ```bat
     @echo off
     set CLAUDE_CONFIG_DIR=%USERPROFILE%\.claude-work
     claude %*
     ```
     then run `claude-work` and type `/login`.
   - macOS – add `alias claude-work='CLAUDE_CONFIG_DIR=$HOME/.claude-work claude'` to `~/.zshrc`, then `claude-work` → `/login`.

   A dedicated folder is recommended even for a single account (`CLAUDE_CONFIG_DIR=~/.claude` is *not* the same as the
   default setup and would ask you to log in again).
3. **Configure:** copy `config.example.json` to `local/config.json` and edit accounts (id, label, `configDir`,
   `expectedEmail`, `accent` colour) and projects (id, label, `path`). Paths may use `~`, `%VAR%` or `$VAR`, and any path
   can be per-platform: `{ "win32": "...", "darwin": "..." }`. Optional: `claudeExe`, `gitExe`, `browserExe`, `stateDir`,
   `disallowedTools`, `appendSystemPrompt` (`{appName}` is replaced), `models` – the models offered in the picker
   (`id` is an alias or full model name passed to `claude --model`; `""` = the account's default is always added):
   ```json
   "models": [{ "id": "opus", "label": "Opus" }, { "id": "sonnet", "label": "Sonnet" }, { "id": "fable", "label": "Fable" }]
   ```
   The server accepts only these ids and the effort levels `low`, `medium`, `high`, `xhigh`, `max`.
4. **Install the launcher:**
   - Windows: `powershell -ExecutionPolicy Bypass -File scripts\install.ps1` → creates `%USERPROFILE%\bin\<app id>.cmd`
     (make sure `%USERPROFILE%\bin` is on `PATH`).
   - macOS: `sh scripts/install.sh` → creates `~/.local/bin/<app id>`.
5. **Run** `agent-command-desk` (or your own `app.id`). The server starts hidden and opens a Chrome app window;
   closing the window stops the server and any running `claude`. Logs (without prompts) are in the state directory
   (`%LOCALAPPDATA%\<app id>` / `~/Library/Application Support/<app id>`).

To update later: `git pull`, then close the window and start the app again (your `local/` folder is never touched).

## Customize
Everything personal lives in `local/` (git-ignored):

| File | What |
|---|---|
| `local/config.json` | `app.id` (launcher and state folder name), `app.name` (window title and logo), accounts, projects |
| `local/theme.css` | your look: copy `src/server/wwwroot/theme.css` and change colours, fonts (`@font-face`), brand suffix, motif, spinner, scrollbars |
| `local/favicon.svg` | your icon |

Ready-made prompt for Claude Code (replace the parts in brackets):

```text
Clone https://github.com/Polik9000/agent-command-desk into [~/code/agent-command-desk] and read README.md.
Create local/config.json from config.example.json: app name "[My Desk]", account "[Work]" with config dir
[~/.claude-work] and e-mail [me@example.com], projects [~/code/site, ~/code/app].
Create local/theme.css from src/server/wwwroot/theme.css in my brand: colours [#123456 …], fonts [… – bundle
woff2 files in local/ only if their licence allows it], and local/favicon.svg.
Only create files inside local/, do not change anything else and do not commit. Then run npm test and the install script.
```

## Development
```
npm test        # 61 tests: stream parser, config (incl. model allowlist), account guard, queue, list editing, attachments, 401/403/CSP
npm run check   # syntax check
ACD_OPEN_BROWSER=0 node src/server/server.mjs   # prints the URL with token on an interactive console
```
No real `claude` is needed for the tests; CI runs them on Windows, macOS and Linux.
Test-only environment variables: `ACD_CONFIG`, `ACD_TOKEN` (≥ 32 chars), `ACD_PORT`, `ACD_OPEN_BROWSER`.
Vendor libraries and optional fonts: `scripts/fetch-vendor.ps1` (pinned versions, see `src/server/wwwroot/vendor/VERSIONS.md`).
How the CLI is driven (stream-json input/output, sending into a running turn): [docs/claude-code-headless.md](docs/claude-code-headless.md).

## Roadmap
Settings panel (accounts, projects, full screen), read-only git diff view, command palette,
usage statistics. Interactive permission prompts are being researched.

## Uninstall
Windows: `powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1` · macOS: `sh scripts/uninstall.sh`.
Removes the launcher and the state folder; your Claude Code accounts and the repo stay. Delete the repo folder yourself.

## License
[MIT](LICENSE) © 2026 Tobias Otta. Bundled third-party code and fonts keep their own licences.

---

## Česky
Malé lokální okno nad Claude Code: povolené účty a projekty, streamované odpovědi, karty nástrojů s diffem, režim Plán
se schválením jedním tlačítkem, pokračování sezení, volba modelu a effortu (předvolby Rychlé / Běžná práce / Důkladné,
pamatuje se pro každý účet). Během práce lze poslat zprávu hned do běžícího tahu, nebo ji dát
do fronty; přikládat jde screenshoty (Ctrl+V), PDF a textové soubory. Rozhraní je české.

**Nastavení**
1. Každý účet = vlastní složka `CLAUDE_CONFIG_DIR` (alias viz *Setup*), jednou `/login`.
2. `config.example.json` zkopírujte do `local/config.json` a vyplňte účty (včetně očekávaného e-mailu) a projekty.
   Volitelně `models` = seznam modelů nabízených ve výběru (viz *Setup*).
3. Vlastní název: `app.name` v configu. Vlastní vzhled: `local/theme.css` (vzor `src/server/wwwroot/theme.css`),
   ikona `local/favicon.svg`. Složka `local/` se nikdy necommituje.
4. Spouštěč: Windows `scripts\install.ps1`, macOS `scripts/install.sh`; pak příkaz podle `app.id`.

Nebo dejte Claudovi prompt z části *Customize* a nechte ho nastavit všechno za vás.

**Klávesy:** Ctrl+Enter odešle (během práce = poslat hned), Ctrl+Shift+Enter = do fronty, Enter v seznamu doplní další
číslo či odrážku, Shift+Enter = obyčejný nový řádek, Ctrl+V vloží screenshot jako přílohu.
