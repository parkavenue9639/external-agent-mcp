import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SERVER_NAME = "external-agent-mcp";
export const SERVER_VERSION = "1.0.0";
export const JSON_RPC_VERSION = "2.0";

export const DEFAULT_TIMEOUT_SEC = 600;
export const MAX_TIMEOUT_SEC = 1800;
export const DEFAULT_MAX_OUTPUT_CHARS = 30000;
export const MAX_OUTPUT_CHARS = 100000;
export const DEFAULT_QUALITY_TIMEOUT_SEC = 120;
export const MAX_QUALITY_TIMEOUT_SEC = 900;
export const DEFAULT_MAX_CHANGED_FILES = 20;
export const MAX_CHANGED_FILES = 200;
export const DEFAULT_TAIL_CHARS = 4000;
export const MAX_TAIL_CHARS = 50000;
export const JOB_STATUSES = new Set([
  "queued",
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "orphaned",
]);
export const TERMINAL_JOB_STATUSES = new Set([
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "orphaned",
]);

export function rpcError(code, message, data) {
  const error = new Error(message);
  error.code = code;
  error.data = data;
  return error;
}

export function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw rpcError(-32602, `${field} must be a non-empty string`);
  }
  return value.trim();
}

export function optionalString(value, field) {
  if (value == null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw rpcError(-32602, `${field} must be a string when provided`);
  }
  return value;
}

export function boundedNumber(value, defaultValue, min, max, field) {
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

export function boundedIntegerFromEnv(value, defaultValue, min, max) {
  if (value == null || value === "") {
    return defaultValue;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min) {
    return defaultValue;
  }
  return Math.min(parsed, max);
}

export function defaultJobRoot() {
  return process.env.EXTERNAL_AGENT_JOB_ROOT
    ? path.resolve(process.env.EXTERNAL_AGENT_JOB_ROOT)
    : path.join(os.homedir(), ".cache", "external-agent-mcp", "jobs");
}

export function maxConcurrency() {
  return boundedIntegerFromEnv(process.env.EXTERNAL_AGENT_MAX_CONCURRENCY, 2, 1, 16);
}

export function allowedRoots() {
  const raw = process.env.EXTERNAL_AGENT_ALLOWED_ROOTS;
  if (!raw) {
    return [];
  }
  return raw
    .split(path.delimiter)
    .map((root) => root.trim())
    .filter(Boolean)
    .map((root) => fs.realpathSync(root));
}

export function validateRepoPath(value) {
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

export function validateFiles(repoPath, files, field = "files") {
  if (!Array.isArray(files)) {
    throw rpcError(-32602, `${field} must be an array when provided`);
  }

  return files.map((file, index) => {
    if (typeof file !== "string" || file.trim() === "") {
      throw rpcError(-32602, `${field}[${index}] must be a non-empty string`);
    }
    const candidate = path.isAbsolute(file) ? file : path.join(repoPath, file);
    const resolved = fs.realpathSync(candidate);
    assertPathInside(repoPath, resolved, `${field}[${index}] must stay under repo_path`);
    return resolved;
  });
}

export function assertPathAllowed(candidate) {
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
    `repo_path is outside EXTERNAL_AGENT_ALLOWED_ROOTS: ${roots.join(path.delimiter)}`,
  );
}

export function assertPathInside(parent, candidate, message) {
  if (!isSameOrInside(parent, candidate)) {
    throw rpcError(-32602, message);
  }
}

export function isSameOrInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function normalizeGitPath(value) {
  return value.split(path.sep).join("/");
}

export function sameGitPath(gitRoot, absolutePath, gitPath) {
  return normalizeGitPath(path.relative(gitRoot, absolutePath)) === normalizeGitPath(gitPath);
}

export function parsePorcelainStatus(output) {
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

export function validateJobId(value) {
  const jobId = requireNonEmptyString(value, "job_id");
  if (!/^job_[a-z0-9]+_[a-f0-9]{8}$/.test(jobId)) {
    throw rpcError(-32602, `invalid job_id: ${jobId}`);
  }
  return jobId;
}

export function normalizeJobIds(args, { required = true } = {}) {
  const raw = args.job_ids ?? (args.job_id ? [args.job_id] : []);
  if (!Array.isArray(raw)) {
    throw rpcError(-32602, "job_ids must be an array when provided");
  }
  if (required && raw.length === 0) {
    throw rpcError(-32602, "job_ids or job_id is required");
  }
  return raw.map((jobId) => validateJobId(jobId));
}

export function isTerminalStatus(status) {
  return TERMINAL_JOB_STATUSES.has(status);
}

export function firstNonEmptyLine(value) {
  return String(value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

export function appendLimited(current, addition, maxChars) {
  if (current.length >= maxChars) {
    return { text: current, truncated: true };
  }
  const room = maxChars - current.length;
  if (addition.length <= room) {
    return { text: current + addition, truncated: false };
  }
  return { text: current + addition.slice(0, room), truncated: true };
}

export function readTextLimited(filePath, maxChars) {
  if (!fs.existsSync(filePath)) {
    return { text: "", truncated: false };
  }
  const text = fs.readFileSync(filePath, "utf8");
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  return { text: text.slice(0, maxChars), truncated: true };
}

export function readTail(filePath, maxChars) {
  if (!fs.existsSync(filePath)) {
    return { text: "", truncated: false };
  }
  const stat = fs.statSync(filePath);
  const bytesToRead = Math.min(stat.size, Math.max(maxChars * 4, maxChars));
  const buffer = Buffer.alloc(bytesToRead);
  const fd = fs.openSync(filePath, "r");
  try {
    fs.readSync(fd, buffer, 0, bytesToRead, stat.size - bytesToRead);
  } finally {
    fs.closeSync(fd);
  }
  const text = buffer.toString("utf8");
  if (text.length <= maxChars) {
    return { text, truncated: stat.size > bytesToRead };
  }
  return { text: text.slice(text.length - maxChars), truncated: true };
}

export function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmpPath, filePath);
}

export function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function appendJsonLine(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`);
}

export function redactCommand(command, args) {
  return [command, ...args.map((arg) => (String(arg).length > 300 ? `${String(arg).slice(0, 300)}...<truncated>` : arg))];
}

export function toolResult(payload, isError = false) {
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

export function log(message) {
  process.stderr.write(`[${SERVER_NAME}] ${message}\n`);
}
