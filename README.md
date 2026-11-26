# Agent Command Desk

A small local desktop window for **Claude Code**: pick an allowlisted account and project, chat with streamed answers,
see every tool call (with diffs), plan first and approve with one click, resume past sessions.

No dependencies – just Node.js built-ins, a Chrome app window and the official `claude` CLI you are already logged into.
The UI is in Czech.

> Not affiliated with Anthropic. "Claude" is a trademark of Anthropic. The app runs the unmodified `claude` binary under
> your own login and never touches credentials.

## Features
- Streamed answers, tool cards (Edit/MultiEdit/Write shown as diffs), clear "denied" badges.
- Account switcher with an **allowlist**: each account is a separate Claude Code config directory with an expected
  e-mail, verified via `claude auth status`. Anything else (e.g. your personal account) cannot be used.
- Project switcher (allowlisted folders only), git branch and change count.
- **Auto** / **Plan** modes: Plan writes a plan and changes nothing; **Approve plan** continues in Auto in the same session.
- Session list with history and resume, Stop button (kills the whole process tree).
- **Send now**: while Claude works, *Poslat hned* (Ctrl+Enter) passes your message into the running turn – Claude
  picks it up at the next step, like in the Claude Code terminal, and the message shows when it was read.
- **Message queue**: *Do fronty* (Ctrl+Shift+Enter) – messages wait in a queue (reorder, edit, remove) and are sent
  one by one to the same session. Stop, an error, a usage limit or a plan waiting for approval pauses the queue;
  nothing is sent on its own after an interruption.
- **Attachments**: drag & drop files into the window, paste a screenshot with Ctrl+V or use *Přiložit*. Images (png, jpg,
  gif, webp), PDF and text files (txt, md, csv, json, log); type is checked by content, size is limited. Files are stored
  in the app state folder (never in the repo) and Claude gets read access only to the current account's and project's
  attachment folder (`--add-dir`), so it can re-read them later in the same session. Removed after 7 days.
- **Comfortable typing**: Enter after `1. item` or `- item` continues the list, Enter on an empty item ends it,
  Shift+Enter is a plain new line; queued messages can also be reordered by dragging the ⠿ handle.
- **Notifications** (optional, footer toggle): when Claude finishes, a plan waits for approval or a limit is hit while
  the window is in the background; the window title gets a ● marker.
- Usage-limit warnings; when an account hits its limit, one click switches to another account and resends.
- Security: loopback only, per-launch token, Host/Origin checks, strict CSP – see [docs/security.md](docs/security.md).
- Your name, look and icon come from one config value and one CSS file (see *Customize*).

## Requirements
- **Windows 10/11** or **macOS** (macOS is *experimental*: covered by CI tests, not yet tried by hand).
- Node.js ≥ 22, Google Chrome.
- Claude Code installed with the native installer (`~/.local/bin/claude` or `%USERPROFILE%\.local\bin\claude.exe`).
  On Windows the npm `claude.cmd` shim is rejected on purpose (no shell); set `claudeExe` to a real `.exe` instead.

## Setup
1. **Clone** the repo anywhere.
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
   `disallowedTools`, `appendSystemPrompt` (`{appName}` is replaced).
4. **Install the launcher:**
   - Windows: `powershell -ExecutionPolicy Bypass -File scripts\install.ps1` → creates `%USERPROFILE%\bin\<app id>.cmd`
     (make sure `%USERPROFILE%\bin` is on `PATH`).
   - macOS: `sh scripts/install.sh` → creates `~/.local/bin/<app id>`.
5. **Run** `agent-command-desk` (or your own `app.id`). The server starts hidden and opens a Chrome app window;
   closing the window stops the server and any running `claude`. Logs (without prompts) are in the state directory
   (`%LOCALAPPDATA%\<app id>` / `~/Library/Application Support/<app id>`).

## Customize
Everything personal lives in `local/` (git-ignored):

| File | What |
|---|---|
| `local/config.json` | `app.id` (launcher and state folder name), `app.name` (window title and logo), accounts, projects |
| `local/theme.css` | your look: copy `src/server/wwwroot/theme.css` and change colours, fonts (`@font-face`), brand suffix, motif, spinner |
| `local/favicon.svg` | your icon |

Ready-made prompt for Claude Code (replace the parts in brackets):

```text
Clone https://github.com/OWNER/agent-command-desk into [~/code/agent-command-desk] and read README.md.
Create local/config.json from config.example.json: app name "[My Desk]", account "[Work]" with config dir
[~/.claude-work] and e-mail [me@example.com], projects [~/code/site, ~/code/app].
Create local/theme.css from src/server/wwwroot/theme.css in my brand: colours [#123456 …], fonts [… – bundle
woff2 files in local/ only if their licence allows it], and local/favicon.svg.
Only create files inside local/, do not change anything else and do not commit. Then run npm test and the install script.
```

## Development
```
npm test        # parser, config, account guard, 401/403/CSP (no real claude needed)
npm run check   # syntax check
ACD_OPEN_BROWSER=0 node src/server/server.mjs   # prints the URL with token on an interactive console
```
Test-only environment variables: `ACD_CONFIG`, `ACD_TOKEN` (≥ 32 chars), `ACD_PORT`, `ACD_OPEN_BROWSER`.
Vendor libraries and optional fonts: `scripts/fetch-vendor.ps1` (pinned versions, see `src/server/wwwroot/vendor/VERSIONS.md`).
How the CLI is driven: [docs/claude-code-headless.md](docs/claude-code-headless.md).

## Roadmap
Model/effort picker, read-only git diff view,
command palette, notifications. Interactive permission prompts are being researched.

## Uninstall
Windows: `powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1` · macOS: `sh scripts/uninstall.sh`.
Removes the launcher and the state folder; your Claude Code accounts and the repo stay. Delete the repo folder yourself.

## License
[MIT](LICENSE) © 2026 Tobias Otta. Bundled third-party code and fonts keep their own licences.

---

## Česky
Malé lokální okno nad Claude Code: povolené účty a projekty, streamované odpovědi, karty nástrojů s diffem, režim
Plán se schválením jedním tlačítkem, pokračování sezení. Rozhraní je české.

1. Každý účet = vlastní složka `CLAUDE_CONFIG_DIR` (alias výše), jednou `/login`.
2. `config.example.json` zkopírujte do `local/config.json` a vyplňte účty (včetně očekávaného e-mailu) a projekty.
3. Vlastní název: `app.name` v configu. Vlastní vzhled: `local/theme.css` (vzor `src/server/wwwroot/theme.css`),
   ikona `local/favicon.svg`. Složka `local/` se nikdy necommituje.
4. Spouštěč: Windows `scripts\install.ps1`, macOS `scripts/install.sh`; pak příkaz podle `app.id`.

Nebo dejte Claudovi prompt z části *Customize* a nechte ho nastavit všechno za vás.
