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
   array with `shell: false`, prompt via stdin. Permission mode is only `auto` or `plan`, always with
   `--permission-prompts none`; `bypassPermissions` and `--dangerously-skip-permissions` are never used.
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
14. **Single instance** per user via a pid file in the state directory.
