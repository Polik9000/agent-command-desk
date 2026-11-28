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
the first echo being the initial prompt. After `result`, if an injected message has not been echoed yet, Claude answers
it as a follow-up turn of the same run (a 60 s fallback closes stdin). Otherwise the turn ends and the process is kept
waiting with stdin open (see below). Environment: `CLAUDE_CONFIG_DIR` from the account allowlist; inherited `CLAUDECODE`,
`CLAUDE_CODE_*`, `CLAUDE_PID` and `ANTHROPIC_*` are removed.

**Process per session.** One process can take several turns: each further user line on stdin starts a new turn
(a new `system/init` with the same `session_id`, then replay, messages and `result`). Measured on 2.1.332: a message
to a waiting process answers in ~0.8 s, a new process with `--resume` in ~2.5–3 s. So after a successful `result`
the process waits (`sessionProcessMinutes`, default 10, at most 3 waiting processes, oldest closed first). The next
message to the same session with the same account, project, mode, model, effort and directories is written to it;
anything else closes the waiting process (end of stdin) and starts a new one with `--resume`, since mode, model and
effort are start-up flags. The process is kept only if the last `init` reported the requested `permissionMode` and the
turn used no `ExitPlanMode`/`EnterPlanMode`; a reused process whose `init` reports another mode is stopped. Errors,
Stop and `sessionProcessMinutes: 0` mean a new process next time. If the app dies, stdin closes and `claude` exits.

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

## Optional permission requests (`interactivePermissions`)
Verified on 2.1.332: with `--permission-prompts host --permission-prompt-tool stdio` (no `initialize` request needed)
Claude Code writes `{"type":"control_request","request_id":…,"request":{"subtype":"can_use_tool","tool_name",
"display_name","input","description","permission_suggestions":[…],"blocked_path","tool_use_id"}}` and waits for
`{"type":"control_response","response":{"subtype":"success","request_id":…,"response":{"behavior":"allow",
"updatedInput":…,"updatedPermissions":[…]}}}` or `{"behavior":"deny","message":…}` on stdin. Suggestions seen:
`addRules` (`destination: localSettings` → written to `<project>/.claude/settings.local.json`), `addDirectories` and
`setMode acceptEdits` (session); the app applies only `addRules`. Without `--permission-prompt-tool stdio` nothing is
asked and everything is denied as with `none`. In `auto` mode the classifier decides almost everything itself; in
`plan` mode Claude refuses edits on its own, so requests are rare in this app.

## Control requests from the app (verified on Claude Code 2.1.332)
The host writes `{"type":"control_request","request_id":"…","request":{"subtype":…}}` lines to stdin; Claude Code
answers with `{"type":"control_response","response":{"subtype":"success"|"error","request_id":"…","response":{…}}}`.
None of these calls the model.

| Subtype | Payload | Used for |
|---|---|---|
| `initialize` | – | commands and skills with descriptions and argument hints, agents (account data in the answer is dropped) |
| `interrupt` | – | *Zastavit* = Esc: the turn ends with an error result (`terminal_reason: aborted_tools`), the process stays usable |
| `set_permission_mode` | `mode` | mode switch while working or when reusing a waiting process (a `system/status` event confirms it) |
| `set_model` | `model` | model switch while working or when reusing a waiting process |
| `get_context_usage` | – | footer *Kontext*: percentage, tokens, categories |
| `rewind_files` | `user_message_id`, `dry_run` | ↶ rewind: list of files first, then the real rewind |
| `stop_task` | `task_id` | *Zastavit* in *Na pozadí* |
| `background_tasks`, `mcp_status`, `get_settings` | – | available, not used by the UI (`mcp_status` and `get_settings` return configuration, so the app does not call them) |

**Ordering.** Replies are handled while the stdout line is parsed, in stream order (not in a promise callback):
readline emits every line of a chunk synchronously, so a reply handled later could be overtaken by the `result` of the
same chunk. The `initialize` reply of a new process therefore reaches the first turn as a `commands` event before its
`init`. A run also holds its `event`/`end` emits until the first `event` listener attaches (or `run.release()` is
called), so the server's SSE stream never misses events that arrived before it subscribed.

`supported_commands` is not supported (use `initialize`). A session without a running process gets a short
`claude -p --resume <id> --permission-mode plan --permission-prompts none` process for these requests (no message for
the model), closed right after.

Environment for run processes: `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` (TaskCreate / TaskUpdate → *Průběh*) and
`CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=1` (file checkpoints for rewind). Extra flags: `--forward-subagent-text`
(agent text in the agent card), `--fork-session` (copy), `--fork-session --no-session-persistence` (side question; `/btw`
answers "isn't available in this environment" in this mode), `--chrome --settings '{"permissions":{"ask":["mcp__claude-in-chrome"]}}'`.
Local slash commands such as `/rename <name>`, `/context` and `/compact` work as user messages (`/rename` and `/context`
cost no tokens). Thinking blocks arrive empty (signature only), so the app does not show thinking.

Events used besides assistant/user/result: `system/task_started|task_progress|task_updated|task_notification`
(agents and background commands), `system/background_tasks_changed`, `system/session_title_changed`, `system/status`
(`permissionMode`), `user` replays with `uuid` (needed for rewind). `total_cost_usd` in `result` is the sum for the whole
process, so the app subtracts the previous value to get the cost of one turn.
