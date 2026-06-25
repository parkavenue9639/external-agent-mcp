import path from "node:path";
import {
  DEFAULT_MAX_CHANGED_FILES,
  DEFAULT_MAX_OUTPUT_CHARS,
  DEFAULT_QUALITY_TIMEOUT_SEC,
  MAX_CHANGED_FILES,
  MAX_OUTPUT_CHARS,
  MAX_QUALITY_TIMEOUT_SEC,
  boundedNumber,
  firstNonEmptyLine,
  parsePorcelainStatus,
  redactCommand,
  rpcError,
  sameGitPath,
  validateFiles,
  validateRepoPath,
} from "./utils.mjs";
import { runCommand } from "./runner.mjs";

export const QUALITY_COMMANDS = {
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

export async function qualityFix(args) {
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

export async function requireGitRoot(repoPath) {
  const result = await runCommand({
    command: "git",
    args: ["rev-parse", "--show-toplevel"],
    cwd: repoPath,
    timeoutMs: 10000,
    maxChars: 4000,
  });
  if (result.exitCode !== 0 || result.timedOut) {
    throw rpcError(-32602, "repo_path must be inside a git repository", {
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }
  return path.resolve(firstNonEmptyLine(result.stdout));
}

export async function gitStatus(gitRoot) {
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

export async function gitDiffStat(gitRoot, maxChars) {
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

function resolveQualityBinary(command) {
  return process.env[command.binaryEnv] || command.defaultBinary;
}
