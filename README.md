# external-agent-mcp

Local stdio MCP runtime that lets Codex delegate work to installed external CLI
coding agents. Codex starts asynchronous jobs through one MCP call, then polls
for status, free-form results, logs, and sandbox patch artifacts.

The server is dependency-free Node.js and speaks MCP over line-delimited
JSON-RPC on stdio.

## Providers

Initial provider adapters:

- Cursor Agent via `CURSOR_AGENT_BIN`
- Gemini CLI via `GEMINI_BIN`
- Claude Code via `CLAUDE_BIN`

Model selection is caller-controlled with the `model` argument. The MCP server
does not hardcode routing logic such as "simple task uses X, complex task uses
Y".

## Tools

### `delegate_tasks`

Creates one or more async jobs.

Required arguments:

- `repo_path`: absolute repository/workspace path
- `provider`: `cursor`, `gemini`, or `claude`
- `tasks`: array of task strings or task objects

Common optional arguments:

- `mode`: `analysis` or `sandbox_patch`; defaults to `analysis`
- `model`: provider-specific model override
- `files`: focus files under `repo_path`
- `extra_context`: additional background
- `timeout_sec`: defaults to `600`, capped at `1800`
- `max_output_chars`: defaults to `30000`, capped at `100000`
- `base_ref`: git ref for `sandbox_patch`; defaults to `HEAD`

Task objects may override `provider`, `model`, `mode`, `files`,
`extra_context`, `timeout_sec`, `max_output_chars`, and `base_ref`.

### `job_status`

Returns job lifecycle state and stdout/stderr tails. Status values are:

- `queued`
- `running`
- `succeeded`
- `failed`
- `timed_out`
- `cancelled`
- `orphaned`

If no `job_id` or `job_ids` are supplied, recent jobs are returned.

### `job_result`

Returns the external agent's free-form result text plus MCP-managed metadata:

- command metadata and exit status
- stdout/stderr log paths
- `result.md`
- `diff.patch`, `diff.stat`, and changed files for `sandbox_patch`

### `search_jobs`

Searches historical jobs by lightweight metadata and previews. This is the
stable history lookup interface; full text and patch artifacts should still be
read with `job_result`.

Supported filters:

- `repo_path`: exact repository path
- `provider`: `cursor`, `gemini`, or `claude`
- `model`: exact model string
- `mode`: `analysis` or `sandbox_patch`
- `status`: any of `queued`, `running`, `succeeded`, `failed`, `timed_out`,
  `cancelled`, or `orphaned`
- `created_after` / `created_before`: ISO timestamps
- `query`: case-insensitive substring search over title, task, result preview,
  paths, provider/model/mode, and focused files
- `limit`: defaults to `20`, capped at `100`
- `cursor`: opaque pagination cursor from a previous response

The response returns job summaries, previews, hashes, and artifact paths. It
does not return large stdout, stderr, result, or patch bodies.

### `cancel_jobs`

Cancels queued or running jobs.

### `cleanup_jobs`

Removes terminal job logs/artifacts and associated sandbox worktrees. Use
`force: true` only when cleaning non-terminal jobs intentionally.

### `agent_status`

Checks provider binaries and reports capability metadata:

- `supports_analysis`
- `supports_sandbox_patch`
- `supports_models`
- `safe_write_mode`

### `quality_fix`

Runs allow-listed deterministic quality commands over a bounded file set. This
path is for mechanical fixes and does not spend LLM agent tokens.

Default commands:

- `ruff_format`: `ruff format <files>`
- `ruff_safe_fix`: `ruff check --fix <files>`

Additional commands:

- `ruff_check`: `ruff check <files>`
- `ruff_unsafe_fix`: `ruff check --fix --unsafe-fixes <files>`; requires
  `allow_unsafe_fixes: true`

## Job Storage

Jobs are persisted under:

```text
~/.cache/external-agent-mcp/jobs
```

Override with:

```text
EXTERNAL_AGENT_JOB_ROOT=/path/to/jobs
```

Each job directory contains:

- `job.json`
- `events.jsonl`
- `stdout.log`
- `stderr.log`
- `result.md`
- `diff.patch`
- `diff.stat`

If the MCP server restarts, non-terminal jobs from the previous process are
marked `orphaned`. Completed job artifacts remain readable.

The current storage implementation is `FileJobStore`: metadata is read from
`job.json`, events are appended to `events.jsonl`, and large artifacts remain as
plain files. `search_jobs` is intentionally defined above this storage layer so
a future SQLite-backed index can replace the file scan without changing the MCP
tool contract.

New jobs include stable metadata for history and future caching:

- `schema_version`
- `repo_head`
- `task_hash`
- `prompt_hash`
- `duration_ms`
- `result_preview`

## Sandbox Patch Mode

`mode: "sandbox_patch"` requires a git repository. The server creates an
isolated git worktree under the job directory, runs the external agent there,
and then captures `git diff --binary` and `git diff --stat`.

The original repository is not modified by agent writes.

Provider write policy is conservative:

- Cursor sandbox patch is marked experimental and is launched without
  `--force` or `--yolo`.
- Gemini uses `--approval-mode auto_edit`.
- Claude uses `--permission-mode acceptEdits` with a restricted tool list.
- The server rejects adapter commands that include `--force`, `--yolo`, or
  bypass-permission flags.

## Codex Config

Add this to `~/.codex/config.toml` or a trusted project `.codex/config.toml`:

```toml
[mcp_servers.external_agent]
command = "node"
args = ["/path/to/external-agent-mcp/src/server.mjs"]
startup_timeout_sec = 10
tool_timeout_sec = 900

[mcp_servers.external_agent.env]
CURSOR_AGENT_BIN = "/path/to/cursor"
GEMINI_BIN = "/path/to/gemini"
CLAUDE_BIN = "/path/to/claude"
RUFF_BIN = "ruff"
EXTERNAL_AGENT_ALLOWED_ROOTS = "/path/to/workspace:/path/to/another-workspace"
EXTERNAL_AGENT_MAX_CONCURRENCY = "2"
```

After changing MCP config, refresh/restart Codex or start a new thread so the
new tool surface is loaded.

## Examples

### Parallel Analysis

```json
{
  "provider": "cursor",
  "model": "your-model-name",
  "repo_path": "/path/to/your-repo",
  "mode": "analysis",
  "tasks": [
    "Map the request lifecycle from the API handler to the service layer. Return concise findings with file paths.",
    "Audit authentication and permission boundaries. Return risks and missing tests."
  ],
  "timeout_sec": 900
}
```

### Sandbox Patch

```json
{
  "provider": "claude",
  "repo_path": "/path/to/your-repo",
  "mode": "sandbox_patch",
  "tasks": [
    {
      "task": "Fix the focused Ruff SIM102 issue and summarize the patch.",
      "files": ["src/example/path.py"]
    }
  ]
}
```

Then call `job_status` until terminal and `job_result` to inspect the free-form
result, logs, and patch path.

### Search History

```json
{
  "repo_path": "/path/to/your-repo",
  "provider": "cursor",
  "model": "your-model-name",
  "mode": "analysis",
  "status": ["succeeded", "failed"],
  "query": "request lifecycle",
  "limit": 20
}
```

### Deterministic Ruff Fix

```json
{
  "repo_path": "/path/to/your-repo",
  "files": ["src/example/path.py"],
  "commands": ["ruff_format", "ruff_safe_fix"],
  "timeout_sec": 120,
  "max_changed_files": 10
}
```

## Manual Test

```bash
npm test
```
