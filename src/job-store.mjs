import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  JOB_STATUSES,
  appendJsonLine,
  defaultJobRoot,
  isTerminalStatus,
  readJsonFile,
  readTextLimited,
  rpcError,
  validateJobId,
  writeJsonFile,
} from "./utils.mjs";

const JOB_ID_PATTERN = /^job_[a-z0-9]+_[a-f0-9]{8}$/;
const SEARCH_CURSOR_VERSION = 1;
const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 100;
const PREVIEW_CHARS = 240;

export class FileJobStore {
  constructor({ root = defaultJobRoot() } = {}) {
    this.root = root;
  }

  initialize() {
    fs.mkdirSync(this.root, { recursive: true });
  }

  jobDir(jobId) {
    validateJobId(jobId);
    return path.join(this.root, jobId);
  }

  createJob(job) {
    this.saveJob(job);
    return job;
  }

  getJob(jobId) {
    validateJobId(jobId);
    const filePath = path.join(this.jobDir(jobId), "job.json");
    if (!fs.existsSync(filePath)) {
      throw rpcError(-32602, `unknown job_id: ${jobId}`);
    }
    const job = readJsonFile(filePath);
    if (!JOB_STATUSES.has(job.status)) {
      throw rpcError(-32603, `${jobId} has invalid status ${job.status}`);
    }
    return job;
  }

  updateJob(jobId, patch) {
    const job = this.normalizeJob({ ...this.getJob(jobId), ...patch });
    this.saveJob(job);
    return job;
  }

  saveJob(job) {
    const normalized = this.normalizeJob(job);
    writeJsonFile(path.join(this.jobDir(normalized.id), "job.json"), normalized);
  }

  appendEvent(jobId, type, data) {
    appendJsonLine(path.join(this.jobDir(jobId), "events.jsonl"), {
      ts: new Date().toISOString(),
      type,
      ...data,
    });
  }

  deleteJob(jobId) {
    fs.rmSync(this.jobDir(jobId), { recursive: true, force: true });
  }

  listJobIds() {
    if (!fs.existsSync(this.root)) {
      return [];
    }
    return fs
      .readdirSync(this.root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && JOB_ID_PATTERN.test(entry.name))
      .map((entry) => {
        const jobPath = path.join(this.root, entry.name, "job.json");
        const mtime = fs.existsSync(jobPath) ? fs.statSync(jobPath).mtimeMs : 0;
        return { id: entry.name, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .map((entry) => entry.id);
  }

  listJobs() {
    const jobs = [];
    for (const jobId of this.listJobIds()) {
      try {
        jobs.push(this.getJob(jobId));
      } catch {
        // Ignore corrupt or partially removed job directories during search.
      }
    }
    return jobs;
  }

  searchJobs(filters) {
    const limit = normalizeLimit(filters.limit);
    const offset = decodeCursor(filters.cursor);
    const matched = this.listJobs()
      .filter((job) => matchesSearch(job, filters))
      .sort((a, b) => compareIsoDesc(a.created_at, b.created_at));
    const page = matched.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    return {
      jobs: page.map((job) => this.toSearchSummary(job)),
      next_cursor: nextOffset < matched.length ? encodeCursor(nextOffset) : null,
    };
  }

  toSearchSummary(job) {
    return {
      job_id: job.id,
      title: job.title,
      provider: job.provider,
      model: job.model,
      mode: job.mode,
      status: job.status,
      repo_path: job.repo_path,
      created_at: job.created_at,
      started_at: job.started_at,
      finished_at: job.finished_at,
      duration_ms: job.duration_ms ?? durationMs(job.started_at, job.finished_at),
      task_hash: job.task_hash ?? (job.task ? sha256Hex(job.task) : null),
      repo_head: job.repo_head ?? null,
      task_preview: preview(job.task),
      result_preview: job.result_preview ?? preview(readTextLimited(job.result_path, PREVIEW_CHARS).text),
      artifact_paths: {
        job: job.job_path,
        result: job.result_path,
        events: job.events_path,
        stdout: job.stdout_path,
        stderr: job.stderr_path,
        patch: job.patch_path ?? null,
        diff_stat: job.diff_stat_path ?? null,
      },
    };
  }

  normalizeJob(job) {
    const normalized = {
      schema_version: 1,
      ...job,
    };
    if (normalized.started_at && normalized.finished_at) {
      const started = Date.parse(normalized.started_at);
      const finished = Date.parse(normalized.finished_at);
      if (Number.isFinite(started) && Number.isFinite(finished)) {
        normalized.duration_ms = Math.max(0, finished - started);
      }
    }
    if (isTerminalStatus(normalized.status) && normalized.result_path && fs.existsSync(normalized.result_path)) {
      normalized.result_preview = preview(readTextLimited(normalized.result_path, PREVIEW_CHARS).text);
    }
    return normalized;
  }
}

function durationMs(startedAt, finishedAt) {
  if (!startedAt || !finishedAt) {
    return null;
  }
  const started = Date.parse(startedAt);
  const finished = Date.parse(finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished)) {
    return null;
  }
  return Math.max(0, finished - started);
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

export function normalizeSearchFilters(args) {
  const filters = {
    repo_path: normalizeOptionalString(args.repo_path, "repo_path"),
    provider: normalizeOptionalString(args.provider, "provider"),
    model: normalizeOptionalString(args.model, "model"),
    mode: normalizeOptionalString(args.mode, "mode"),
    query: normalizeOptionalString(args.query, "query"),
    cursor: normalizeOptionalString(args.cursor, "cursor"),
    limit: normalizeLimit(args.limit),
    status: undefined,
    created_after: normalizeOptionalTimestamp(args.created_after, "created_after"),
    created_before: normalizeOptionalTimestamp(args.created_before, "created_before"),
  };

  if (filters.mode && filters.mode !== "analysis" && filters.mode !== "sandbox_patch") {
    throw rpcError(-32602, "mode must be analysis or sandbox_patch");
  }
  if (args.status != null) {
    if (!Array.isArray(args.status) || args.status.length === 0) {
      throw rpcError(-32602, "status must be a non-empty array when provided");
    }
    filters.status = args.status.map((status, index) => {
      if (typeof status !== "string" || !JOB_STATUSES.has(status)) {
        throw rpcError(-32602, `status[${index}] must be a known job status`);
      }
      return status;
    });
  }

  return filters;
}

function matchesSearch(job, filters) {
  if (filters.repo_path && job.repo_path !== filters.repo_path) {
    return false;
  }
  if (filters.provider && job.provider !== filters.provider) {
    return false;
  }
  if (filters.model && job.model !== filters.model) {
    return false;
  }
  if (filters.mode && job.mode !== filters.mode) {
    return false;
  }
  if (filters.status && !filters.status.includes(job.status)) {
    return false;
  }
  if (filters.created_after && compareIso(job.created_at, filters.created_after) < 0) {
    return false;
  }
  if (filters.created_before && compareIso(job.created_at, filters.created_before) > 0) {
    return false;
  }
  if (filters.query) {
    const haystack = [
      job.id,
      job.title,
      job.task,
      job.result_preview,
      job.repo_path,
      job.provider,
      job.model,
      job.mode,
      ...(job.files ?? []),
    ]
      .filter(Boolean)
      .join("\n")
      .toLowerCase();
    if (!haystack.includes(filters.query.toLowerCase())) {
      return false;
    }
  }
  return true;
}

function normalizeLimit(value) {
  if (value == null) {
    return DEFAULT_SEARCH_LIMIT;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    throw rpcError(-32602, "limit must be a positive number");
  }
  return Math.min(Math.floor(value), MAX_SEARCH_LIMIT);
}

function normalizeOptionalString(value, field) {
  if (value == null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw rpcError(-32602, `${field} must be a string when provided`);
  }
  return value.trim();
}

function normalizeOptionalTimestamp(value, field) {
  const normalized = normalizeOptionalString(value, field);
  if (!normalized) {
    return undefined;
  }
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp)) {
    throw rpcError(-32602, `${field} must be an ISO timestamp`);
  }
  return new Date(timestamp).toISOString();
}

function encodeCursor(offset) {
  return Buffer.from(JSON.stringify({ v: SEARCH_CURSOR_VERSION, offset }), "utf8").toString("base64url");
}

function decodeCursor(cursor) {
  if (!cursor) {
    return 0;
  }
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (decoded.v !== SEARCH_CURSOR_VERSION || !Number.isInteger(decoded.offset) || decoded.offset < 0) {
      throw new Error("invalid cursor payload");
    }
    return decoded.offset;
  } catch {
    throw rpcError(-32602, "cursor is invalid");
  }
}

function compareIso(left, right) {
  return Date.parse(left ?? "") - Date.parse(right ?? "");
}

function compareIsoDesc(left, right) {
  return compareIso(right, left);
}

function preview(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, PREVIEW_CHARS);
}
