# Agent Command Desk

A small local desktop window for **Claude Code** that works like the terminal and shows more. Pick an allowlisted
account and project, chat with streamed answers, watch every tool call and every agent Claude starts, see a live task
list with progress and time left, plan first and approve with one click, switch mode or model while Claude works,
send messages into a running turn, queue the next ones, rewind files, and attach screenshots or PDFs.

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

### Conversation
- **Chat with Claude Code** – streamed answers, tool cards (Edit/MultiEdit/Write as coloured diffs, commands, results,
  images such as screenshots), clear "denied" badges; *Kopírovat* under every reply copies it as Markdown.
- **Modes** – **Auto**, **Plán** (writes a plan, changes nothing; *Schválit plán* continues in Auto in the same session,
  *Připomínkovat* lets you comment on lines of the plan and sends the comments back), **Úpravy** (file edits without
  asking, commands ask) and **Ručně** (asks before every edit and command; needs `interactivePermissions`).
- **Model and effort** – the *Model* button offers presets (*Rychlé* = Sonnet + low effort, *Běžná práce* = account
  default, *Důkladné* = Opus + high effort) or any allowlisted model and effort level, remembered per account. The footer
  shows the model Claude Code actually used.
- **Send now and queue** – while Claude works, *Poslat hned* passes your message into the running turn (Claude reads it
  at the next step, like in the terminal); *Do fronty* keeps messages until the run finishes, then sends them one by one.
  Reorder (arrows or drag ⠿), edit, return to the text box (↩), remove, pause. Stop, an error, a usage limit or a plan
  waiting for approval pauses the queue.
- **Attachments** – drag & drop, paste a screenshot with Ctrl+V or use *Přiložit*: images, PDF and text files; type
  checked by content, size limited, stored outside the repo, deleted after 7 days.
- **`/` and `@` in the text box** – `/` suggests your commands and skills with descriptions and argument hints, `@`
  suggests project files (Claude Code reads the file right away).
- **Follows the output** – the conversation stays at the bottom while Claude writes, unless you scroll up (then *↓ Na konec* appears); the message box grows with your text.
- **Find** – Ctrl+F finds text in the conversation (diacritics and case ignored; matches in collapsed cards open them).
- **Comfortable typing** – lists continue on Enter, Shift+Enter is a plain new line; unsent drafts are kept per session.

### Like the Claude Code terminal
| Terminal | In the app |
|---|---|
| Esc | *Zastavit* interrupts; the session stays ready, the next message answers at once |
| Shift+Tab, `/model` | mode and model can be switched while Claude works |
| Ctrl+T (task list) | **Průběh** panel on the right: Claude's own task list, current step, %, time left |
| subagents | one **agent card** each – task, type, state, tools, tokens, time; expand to watch live what it does |
| Ctrl+B (background) | **Na pozadí** list of background commands and agents with *Zastavit* |
| `/context`, `/compact` | footer *Kontext 42 %* with a breakdown and *Zhustit* |
| Esc Esc, `/rewind` | ↶ next to your message rewinds the project files to the state before it (file list shown first) |
| questions with options | a card with choices and your own answer (needs `interactivePermissions`) |
| permission prompts | cards *Povolit jednou / Povolit vždy / Zamítnout*, edits shown as a diff (needs `interactivePermissions`) |
| `/btw` | *Bokem* – a side question answered from the session in Plan mode, never saved (a half-written message moves into it) |
| `--fork-session` | ⑂ continue in a copy of a session; the original stays untouched |
| `/rename` | ✎ renames the session in Claude Code itself (visible in the terminal too) |
| `/resume` | session list with search across your and Claude's messages; sessions open in a terminal are marked |
| `/mcp` | MCP servers and their state in *Přehled sezení*; a failed server is noted in the chat |
| `/export` | *Exportovat* saves the conversation as Markdown |

### Changes and files
- **Git changes (read-only)** – click the branch in the header: changed files grouped as conflicts, staged, changed and
  new, with a coloured diff. Click a line (or Enter on it) to write a comment; *Vložit do zprávy* turns all comments
  into one message for Claude. Nothing can be staged, committed or pushed from the app.
- **Project files (read-only)** – *Soubory*: a flat list or folders (*Seznam* / *Složky*), search by name or path,
  view with syntax highlighting, insert the path or copy the content. Only what git tracks plus new files; key, certificate and `.env` files are never shown.
- **Session overview** – *Přehled sezení* in the footer: files Claude edited (also by agents), the task list, agents
  and their state, tools used, MCP servers.

### Usage and limits
- **Statistics** – the *Statistiky* button in the footer (or Ctrl+K → *Statistiky v čase*): tokens, turns, time and the API-price estimate for the last run and
  the session, apart from your **subscription limit** (5-hour and 7-day windows). *Historie a grafy*: per day by
  project, model or account, limit usage over time, table and CSV export (only numbers are stored, 180 days).
- **Several accounts** – a warning when an account gets close to its limit; when it hits it, one click switches to
  another account and resends. Otherwise the app **continues automatically** a minute after the limit resets (window
  open, cancellable, at most 3 tries).
- **Fast follow-ups** – after a reply Claude Code keeps running for a while, so the next message in the session starts
  without start-up (about 0.8 s instead of 3 s for a short reply), also after a mode or model change.

### Window and safety
- **Accounts with an allowlist** – each account is its own Claude Code config directory with an expected e-mail,
  verified via `claude auth status`; any other login (e.g. a personal account) cannot be used, not even by mistake.
- **Projects and accounts in *Nastavení*** – add, rename, remove projects and pick the default one; add or remove
  accounts (name, e-mail, Claude Code folder, colour). A new account is used only once that folder is logged in with
  exactly that e-mail – *Příkaz pro přihlášení* copies the terminal command, then type `/login`.
- **Claude in Chrome** (optional, only with `interactivePermissions`) – a checkbox in the *Model* panel lets Claude
  control your Chrome through the Claude in Chrome extension; every browser action needs your approval in the window.
- **Notifications** – when Claude finishes, asks, a plan waits or a limit is hit while the window is in the background.
- **Keyboard and screen readers** – everything works from the keyboard; messages, errors, plans, questions and
  permission requests are announced; checked with axe-core (WCAG 2.2 AA) in both themes.
- **Light or dark**, **your own name and look** (one config value and one CSS file, see *Customize*).
- **Security** – loopback only, per-launch token, Host/Origin checks, strict CSP; permission modes `auto`, `plan`,
  `acceptEdits` (plus `default` with permission requests on; never `bypassPermissions` or `dontAsk`); `claude` only via
  spawn with an argument array. Details in [docs/security.md](docs/security.md).

### Keyboard
| Keys | Action |
|---|---|
| Ctrl+K | Command palette (commands, skills, agents, app actions, recent messages) |
| `/` · `@` at the start of a word | Suggest commands and skills · project files |
| Ctrl+F | Find in the conversation (Enter / Shift+Enter or F3 / Shift+F3 = next / previous, Esc closes) |
| Ctrl+Enter | Send; while Claude works: send now into the running turn |
| Ctrl+Shift+Enter | While Claude works: add to the queue |
| Enter / Shift+Enter | New line that continues a list / plain new line |
| Ctrl+V | Paste text, or a screenshot as an attachment |
| Esc | Close a dialog, the find bar or a suggestion list |

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
   can be per-platform: `{ "win32": "...", "darwin": "..." }`. Optional settings:

   | Key | Meaning |
   |---|---|
   | `interactivePermissions` | `true` = permission cards, questions with options, mode *Ručně* and Claude in Chrome. Off by default: whatever Claude Code would ask about is denied automatically. **Recommended `true`.** |
   | `appendSystemPrompt` | text added to Claude Code's system prompt (`{appName}` is replaced); the example tells Claude it runs in this app and may ask questions with options |
   | `models` | models offered in the picker, e.g. `[{ "id": "haiku", "label": "Haiku" }, { "id": "sonnet", "label": "Sonnet" }, { "id": "opus", "label": "Opus" }]` (default order: Haiku, Sonnet, Opus, Fable – from fastest to most capable) (`id` = alias or full name for `claude --model`; the account default `""` is always added) |
   | `sessionProcessMinutes` | how long Claude Code stays running after a reply (default 10; `0` = new process every message) |
   | `startFullscreen` | `true` = open the window in full screen |
   | `claudeExe`, `gitExe`, `browserExe`, `stateDir`, `disallowedTools` | paths and tools to deny |

   The server accepts only the configured models and the effort levels `low`, `medium`, `high`, `xhigh`, `max`.
4. **Install the launcher:**
   - Windows: `powershell -ExecutionPolicy Bypass -File scripts\install.ps1` → creates `%USERPROFILE%\bin\<app id>.cmd`
     (make sure `%USERPROFILE%\bin` is on `PATH`).
   - macOS: `sh scripts/install.sh` → creates `~/.local/bin/<app id>`.
5. **Run** `agent-command-desk` (or your own `app.id`) in a terminal. The server starts hidden and opens a Chrome app
   window; closing the window stops the server and any running `claude`. If the app is already running, the launcher
   just says so – close the window first to start the new version. Logs (without prompts) are in the state directory
   (`%LOCALAPPDATA%\<app id>` / `~/Library/Application Support/<app id>`).

To update later: `git pull`, close the window and run the launcher again (your `local/` folder is never touched).
Changes to `local/config.json` also apply only after a restart.

## Customize
Everything personal lives in `local/` (git-ignored):

| File | What |
|---|---|
| `local/config.json` | `app.id` (launcher and state folder name), `app.name` (window title and logo), accounts, projects |
| `local/theme.css` | your look: copy `src/server/wwwroot/theme.css` and change colours, fonts (`@font-face`), brand suffix, motif, spinner, scrollbars; light colours go in a `:root[data-theme="light"]` block (`--accent-ink` = accent used for text and lines) |
| `local/favicon.svg` | your icon |

Ready-made prompt for Claude Code (replace the parts in brackets):

```text
Clone https://github.com/Polik9000/agent-command-desk into [~/code/agent-command-desk] and read README.md.
Create local/config.json from config.example.json: app name "[My Desk]", account "[Work]" with config dir
[~/.claude-work] and e-mail [me@example.com], projects [~/code/site, ~/code/app], "interactivePermissions": true.
Create local/theme.css from src/server/wwwroot/theme.css in my brand: colours [#123456 …], fonts [… – bundle
woff2 files in local/ only if their licence allows it], and local/favicon.svg.
Only create files inside local/, do not change anything else and do not commit. Then run npm test and the install script.
```

## How it drives Claude Code
One `claude -p --input-format stream-json --output-format stream-json` process per session, kept for the next message.
The app talks to it with Claude Code's own control requests (interrupt, permission mode, model, context usage, file
rewind, background tasks) and turns its stream into the cards above. Claude Code's task list and file checkpoints are
switched on for these processes. Details: [docs/claude-code-headless.md](docs/claude-code-headless.md).

## Development
```
npm test        # ~120 tests: stream parser, runner with a fake claude (control requests, interrupt, copies), config, settings, git, files, sessions, usage history, permissions, queue, 401/403/CSP
npm run check   # syntax check
ACD_OPEN_BROWSER=0 node src/server/server.mjs   # prints the URL with token on an interactive console
```
No real `claude` is needed for the tests; CI runs them on Windows, macOS and Linux.
Test-only environment variables: `ACD_CONFIG`, `ACD_TOKEN` (≥ 32 chars), `ACD_PORT`, `ACD_OPEN_BROWSER`.
Vendor libraries and optional fonts: `scripts/fetch-vendor.ps1` (pinned versions, see `src/server/wwwroot/vendor/VERSIONS.md`).

## Roadmap
Ideas and feedback welcome – open an issue.

## Uninstall
Windows: `powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1` · macOS: `sh scripts/uninstall.sh`.
Removes the launcher and the state folder; your Claude Code accounts and the repo stay. Delete the repo folder yourself.

## License
[MIT](LICENSE) © 2026 Tobias Otta. Bundled third-party code and fonts keep their own licences.

---

## Česky
Malé lokální okno nad Claude Code, které funguje jako terminál a ukazuje víc: povolené účty a projekty, streamované
odpovědi, karty nástrojů s diffem a karty agentů s živým postupem, vpravo **průběh** (seznam úkolů Clauda, procenta,
odhad času) a **úlohy na pozadí**. Režimy **Auto, Plán, Úpravy, Ručně**; režim i model jde přepnout za běhu. *Zastavit*
přeruší jako Esc, ↶ u zprávy vrátí soubory, ⑂ pokračuje v kopii sezení, *Bokem* položí otázku mimo sezení, v patičce je
zaplnění **kontextu** se *Zhustit*. Během práce lze poslat zprávu hned nebo do fronty; přikládat jde screenshoty
(Ctrl+V), PDF a textové soubory; `/` nabídne příkazy, `@` soubory. Rozhraní je české.

**Nastavení**
1. Každý účet = vlastní složka `CLAUDE_CONFIG_DIR` (alias viz *Setup*), jednou `/login`.
2. `config.example.json` zkopírujte do `local/config.json` a vyplňte účty (včetně očekávaného e-mailu) a projekty.
   Doporučeno `"interactivePermissions": true` – karty svolení, otázky s možnostmi, režim Ručně a Claude in Chrome.
   Volitelně `models` (modely ve výběru), `startFullscreen`, `sessionProcessMinutes`. Projekty (i výchozí) a účty jde
   později spravovat přímo v aplikaci (**Nastavení**); nový účet se použije, až je jeho složka přihlášená zadaným
   e-mailem (tlačítko *Příkaz pro přihlášení*, v terminálu pak `/login`).
3. Vlastní název: `app.name`. Vlastní vzhled: `local/theme.css` (vzor `src/server/wwwroot/theme.css`), ikona
   `local/favicon.svg`. Složka `local/` se nikdy necommituje. Světlý nebo tmavý motiv: **Nastavení → Vzhled**.
4. Spouštěč: Windows `scripts\install.ps1`, macOS `scripts/install.sh`; pak v terminálu příkaz podle `app.id`.
   Novou verzi nebo změnu configu načte aplikace po zavření okna a novém spuštění.

Přehled změn v gitu (klik na větev v hlavičce) umí komentáře k řádkům pro Clauda, **Soubory** hledají a ukazují
soubory projektu, **Přehled sezení** v patičce ukáže upravené soubory, úkoly, agenty a MCP servery, **Statistiky →
Historie a grafy** spotřebu v čase. Po limitu účtu aplikace sama pokračuje po jeho obnovení.

Nebo dejte Claudovi prompt z části *Customize* a nechte ho nastavit všechno za vás.

**Klávesy:** Ctrl+K paleta (příkazy, skilly, agenti, akce, nedávné zprávy), Ctrl+F hledání v konverzaci, Ctrl+Enter
odeslat (během práce = poslat hned), Ctrl+Shift+Enter = do fronty, Enter v seznamu doplní další číslo či odrážku,
Shift+Enter = obyčejný nový řádek, Ctrl+V vloží screenshot jako přílohu, Esc zavře dialog.
