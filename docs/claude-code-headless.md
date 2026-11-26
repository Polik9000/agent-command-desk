# How the app drives Claude Code (headless `-p`)

Verified with Claude Code 2.1.332 on Windows. Sources: real runs and
<https://code.claude.com/docs/en/headless>. A sample stream is in `sample-stream.jsonl` (anonymized; used by tests).

## Command
```
claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages
       --replay-user-messages --permission-mode <auto|plan> --permission-prompts none
       [--resume <session_id>] [--append-system-prompt <text>] [--disallowedTools <tools…>] [--add-dir <attachments>]
```
The prompt is written to stdin as one JSON line `{"type":"user","message":{"role":"user","content":"…"}}`; stdin stays
open until the turn ends. A message written during the turn is picked up at the next tool boundary and answered in the
same turn (verified on 2.1.332); `--replay-user-messages` echoes each accepted message (`type: "user"`, `isReplay: true`),
the first echo being the initial prompt. After `result`, stdin is closed unless an injected message has not been echoed
yet (then Claude answers it as a follow-up turn; a 60 s fallback closes stdin anyway). Environment: `CLAUDE_CONFIG_DIR` from the account allowlist; inherited `CLAUDECODE`,
`CLAUDE_CODE_*`, `CLAUDE_PID` and `ANTHROPIC_*` are removed.

One process per message + `--resume` (no long-lived process): the mode is a start-up flag, Stop simply kills the tree,
and nothing depends on an undocumented control protocol. The cost is a few seconds of start-up per message.

## Events (one JSON object per line, by `type`)
| type / subtype | Fields used | UI |
|---|---|---|
| `system/init` | `session_id`, `cwd`, `model`, `permissionMode`, `claude_code_version` (also `tools`, `slash_commands`, `skills`, `plugins`) | session id, footer |
| `system/api_retry` | `attempt`, `max_retries`, `error` | "retrying" status |
| `stream_event` | `event.type`: `message_start`, `content_block_start` (text/tool_use), `content_block_delta` (`text_delta`) | live text |
| `assistant` | `message.content[]`: `text`, `tool_use {id,name,input}` | final text, tool card |
| `user` | `tool_result {tool_use_id, content, is_error}`, `tool_result_meta[].permission_decision {decision, source, reason_type}` | tool result, denial |
| `rate_limit_event` | `rate_limit_info {status: allowed/allowed_warning/rejected, rateLimitType, resetsAt, unifiedWindows}` | limit banner, offer to switch account |
| `result` | `subtype`, `is_error`, `result`, `total_cost_usd`, `num_turns`, `duration_ms`, `permission_denials[]` | end of run |

`total_cost_usd` is an API-price estimate; on a subscription it is not what you pay.

## Sessions
Transcripts live in `<projectsDirectory>/<cwd with every non-alphanumeric character replaced by "-">/<id>.jsonl`
(`projectsDirectory` comes from `claude auth status --json`). One session must never run in two processes at once.

## Permission modes
- `--permission-prompts none`: anything that would ask is denied automatically, so a run never waits.
- **auto**: the classifier allows or blocks; decisions appear in `tool_result_meta[].permission_decision`, denials in
  `result.permission_denials`.
- **plan**: `ExitPlanMode` and `AskUserQuestion` are not available with `--permission-prompts none`. Claude writes the
  plan to `<configDir>/plans/<slug>.md`; the UI shows it with an **Approve plan** button, which starts
  `--resume <id> --permission-mode auto` with an approval message.
- Claude asks questions as plain text; you answer with the next message.
- Custom commands and skills work by including `/name` in the prompt.
