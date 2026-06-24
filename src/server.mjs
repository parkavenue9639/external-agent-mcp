#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const SERVER_NAME = "external-agent-mcp";
const SERVER_VERSION = "0.2.0";

const PROVIDERS = {
  cursor: {
    displayName: "Cursor Agent",
    binaryEnv: "CURSOR_AGENT_BIN",
    defaultBinary: "/usr/local/bin/cursor",
    versionArgs: ["agent", "--version"],
    buildArgs: ({ prompt, repoPath, model }) => {
      const args = [
        "agent",
        "--print",
        "--mode=plan",
        "--trust",
        "--workspace",
        repoPath,
        "--output-format",
        "text",
      ];
      if (model) {
        args.push("--model", model);
      }
      args.push(prompt);
      return args;
    },
  },
  gemini: {
    displayName: "Gemini CLI",
    binaryEnv: "GEMINI_BIN",
    defaultBinary: "/opt/homebrew/bin/gemini",
    versionArgs: ["--version"],
    buildArgs: ({ prompt, model }) => {
      const args = [
        "--prompt",
        prompt,
        "--approval-mode",
        "plan",
        "--skip-trust",
        "--output-format",
        "text",
      ];
      if (model) {
        args.push("--model", model);
      }
      return args;
    },
  },
  claude: {
    displayName: "Claude Code",
    binaryEnv: "CLAUDE_BIN",
    defaultBinary: "/opt/homebrew/bin/claude",
    versionArgs: ["--version"],
    buildArgs: ({ prompt, model }) => {
      const args = [
        "--print",
        "--permission-mode",
        "plan",
        "--output-format",
        "text",
      ];
      if (model) {
        args.push("--model", model);
      }
      args.push(prompt);
      return args;
    },
  },
};

const JSON_RPC_VERSION = "2.0";
const DEFAULT_TIMEOUT_SEC = 600;
const MAX_TIMEOUT_SEC = 1800;
const DEFAULT_MAX_OUTPUT_CHARS = 30000;
const MAX_OUTPUT_CHARS = 100000;
const DEFAULT_QUALITY_TIMEOUT_SEC = 120;
const MAX_QUALITY_TIMEOUT_SEC = 900;
const DEFAULT_MAX_CHANGED_FILES = 20;
const MAX_CHANGED_FILES = 200;

const QUALITY_COMMANDS = {
  ruff_format: {
    displayName: "ruff format",
    binaryEnv: "RUFF_BIN",
    defaultBinary: "ruff",
    buildArgs: ({ targets }) => ["format", ...targets],
  },
  ruff_safe_fix: {
    displayName: "ruff check --fix",
    binaryEnv: "RUFF_BIN",
    defaultBinary: "ruff",
    buildArgs: ({ targets }) => ["check", "--fix", ...targets],
  },
  ruff_unsafe_fix: {
    displayName: "ruff check --fix --unsafe-fixes",
    binaryEnv: "RUFF_BIN",
    defaultBinary: "ruff",
    requiresUnsafe: true,
    buildArgs: ({ targets }) => ["check", "--fix", "--unsafe-fixes", ...targets],
  },
  ruff_check: {
    displayName: "ruff check",
    binaryEnv: "RUFF_BIN",
    defaultBinary: "ruff",
    readOnly: true,
    buildArgs: ({ targets }) => ["check", ...targets],
  },
};

const tools = [
  {
    name: "analyze_code",
    description:
      "Invoke a local external CLI coding agent in read-only mode to analyze code and return a bounded summary.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["provider", "repo_path", "task"],
      properties: {
        provider: {
          type: "string",
          enum: Object.keys(PROVIDERS),
          description: "External agent CLI to invoke.",
        },
        repo_path: {
          type: "string",
          description: "Absolute path to the repository or workspace to analyze.",
        },
        task: {
          type: "string",
          description: "Concrete read-only code analysis task for the external agent.",
        },
        files: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional repo-relative or absolute file paths to focus the analysis on. Absolute paths must stay under repo_path.",
        },
        extra_context: {
          type: "string",
          description: "Optional extra constraints or background for the analysis.",
        },
        model: {
          type: "string",
          description: "Optional provider-specific model override.",
        },
        timeout_sec: {
          type: "number",
          description: `Timeout in seconds. Defaults to ${DEFAULT_TIMEOUT_SEC}; capped at ${MAX_TIMEOUT_SEC}.`,
        },
        max_output_chars: {
          type: "number",
          description: `Maximum stdout/stderr characters returned. Defaults to ${DEFAULT_MAX_OUTPUT_CHARS}; capped at ${MAX_OUTPUT_CHARS}.`,
        },
        include_stderr: {
          type: "boolean",
          description: "Include stderr in the returned JSON payload. Defaults to true.",
        },
      },
    },
  },
  {
    name: "agent_status",
    description:
      "Check which external CLI agent binaries are configured and callable without running an analysis prompt.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        provider: {
          type: "string",
          enum: Object.keys(PROVIDERS),
          description: "Optional provider to check. If omitted, all providers are checked.",
        },
        timeout_sec: {
          type: "number",
          description: "Per-provider timeout in seconds. Defaults to 10.",
        },
      },
    },
  },
  {
    name: "quality_fix",
    description:
      "Run deterministic allow-listed quality commands such as Ruff format and safe fixes over a bounded file set.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["repo_path"],
      properties: {
        repo_path: {
          type: "string",
          description: "Absolute path to the repository/workspace.",
        },
        files: {
          type: "array",
          items: { type: "string" },
          description:
            "Repo-relative or absolute files to fix. Required unless allow_repo_wide is true.",
        },
        commands: {
          type: "array",
          items: {
            type: "string",
            enum: Object.keys(QUALITY_COMMANDS),
          },
          description:
            "Quality commands to run. Defaults to ruff_format and ruff_safe_fix.",
        },
        allow_repo_wide: {
          type: "boolean",
          description: "Allow running commands over the whole repo with target '.'. Defaults to false.",
        },
        allow_unsafe_fixes: {
          type: "boolean",
          description:
            "Required to run ruff_unsafe_fix. Defaults to false.",
        },
        timeout_sec: {
          type: "number",
          description: `Per-command timeout in seconds. Defaults to ${DEFAULT_QUALITY_TIMEOUT_SEC}; capped at ${MAX_QUALITY_TIMEOUT_SEC}.`,
        },
        max_output_chars: {
          type: "number",
          description: `Maximum stdout/stderr characters per command. Defaults to ${DEFAULT_MAX_OUTPUT_CHARS}; capped at ${MAX_OUTPUT_CHARS}.`,
        },
        max_changed_files: {
          type: "number",
          description: `Maximum newly dirty files allowed. Defaults to ${DEFAULT_MAX_CHANGED_FILES}; capped at ${MAX_CHANGED_FILES}.`,
        },
        include_diff_stat: {
          type: "boolean",
          description: "Include git diff --stat after commands. Defaults to true.",
        },
      },
    },
  },
];

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", async (line) => {
  if (!line.trim()) {
    return;
  }

  let request;
  try {
    request = JSON.parse(line);
  } catch (error) {
    writeError(null, -32700, `Parse error: ${error.message}`);
    return;
  }

  if (!("id" in request)) {
    handleNotification(request);
    return;
  }

  try {
    const result = await handleRequest(request);
    writeResponse(request.id, result);
  } catch (error) {
    const code = Number.isInteger(error.code) ? error.code : -32603;
    writeError(request.id, code, error.message, error.data);
  }
});

rl.on("close", () => {
  process.exit(0);
});

async function handleRequest(request) {
  switch (request.method) {
    case "initialize": {
      const protocolVersion = request.params?.protocolVersion ?? "2024-11-05";
      return {
        protocolVersion,
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: SERVER_NAME,
          version: SERVER_VERSION,
        },
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return { tools };
    case "tools/call":
      return callTool(request.params);
    case "resources/list":
      return { resources: [] };
    case "prompts/list":
      return { prompts: [] };
    default:
      throw rpcError(-32601, `Method not found: ${request.method}`);
  }
}

function handleNotification(request) {
  if (request.method === "notifications/initialized") {
    return;
  }
  log(`ignored notification: ${request.method ?? "unknown"}`);
}

async function callTool(params) {
  const name = params?.name;
  const args = params?.arguments ?? {};

  switch (name) {
    case "analyze_code":
      return toolResult(await analyzeCode(args));
    case "agent_status":
      return toolResult(await agentStatus(args));
    case "quality_fix":
      return toolResult(await qualityFix(args));
    default:
      return toolResult({ error: `Unknown tool: ${name}` }, true);
  }
}

async function analyzeCode(args) {
  const providerName = requireProvider(args.provider);
  const provider = PROVIDERS[providerName];
  const repoPath = validateRepoPath(args.repo_path);
  const files = validateFiles(repoPath, args.files ?? []);
  const task = requireNonEmptyString(args.task, "task");
  const extraContext = optionalString(args.extra_context, "extra_context");
  const model = optionalString(args.model, "model");
  const timeoutSec = boundedNumber(args.timeout_sec, DEFAULT_TIMEOUT_SEC, 1, MAX_TIMEOUT_SEC, "timeout_sec");
  const maxOutputChars = boundedNumber(
    args.max_output_chars,
    DEFAULT_MAX_OUTPUT_CHARS,
    1000,
    MAX_OUTPUT_CHARS,
    "max_output_chars",
  );
  const includeStderr = args.include_stderr !== false;
  const binary = resolveProviderBinary(provider);
  const prompt = buildReadOnlyPrompt({ providerName, repoPath, task, files, extraContext });
  const commandArgs = provider.buildArgs({ prompt, repoPath, model });

  const startedAt = new Date().toISOString();
  const result = await runCommand({
    command: binary,
    args: commandArgs,
    cwd: repoPath,
    timeoutMs: timeoutSec * 1000,
    maxChars: maxOutputChars,
  });

  return {
    provider: providerName,
    command: redactCommand(binary, commandArgs),
    cwd: repoPath,
    readonly: true,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    exit_code: result.exitCode,
    signal: result.signal,
    timed_out: result.timedOut,
    stdout: result.stdout,
    stdout_truncated: result.stdoutTruncated,
    stderr: includeStderr ? result.stderr : undefined,
    stderr_truncated: includeStderr ? result.stderrTruncated : undefined,
  };
}

async function agentStatus(args) {
  const providerNames = args.provider ? [requireProvider(args.provider)] : Object.keys(PROVIDERS);
  const timeoutSec = boundedNumber(args.timeout_sec, 10, 1, 60, "timeout_sec");
  const checks = {};

  for (const providerName of providerNames) {
    const provider = PROVIDERS[providerName];
    const binary = resolveProviderBinary(provider);
    const exists = fs.existsSync(binary);
    let version = null;
    let error = null;
    let exitCode = null;

    if (exists) {
      try {
        const result = await runCommand({
          command: binary,
          args: provider.versionArgs,
          cwd: process.cwd(),
          timeoutMs: timeoutSec * 1000,
          maxChars: 8000,
        });
        version = firstNonEmptyLine(result.stdout) ?? firstNonEmptyLine(result.stderr);
        exitCode = result.exitCode;
        if (result.timedOut) {
          error = "version command timed out";
        } else if (result.exitCode !== 0) {
          error = `version command exited with ${result.exitCode}`;
        }
      } catch (caught) {
        error = caught.message;
      }
    }

    checks[providerName] = {
      display_name: provider.displayName,
      binary,
      exists,
      exit_code: exitCode,
      version,
      error,
      readonly_args:
        providerName === "cursor"
          ? ["agent", "--print", "--mode=plan", "--trust", "--workspace", "<repo>", "--output-format", "text"]
          : providerName === "gemini"
            ? ["--prompt", "<prompt>", "--approval-mode", "plan", "--skip-trust", "--output-format", "text"]
            : ["--print", "--permission-mode", "plan", "--output-format", "text"],
    };
  }

  return {
    server: SERVER_NAME,
    allowed_roots: allowedRoots(),
    providers: checks,
  };
}

async function qualityFix(args) {
  const repoPath = validateRepoPath(args.repo_path);
  const gitRoot = await requireGitRoot(repoPath);
  const commandNames = validateQualityCommands(args.commands ?? ["ruff_format", "ruff_safe_fix"], args);
  const files = validateQualityFiles(repoPath, args.files ?? [], args.allow_repo_wide === true);
  const targets = files.length ? files.map((file) => path.relative(repoPath, file)) : ["."];
  const timeoutSec = boundedNumber(
    args.timeout_sec,
    DEFAULT_QUALITY_TIMEOUT_SEC,
    1,
    MAX_QUALITY_TIMEOUT_SEC,
    "timeout_sec",
  );
  const maxOutputChars = boundedNumber(
    args.max_output_chars,
    DEFAULT_MAX_OUTPUT_CHARS,
    1000,
    MAX_OUTPUT_CHARS,
    "max_output_chars",
  );
  const maxChangedFiles = boundedNumber(
    args.max_changed_files,
    DEFAULT_MAX_CHANGED_FILES,
    1,
    MAX_CHANGED_FILES,
    "max_changed_files",
  );
  const includeDiffStat = args.include_diff_stat !== false;
  const beforeStatus = await gitStatus(gitRoot);
  const commandResults = [];

  for (const commandName of commandNames) {
    const qualityCommand = QUALITY_COMMANDS[commandName];
    const binary = resolveQualityBinary(qualityCommand);
    const commandArgs = qualityCommand.buildArgs({ targets });
    const result = await runCommand({
      command: binary,
      args: commandArgs,
      cwd: repoPath,
      timeoutMs: timeoutSec * 1000,
      maxChars: maxOutputChars,
    });
    commandResults.push({
      name: commandName,
      display_name: qualityCommand.displayName,
      read_only: qualityCommand.readOnly === true,
      command: redactCommand(binary, commandArgs),
      exit_code: result.exitCode,
      signal: result.signal,
      timed_out: result.timedOut,
      stdout: result.stdout,
      stdout_truncated: result.stdoutTruncated,
      stderr: result.stderr,
      stderr_truncated: result.stderrTruncated,
    });
  }

  const afterStatus = await gitStatus(gitRoot);
  const beforeChanged = new Set(beforeStatus.changedFiles);
  const newlyChangedFiles = afterStatus.changedFiles.filter((file) => !beforeChanged.has(file));
  const outOfScopeNewFiles = files.length
    ? newlyChangedFiles.filter((file) => !files.some((target) => sameGitPath(gitRoot, target, file)))
    : [];
  const diffStat = includeDiffStat ? await gitDiffStat(gitRoot, maxOutputChars) : null;
  const safetyErrors = [];

  if (newlyChangedFiles.length > maxChangedFiles) {
    safetyErrors.push(
      `newly dirty file count ${newlyChangedFiles.length} exceeded max_changed_files ${maxChangedFiles}`,
    );
  }
  if (outOfScopeNewFiles.length) {
    safetyErrors.push(`commands created dirty files outside requested files: ${outOfScopeNewFiles.join(", ")}`);
  }

  return {
    repo_path: repoPath,
    git_root: gitRoot,
    readonly: false,
    targets,
    commands: commandResults,
    before_changed_files: beforeStatus.changedFiles,
    after_changed_files: afterStatus.changedFiles,
    newly_changed_files: newlyChangedFiles,
    out_of_scope_new_files: outOfScopeNewFiles,
    safety_errors: safetyErrors,
    diff_stat: diffStat,
  };
}

function buildReadOnlyPrompt({ providerName, repoPath, task, files, extraContext }) {
  const fileSection = files.length
    ? `Focus files:\n${files.map((file) => `- ${path.relative(repoPath, file)}`).join("\n")}\n\n`
    : "";
  const contextSection = extraContext ? `Extra context:\n${extraContext}\n\n` : "";

  return [
    "You are being invoked by Codex through a local MCP bridge as an external code-analysis agent.",
    "This is a read-only analysis task.",
    "Do not edit files, do not run destructive commands, do not install dependencies, and do not change git state.",
    "Prefer reading code and returning concise findings with file paths and line references where possible.",
    `Provider: ${providerName}`,
    `Repository: ${repoPath}`,
    "",
    fileSection.trimEnd(),
    contextSection.trimEnd(),
    "Task:",
    task,
    "",
    "Return a concise structured report with: summary, findings, evidence, residual risks, and suggested next steps.",
  ]
    .filter((part) => part !== "")
    .join("\n");
}

function validateRepoPath(value) {
  const repoPath = requireNonEmptyString(value, "repo_path");
  if (!path.isAbsolute(repoPath)) {
    throw rpcError(-32602, "repo_path must be an absolute path");
  }
  const resolved = fs.realpathSync(repoPath);
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    throw rpcError(-32602, "repo_path must point to a directory");
  }
  assertPathAllowed(resolved);
  return resolved;
}

function validateFiles(repoPath, files) {
  if (!Array.isArray(files)) {
    throw rpcError(-32602, "files must be an array when provided");
  }

  return files.map((file, index) => {
    if (typeof file !== "string" || file.trim() === "") {
      throw rpcError(-32602, `files[${index}] must be a non-empty string`);
    }
    const candidate = path.isAbsolute(file) ? file : path.join(repoPath, file);
    const resolved = fs.realpathSync(candidate);
    assertPathInside(repoPath, resolved, `files[${index}] must stay under repo_path`);
    return resolved;
  });
}

function validateQualityFiles(repoPath, files, allowRepoWide) {
  if (!Array.isArray(files)) {
    throw rpcError(-32602, "files must be an array when provided");
  }
  if (!files.length) {
    if (allowRepoWide) {
      return [];
    }
    throw rpcError(-32602, "quality_fix requires files unless allow_repo_wide is true");
  }
  return validateFiles(repoPath, files);
}

function validateQualityCommands(commands, args) {
  if (!Array.isArray(commands) || commands.length === 0) {
    throw rpcError(-32602, "commands must be a non-empty array");
  }
  const allowUnsafe = args.allow_unsafe_fixes === true;
  return commands.map((command, index) => {
    if (typeof command !== "string" || !Object.hasOwn(QUALITY_COMMANDS, command)) {
      throw rpcError(
        -32602,
        `commands[${index}] must be one of: ${Object.keys(QUALITY_COMMANDS).join(", ")}`,
      );
    }
    if (QUALITY_COMMANDS[command].requiresUnsafe && !allowUnsafe) {
      throw rpcError(-32602, `${command} requires allow_unsafe_fixes=true`);
    }
    return command;
  });
}

function requireProvider(value) {
  const provider = requireNonEmptyString(value, "provider");
  if (!Object.hasOwn(PROVIDERS, provider)) {
    throw rpcError(-32602, `provider must be one of: ${Object.keys(PROVIDERS).join(", ")}`);
  }
  return provider;
}

function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw rpcError(-32602, `${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value, field) {
  if (value == null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw rpcError(-32602, `${field} must be a string when provided`);
  }
  return value;
}

function boundedNumber(value, defaultValue, min, max, field) {
  if (value == null) {
    return defaultValue;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw rpcError(-32602, `${field} must be a finite number`);
  }
  if (value < min) {
    throw rpcError(-32602, `${field} must be >= ${min}`);
  }
  return Math.min(value, max);
}

function resolveProviderBinary(provider) {
  return process.env[provider.binaryEnv] || provider.defaultBinary;
}

function resolveQualityBinary(command) {
  return process.env[command.binaryEnv] || command.defaultBinary;
}

function allowedRoots() {
  const raw = process.env.EXTERNAL_AGENT_ALLOWED_ROOTS;
  if (!raw) {
    return [];
  }
  return raw
    .split(":")
    .map((root) => root.trim())
    .filter(Boolean)
    .map((root) => fs.realpathSync(root));
}

function assertPathAllowed(candidate) {
  const roots = allowedRoots();
  if (!roots.length) {
    return;
  }
  for (const root of roots) {
    if (isSameOrInside(root, candidate)) {
      return;
    }
  }
  throw rpcError(
    -32602,
    `repo_path is outside EXTERNAL_AGENT_ALLOWED_ROOTS: ${roots.join(":")}`,
  );
}

function assertPathInside(parent, candidate, message) {
  if (!isSameOrInside(parent, candidate)) {
    throw rpcError(-32602, message);
  }
}

function isSameOrInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sameGitPath(gitRoot, absolutePath, gitPath) {
  return normalizeGitPath(path.relative(gitRoot, absolutePath)) === normalizeGitPath(gitPath);
}

function normalizeGitPath(value) {
  return value.split(path.sep).join("/");
}

async function requireGitRoot(repoPath) {
  const result = await runCommand({
    command: "git",
    args: ["rev-parse", "--show-toplevel"],
    cwd: repoPath,
    timeoutMs: 10000,
    maxChars: 4000,
  });
  if (result.exitCode !== 0 || result.timedOut) {
    throw rpcError(-32602, "quality_fix requires repo_path to be inside a git repository", {
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }
  return fs.realpathSync(firstNonEmptyLine(result.stdout));
}

async function gitStatus(gitRoot) {
  const result = await runCommand({
    command: "git",
    args: ["status", "--porcelain=v1", "-z"],
    cwd: gitRoot,
    timeoutMs: 10000,
    maxChars: 50000,
  });
  if (result.exitCode !== 0 || result.timedOut) {
    throw rpcError(-32603, "failed to read git status", {
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }
  return {
    changedFiles: parsePorcelainStatus(result.stdout),
    raw: result.stdout,
  };
}

async function gitDiffStat(gitRoot, maxChars) {
  const result = await runCommand({
    command: "git",
    args: ["diff", "--stat"],
    cwd: gitRoot,
    timeoutMs: 10000,
    maxChars,
  });
  return {
    exit_code: result.exitCode,
    stdout: result.stdout,
    stdout_truncated: result.stdoutTruncated,
    stderr: result.stderr,
    stderr_truncated: result.stderrTruncated,
  };
}

function parsePorcelainStatus(output) {
  const changed = [];
  const records = output.split("\0").filter(Boolean);
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const status = record.slice(0, 2);
    const filePath = record.slice(3);
    if (!filePath) {
      continue;
    }
    if (status.startsWith("R") || status.startsWith("C")) {
      const destination = records[index + 1];
      if (destination) {
        changed.push(destination);
        index += 1;
        continue;
      }
    }
    changed.push(filePath);
  }
  return [...new Set(changed)].sort();
}

async function runCommand({ command, args, cwd, timeoutMs, maxChars }) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;

    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      signal: controller.signal,
    });

    child.stdout.on("data", (chunk) => {
      const result = appendLimited(stdout, chunk.toString("utf8"), maxChars);
      stdout = result.text;
      stdoutTruncated ||= result.truncated;
    });

    child.stderr.on("data", (chunk) => {
      const result = appendLimited(stderr, chunk.toString("utf8"), maxChars);
      stderr = result.text;
      stderrTruncated ||= result.truncated;
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      if (timedOut && error.name === "AbortError") {
        resolve({
          exitCode: null,
          signal: "SIGTERM",
          timedOut,
          stdout,
          stderr,
          stdoutTruncated,
          stderrTruncated,
        });
        return;
      }
      reject(error);
    });

    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode,
        signal,
        timedOut,
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
      });
    });
  });
}

function appendLimited(current, addition, maxChars) {
  if (current.length >= maxChars) {
    return { text: current, truncated: true };
  }
  const room = maxChars - current.length;
  if (addition.length <= room) {
    return { text: current + addition, truncated: false };
  }
  return { text: current + addition.slice(0, room), truncated: true };
}

function firstNonEmptyLine(value) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

function redactCommand(command, args) {
  return [command, ...args.map((arg) => (arg.length > 300 ? `${arg.slice(0, 300)}...<truncated>` : arg))];
}

function toolResult(payload, isError = false) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
    isError,
  };
}

function writeResponse(id, result) {
  writeJson({
    jsonrpc: JSON_RPC_VERSION,
    id,
    result,
  });
}

function writeError(id, code, message, data) {
  writeJson({
    jsonrpc: JSON_RPC_VERSION,
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  });
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function rpcError(code, message, data) {
  const error = new Error(message);
  error.code = code;
  error.data = data;
  return error;
}

function log(message) {
  process.stderr.write(`[${SERVER_NAME}] ${message}\n`);
}
