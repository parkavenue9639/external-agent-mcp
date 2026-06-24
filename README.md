# external-agent-mcp

Local stdio MCP bridge that lets Codex call installed external CLI coding agents
for bounded read-only code analysis and deterministic quality fixes.

This first version supports:

- Cursor Agent via `/usr/local/bin/cursor agent --print --mode=plan`
- Gemini CLI via `/opt/homebrew/bin/gemini --prompt ... --approval-mode plan`
- Claude Code via `/opt/homebrew/bin/claude --print --permission-mode plan`

The server is dependency-free Node.js and speaks MCP over line-delimited
JSON-RPC on stdio.

## Tools

### `analyze_code`

Runs one external provider against a repository path and returns a structured
JSON payload containing command metadata, exit status, bounded stdout, and
bounded stderr.

Required arguments:

- `provider`: `cursor`, `gemini`, or `claude`
- `repo_path`: absolute path to the repository/workspace
- `task`: concrete read-only code analysis task

Optional arguments:

- `files`: focus files; repo-relative or absolute paths under `repo_path`
- `extra_context`: additional instructions
- `model`: provider-specific model override
- `timeout_sec`: defaults to `600`, capped at `1800`
- `max_output_chars`: defaults to `30000`, capped at `100000`
- `include_stderr`: defaults to `true`

### `agent_status`

Checks configured provider binaries with version commands. It does not run an
analysis prompt.

### `quality_fix`

Runs allow-listed deterministic quality commands over a bounded file set.
This is intended for mechanical fixes that should not spend LLM tokens.

Default commands:

- `ruff_format`: `ruff format <files>`
- `ruff_safe_fix`: `ruff check --fix <files>`

Additional commands:

- `ruff_check`: `ruff check <files>`
- `ruff_unsafe_fix`: `ruff check --fix --unsafe-fixes <files>`; requires
  `allow_unsafe_fixes: true`

Required arguments:

- `repo_path`: absolute path to the git repository/workspace

Optional arguments:

- `files`: repo-relative or absolute files to fix; required unless
  `allow_repo_wide` is true
- `commands`: defaults to `["ruff_format", "ruff_safe_fix"]`
- `allow_repo_wide`: allows target `.`; defaults to `false`
- `allow_unsafe_fixes`: required for `ruff_unsafe_fix`; defaults to `false`
- `timeout_sec`: per-command timeout; defaults to `120`, capped at `900`
- `max_output_chars`: per-command output cap; defaults to `30000`
- `max_changed_files`: maximum newly dirty files; defaults to `20`
- `include_diff_stat`: defaults to `true`

The result includes command outputs, before/after git status paths, newly dirty
files, out-of-scope newly dirty files, safety errors, and optional diff stat.

## Codex config

Add this to `~/.codex/config.toml` or a trusted project `.codex/config.toml`:

```toml
[mcp_servers.external_agent]
command = "node"
args = ["/Users/luchong/OpenSourceProject/external-agent-mcp/src/server.mjs"]
startup_timeout_sec = 10
tool_timeout_sec = 900

[mcp_servers.external_agent.env]
EXTERNAL_AGENT_ALLOWED_ROOTS = "/Users/luchong/Desktop:/Users/luchong/OpenSourceProject"
```

Optional binary overrides:

```toml
[mcp_servers.external_agent.env]
CURSOR_AGENT_BIN = "/usr/local/bin/cursor"
GEMINI_BIN = "/opt/homebrew/bin/gemini"
CLAUDE_BIN = "/opt/homebrew/bin/claude"
RUFF_BIN = "ruff"
EXTERNAL_AGENT_ALLOWED_ROOTS = "/Users/luchong/Desktop:/Users/luchong/OpenSourceProject"
```

After changing MCP config, refresh/restart Codex or start a new thread so the
new tool surface is loaded.

## Manual test

```bash
npm test
```

## Example tool arguments

### External analysis

```json
{
  "provider": "gemini",
  "repo_path": "/Users/luchong/Desktop/Agnes_Core",
  "task": "Analyze the stream cancellation implementation. Focus on correctness, structured error propagation, and missing tests.",
  "files": [
    "kw-agent-service/path/to/file.py"
  ],
  "timeout_sec": 900,
  "max_output_chars": 40000
}
```

### Deterministic Ruff fix

```json
{
  "repo_path": "/Users/luchong/Desktop/Agnes_Core",
  "files": [
    "kw-agent-service/path/to/file.py"
  ],
  "commands": [
    "ruff_format",
    "ruff_safe_fix"
  ],
  "timeout_sec": 120,
  "max_changed_files": 10
}
```

## Safety notes

- The bridge uses `child_process.spawn` with argv arrays, not shell command
  strings.
- Read-only provider modes are hardcoded for normal analysis calls.
- `quality_fix` requires a git repository so it can report before/after changed
  files and flag unexpected newly dirty files.
- `quality_fix` requires explicit files by default; repo-wide `.` runs require
  `allow_repo_wide: true`.
- `EXTERNAL_AGENT_ALLOWED_ROOTS` is strongly recommended. If it is unset, the
  bridge allows any existing absolute directory passed by the MCP caller.
- The bridge does not pass `--yolo`, `--force`, or equivalent write-friendly
  flags.
