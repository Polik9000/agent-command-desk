# Security model

Agent Command Desk is a local, single-user app. It runs the **unmodified** `claude` CLI under the user's own
Claude Code login and never reads, copies or stores credentials.

1. **Loopback only.** The server binds to `127.0.0.1`; port from config (`0` = random).
2. **Per-launch token.** 256 random bits on every start, handed to the window in the URL fragment (`#t=…`, never sent
   in `Referer` or server logs). The page moves it into memory and strips it from the URL. Every `/api/*` request must
   carry `X-ACD-Token` (constant-time comparison), otherwise **401**. The token is never written to disk.
3. **Host check.** `Host` must be `127.0.0.1:<port>` or `localhost:<port>`, otherwise **403** (DNS rebinding).
4. **Origin check.** For non-GET/HEAD requests `Origin` is required and must equal the local origin; for GET it must
   match if present. `Sec-Fetch-Site` other than `same-origin`/`none` → **403**. No CORS headers.
5. **Headers.** Strict CSP (`default-src 'self'`, no inline scripts, `connect-src 'self'`, `img-src 'self' data:`,
   `object-src 'none'`, `frame-ancestors 'none'`), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
   `X-Frame-Options: DENY`, `Cache-Control: no-store`.
6. **Spawning `claude`.** Absolute path to the executable (on Windows only `.exe`; `.cmd`/`.bat` are rejected), argument
   array with `shell: false`, prompt via stdin. Permission mode is only `auto` or `plan` (with `interactivePermissions`
   also `default`, see 19), validated on the server; without `interactivePermissions` always `--permission-prompts none`; `bypassPermissions` and `--dangerously-skip-permissions` are never used.
   `CLAUDE*` and `ANTHROPIC_*` variables are removed from the child environment and `CLAUDE_CONFIG_DIR` is set from the
   allowlist. Stop kills the whole process tree (`taskkill /T /F` on Windows, process group on macOS/Linux).
7. **Allowlists.** Working directory only from `projects`, `CLAUDE_CONFIG_DIR` only from `accounts`; the client sends
   ids only. Each account has `expectedEmail`; the server checks `claude auth status --json` (email, config directory,
   sessions directory) and disables the account on any mismatch, so an unlisted account (e.g. a personal one) cannot be
   used even by mistake.
8. **Resume** only for sessions whose transcript exists in the selected account's and project's directory.
9. **No network.** The app itself calls no external services; vendor libraries and fonts are bundled; no telemetry.
10. **Rendering.** Claude's output goes through `marked` + `DOMPurify`.
11. **Logs** only in the app state directory, without prompt contents.
12. **Local files.** `local/` (your config, theme, icon) is git-ignored. Only `local/theme.css` and `local/favicon.svg`
    can ever be served; `local/config.json` never is.
13. **Token on the browser command line.** The window is opened with `--app=http://127.0.0.1:<port>/#t=<token>`.
    Only processes of the same OS user can read it (they could read the page memory anyway); it is valid until the app exits.
14. **Attachments.** Upload requires token + Origin like any other write; the account and project must be in the
    allowlist. Only listed extensions, checked against the file signature (text: no NUL bytes); size limits per type;
    the file name is reduced to its last segment without reserved characters. Stored in
    `<state>/attachments/<account>/<project>/<random id>/`; a run accepts only ids from the same account and project and
    gets `--add-dir` for that folder only. Old uploads are deleted after 7 days.
15. **Single instance** per user via a pid file in the state directory.
16. **Settings writes.** The only thing the UI can change in the config is the list of **projects** (add, rename,
    remove) – there is no endpoint for accounts, so the account allowlist with `expectedEmail` stays hand-edited only.
    Writes need token + Origin like any other write. A new project folder must be an existing directory given as a full
    path (symlinks resolved); drive roots, the home folder (and its parents), Claude Code account folders and the app
    state folder (in either direction) are refused, as are duplicates. A project with a running `claude` cannot be
    removed. The whole new config is validated with the same code as at start-up before it is written; the file is
    written atomically (temp file + rename) and the previous version is kept as `config.json.bak`.
17. **Git view is read-only.** Only `status` and `diff` are run (argument array, no shell, `GIT_OPTIONAL_LOCKS=0`,
    `core.fsmonitor=false`, `--no-ext-diff --no-textconv`), always in an allowlisted project. A diff is returned only
    for a path that the current `git status` lists, in an area it is listed in; anything else is 400/404. New
    (untracked) files are read directly only if they are regular files up to 256 kB without NUL bytes; symlinks are
    not followed. Output is capped at 1 MB. There is no endpoint that stages, commits, checks out or pushes.
18. **Session search** reads only transcripts of the selected (verified) account and allowlisted project – the 50 most
    recent, each up to 32 MB – and only user/assistant text (no tool input, meta or sub-agent messages); the query is
    2–100 characters. Custom session names live in the browser profile of the app window; transcripts are never written.
19. **Permission requests (optional).** Off by default (`--permission-prompts none`: anything that would ask is
    denied). With `"interactivePermissions": true` the app passes `--permission-prompts host --permission-prompt-tool
    stdio`; Claude Code then sends `control_request can_use_tool` on stdout and waits. The window shows the tool and
    command/path; the client sends only the request id and *once*, *always* or *deny*
    (`POST /api/runs/:id/permission`, token + Origin). The tool input sent back is always the server's copy. *Always*
    applies only Claude Code's own `addRules` suggestions with `behavior: allow` and `destination: localSettings`
    (the project's `.claude/settings.local.json`, same as the terminal); `setMode` (e.g. acceptEdits),
    `addDirectories` and any other destination are never applied, so the permission mode stays what the user picked.
    Only with this option the composer offers a third mode *Ručně* = Claude Code's `default` mode (asks before every
    edit and command; stricter than `auto`). Without the option the server rejects `default` (400), since everything
    would be denied anyway. `acceptEdits`, `dontAsk` and `bypassPermissions` are never accepted.
    No answer within 10 minutes, Stop or closing the window = deny. Other control requests get an error reply.
20. **Waiting processes.** After a reply the `claude` process may wait for the next message of the same session
    (`sessionProcessMinutes`, default 10, max 3 processes). It is reused only for the same account, project, mode,
    model, effort and directories, and only if its last `init` reported the requested permission mode and the turn did
    not use `ExitPlanMode`/`EnterPlanMode`; a reused process reporting another mode is stopped and its output dropped.
    A waiting process gets no input; a permission request arriving without a run is denied. Removing a project,
    closing the app or the window timeout closes waiting processes; if the server dies, stdin closes and `claude` exits.
21. **Project files are read-only.** `GET /api/projects/:id/files` lists `git ls-files --cached --others
    --exclude-standard` (nothing ignored by `.gitignore`); outside git (or when the folder is ignored by a parent repo)
    a breadth-first walk without symlinks, skipping `.git`, `node_modules`, build and cache folders (max 20 000 files,
    depth 12). `GET /api/projects/:id/file?path=` reads a file only if the relative path is in the current list
    (no `..`, no absolute paths), its real path (symlinks resolved) is inside the project, it is at most 512 kB and has
    no NUL bytes. Names that look like secrets (`.env*` except examples, `*.pem`, `*.key`, `id_rsa`, `.npmrc`,
    `.credentials.json`, `secrets.*` …) are never returned. Nothing is written.
22. **Session overview is read-only.** `GET /api/sessions/:id/overview` (verified account, allowlisted project, session id
    must be a UUID whose transcript exists) reads that transcript and, if present, the session's subagent transcripts
    (`<id>/subagents/agent-*.jsonl`, at most 40, each ≤ 32 MB) plus their `*.meta.json` (only `toolUseId` and
    `finished` are used). It returns file paths from Edit/Write tool calls, agent descriptions, the last TodoWrite list
    and tool counts – no tool outputs and no message texts. **MCP state** comes only from Claude Code's `init` event
    (name, status, source); the app never reads MCP or account configuration. Diff comments and find stay in the
    window's memory.
