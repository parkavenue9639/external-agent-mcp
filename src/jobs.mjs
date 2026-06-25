import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_MAX_OUTPUT_CHARS,
  DEFAULT_TAIL_CHARS,
  DEFAULT_TIMEOUT_SEC,
  MAX_OUTPUT_CHARS,
  MAX_TAIL_CHARS,
  MAX_TIMEOUT_SEC,
  allowedRoots,
  boundedNumber,
  isTerminalStatus,
  log,
  maxConcurrency,
  normalizeJobIds,
  optionalString,
  readTail,
  readTextLimited,
  redactCommand,
  requireNonEmptyString,
  rpcError,
  validateFiles,
  validateRepoPath,
} from "./utils.mjs";
import { FileJobStore, normalizeSearchFilters } from "./job-store.mjs";
import {
  PROVIDERS,
  assertNoDangerousFlags,
  buildAgentPrompt,
  requireProvider,
  resolveProviderBinary,
  validateMode,
} from "./providers.mjs";
import { gitStatus, requireGitRoot } from "./quality.mjs";
import { runCommand, spawnToFiles } from "./runner.mjs";

const MAX_TASKS_PER_CALL = 50;
const PATCH_OUTPUT_LIMIT = 2_000_000;
const activeJobs = new Map();
const queue = [];
const jobStore = new FileJobStore();
let initialized = false;

export function initializeJobs() {
  if (initialized) {
    return;
  }
  jobStore.initialize();
  for (const jobId of listJobIds()) {
    try {
      const job = readJob(jobId);
      if (job.status === "queued" || job.status === "running") {
        updateJob(jobId, {
          status: "orphaned",
          finished_at: new Date().toISOString(),
          orphaned_at: new Date().toISOString(),
          error: "MCP server restarted while job was not terminal",
        });
        appendEvent(jobId, "orphaned", { reason: "server_restart" });
      }
    } catch (error) {
      log(`failed to inspect existing job ${jobId}: ${error.message}`);
    }
  }
  initialized = true;
}

export function getJobRoot() {
  return jobStore.root;
}

export async function delegateTasks(args) {
  initializeJobs();
  const repoPath = validateRepoPath(args.repo_path);
  const rawTasks = validateRawTasks(args.tasks);
  const defaultProvider = args.provider ? requireProvider(args.provider) : undefined;
  const defaultMode = validateMode(args.mode ?? "analysis");
  const defaultModel = optionalString(args.model, "model");
  const defaultExtraContext = optionalString(args.extra_context, "extra_context");
  const defaultFiles = validateFiles(repoPath, args.files ?? []);
  const defaultTimeoutSec = boundedNumber(
    args.timeout_sec,
    DEFAULT_TIMEOUT_SEC,
    1,
    MAX_TIMEOUT_SEC,
    "timeout_sec",
  );
  const defaultMaxOutputChars = boundedNumber(
    args.max_output_chars,
    DEFAULT_MAX_OUTPUT_CHARS,
    1000,
    MAX_OUTPUT_CHARS,
    "max_output_chars",
  );
  const defaultBaseRef = optionalString(args.base_ref, "base_ref") ?? "HEAD";
  const repoHead = await getRepoHead(repoPath);
  const created = [];
  const warnings = [];

  for (const [index, rawTask] of rawTasks.entries()) {
    const taskSpec = normalizeTaskSpec(rawTask, index);
    const providerName = taskSpec.provider ? requireProvider(taskSpec.provider) : defaultProvider;
    if (!providerName) {
      throw rpcError(-32602, `tasks[${index}].provider or top-level provider is required`);
    }
    const provider = PROVIDERS[providerName];
    const mode = validateMode(taskSpec.mode ?? defaultMode);
    if (mode === "sandbox_patch" && !provider.capabilities.supports_sandbox_patch) {
      throw rpcError(-32602, `${providerName} does not support sandbox_patch`);
    }
    if (mode === "sandbox_patch" && provider.capabilities.supports_sandbox_patch === "experimental") {
      warnings.push(`${providerName} sandbox_patch is experimental and runs without force/yolo flags`);
    }
    const files = taskSpec.files ? validateFiles(repoPath, taskSpec.files, `tasks[${index}].files`) : defaultFiles;
    const timeoutSec = boundedNumber(
      taskSpec.timeout_sec,
      defaultTimeoutSec,
      1,
      MAX_TIMEOUT_SEC,
      `tasks[${index}].timeout_sec`,
    );
    const maxOutputChars = boundedNumber(
      taskSpec.max_output_chars,
      defaultMaxOutputChars,
      1000,
      MAX_OUTPUT_CHARS,
      `tasks[${index}].max_output_chars`,
    );
    const model = optionalString(taskSpec.model, `tasks[${index}].model`) ?? defaultModel;
    const extraContext = optionalString(taskSpec.extra_context, `tasks[${index}].extra_context`) ?? defaultExtraContext;
    const baseRef = optionalString(taskSpec.base_ref, `tasks[${index}].base_ref`) ?? defaultBaseRef;
    const title = optionalString(taskSpec.title, `tasks[${index}].title`) ?? `task-${index + 1}`;
    const job = createJob({
      providerName,
      mode,
      repoPath,
      task: taskSpec.task,
      title,
      files,
      model,
      extraContext,
      timeoutSec,
      maxOutputChars,
      baseRef,
      repoHead,
    });
    queue.push(job.id);
    appendEvent(job.id, "queued", {});
    created.push(projectJobSummary(job));
  }

  scheduleQueue();

  return {
    job_root: getJobRoot(),
    max_concurrency: maxConcurrency(),
    jobs: created,
    warnings,
  };
}

export async function analyzeCode(args) {
  const delegated = await delegateTasks({
    ...args,
    mode: "analysis",
    tasks: [
      {
        task: requireNonEmptyString(args.task, "task"),
        files: args.files,
        provider: args.provider,
        model: args.model,
        extra_context: args.extra_context,
        timeout_sec: args.timeout_sec,
        max_output_chars: args.max_output_chars,
      },
    ],
  });
  const jobId = delegated.jobs[0].job_id;
  const timeoutSec = boundedNumber(args.timeout_sec, DEFAULT_TIMEOUT_SEC, 1, MAX_TIMEOUT_SEC, "timeout_sec");
  const job = await waitForJob(jobId, timeoutSec * 1000 + 5000);
  const result = await jobResult({
    job_id: jobId,
    max_output_chars: args.max_output_chars,
    include_stderr: args.include_stderr,
  });
  const payload = result.jobs[0];
  return {
    deprecated: true,
    provider: payload.provider,
    job_id: jobId,
    cwd: payload.workspace_path,
    readonly: true,
    started_at: payload.started_at,
    finished_at: payload.finished_at,
    exit_code: payload.exit_code,
    signal: payload.signal,
    timed_out: payload.status === "timed_out",
    stdout: payload.result_text,
    stdout_truncated: payload.result_truncated,
    stderr: args.include_stderr === false ? undefined : payload.stderr,
    stderr_truncated: args.include_stderr === false ? undefined : payload.stderr_truncated,
    status: job.status,
    logs: payload.logs,
  };
}

export async function jobStatus(args) {
  initializeJobs();
  const jobIds = normalizeJobIds(args, { required: false });
  const ids = jobIds.length ? jobIds : listJobIds().slice(0, boundedNumber(args.limit, 20, 1, 200, "limit"));
  const tailChars = boundedNumber(args.tail_chars, DEFAULT_TAIL_CHARS, 0, MAX_TAIL_CHARS, "tail_chars");
  return {
    job_root: getJobRoot(),
    jobs: ids.map((jobId) => {
      const job = readJob(jobId);
      return {
        ...projectJobSummary(job),
        pid: job.pid ?? null,
        command: job.command ?? null,
        exit_code: job.exit_code ?? null,
        signal: job.signal ?? null,
        timed_out: job.timed_out ?? false,
        error: job.error ?? null,
        stdout_tail: tailChars > 0 ? readTail(job.stdout_path, tailChars).text : "",
        stderr_tail: tailChars > 0 ? readTail(job.stderr_path, tailChars).text : "",
      };
    }),
  };
}

export async function jobResult(args) {
  initializeJobs();
  const jobIds = normalizeJobIds(args);
  const maxOutputChars = boundedNumber(
    args.max_output_chars,
    DEFAULT_MAX_OUTPUT_CHARS,
    1000,
    MAX_OUTPUT_CHARS,
    "max_output_chars",
  );
  const includeStderr = args.include_stderr !== false;
  return {
    job_root: getJobRoot(),
    jobs: jobIds.map((jobId) => {
      const job = readJob(jobId);
      const result = readTextLimited(job.result_path, maxOutputChars);
      const stderr = includeStderr ? readTextLimited(job.stderr_path, maxOutputChars) : { text: undefined, truncated: undefined };
      const diffStat = job.diff_stat_path ? readTextLimited(job.diff_stat_path, maxOutputChars) : { text: "", truncated: false };
      return {
        ...projectJobSummary(job),
        command: job.command ?? null,
        exit_code: job.exit_code ?? null,
        signal: job.signal ?? null,
        timed_out: job.timed_out ?? false,
        result_text: result.text,
        result_truncated: result.truncated,
        stderr: stderr.text,
        stderr_truncated: stderr.truncated,
        changed_files: job.changed_files ?? [],
        patch_path: job.patch_path ?? null,
        diff_stat: diffStat.text,
        diff_stat_truncated: diffStat.truncated,
        logs: {
          stdout: job.stdout_path,
          stderr: job.stderr_path,
          events: job.events_path,
          job: job.job_path,
          result: job.result_path,
        },
      };
    }),
  };
}

export async function searchJobs(args) {
  initializeJobs();
  const normalizedArgs = {
    ...args,
    repo_path: args.repo_path ? validateRepoPath(args.repo_path) : undefined,
  };
  const filters = normalizeSearchFilters(normalizedArgs);
  return {
    job_root: getJobRoot(),
    ...jobStore.searchJobs(filters),
  };
}

export async function cancelJobs(args) {
  initializeJobs();
  const jobIds = normalizeJobIds(args);
  const results = [];
  for (const jobId of jobIds) {
    const job = readJob(jobId);
    if (isTerminalStatus(job.status)) {
      results.push({ job_id: jobId, status: job.status, cancelled: false, reason: "already_terminal" });
      continue;
    }
    if (job.status === "queued") {
      removeQueuedJob(jobId);
      updateJob(jobId, {
        status: "cancelled",
        finished_at: new Date().toISOString(),
        error: "cancelled before start",
      });
      appendEvent(jobId, "cancelled", { phase: "queued" });
      results.push({ job_id: jobId, status: "cancelled", cancelled: true });
      continue;
    }
    const active = activeJobs.get(jobId);
    if (!active) {
      updateJob(jobId, {
        status: "orphaned",
        finished_at: new Date().toISOString(),
        error: "running job is not attached to this MCP process",
      });
      appendEvent(jobId, "orphaned", { reason: "cancel_without_active_process" });
      results.push({ job_id: jobId, status: "orphaned", cancelled: false });
      continue;
    }
    updateJob(jobId, {
      status: "cancelled",
      finished_at: new Date().toISOString(),
      error: "cancel requested",
    });
    appendEvent(jobId, "cancel_requested", {});
    active.child.kill("SIGTERM");
    results.push({ job_id: jobId, status: "cancelled", cancelled: true });
  }
  return { jobs: results };
}

export async function cleanupJobs(args) {
  initializeJobs();
  const jobIds = normalizeJobIds(args);
  const force = args.force === true;
  const results = [];
  for (const jobId of jobIds) {
    const job = readJob(jobId);
    if (!isTerminalStatus(job.status) && !force) {
      throw rpcError(-32602, `${jobId} is ${job.status}; pass force=true to cleanup non-terminal jobs`);
    }
    const active = activeJobs.get(jobId);
    if (active) {
      active.child.kill("SIGTERM");
      activeJobs.delete(jobId);
    }
    let worktreeRemoved = false;
    if (job.worktree_path && fs.existsSync(job.worktree_path) && job.git_root && fs.existsSync(job.git_root)) {
      const removeResult = await runCommand({
        command: "git",
        args: ["worktree", "remove", "--force", job.worktree_path],
        cwd: job.git_root,
        timeoutMs: 30000,
        maxChars: 10000,
      });
      worktreeRemoved = removeResult.exitCode === 0 && !removeResult.timedOut;
    }
    jobStore.deleteJob(jobId);
    results.push({ job_id: jobId, cleaned: true, worktree_removed: worktreeRemoved });
  }
  return { jobs: results };
}

export async function agentStatus(args) {
  initializeJobs();
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
        version = result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean)
          ?? result.stderr.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
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
      capabilities: provider.capabilities,
      analysis_args: redactCommand(binary, provider.buildArgs({
        mode: "analysis",
        prompt: "<prompt>",
        workspacePath: "<workspace>",
        model: "<model>",
      })),
      sandbox_patch_args: redactCommand(binary, provider.buildArgs({
        mode: "sandbox_patch",
        prompt: "<prompt>",
        workspacePath: "<worktree>",
        model: "<model>",
      })),
    };
  }

  return {
    server: "external-agent-mcp",
    job_root: getJobRoot(),
    max_concurrency: maxConcurrency(),
    allowed_roots: allowedRoots(),
    providers: checks,
  };
}

function validateRawTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw rpcError(-32602, "tasks must be a non-empty array");
  }
  if (tasks.length > MAX_TASKS_PER_CALL) {
    throw rpcError(-32602, `tasks length must be <= ${MAX_TASKS_PER_CALL}`);
  }
  return tasks;
}

function normalizeTaskSpec(rawTask, index) {
  if (typeof rawTask === "string") {
    return { task: requireNonEmptyString(rawTask, `tasks[${index}]`) };
  }
  if (!rawTask || typeof rawTask !== "object" || Array.isArray(rawTask)) {
    throw rpcError(-32602, `tasks[${index}] must be a string or object`);
  }
  return {
    ...rawTask,
    task: requireNonEmptyString(rawTask.task, `tasks[${index}].task`),
  };
}

function createJob({
  providerName,
  mode,
  repoPath,
  task,
  title,
  files,
  model,
  extraContext,
  timeoutSec,
  maxOutputChars,
  baseRef,
  repoHead,
}) {
  const id = newJobId();
  const directory = jobDir(id);
  fs.mkdirSync(directory, { recursive: true });
  const now = new Date().toISOString();
  const job = {
    schema_version: 1,
    id,
    title,
    provider: providerName,
    mode,
    status: "queued",
    created_at: now,
    started_at: null,
    finished_at: null,
    repo_path: repoPath,
    workspace_path: null,
    worktree_path: null,
    git_root: null,
    base_ref: baseRef,
    task,
    task_hash: sha256Hex(task),
    prompt_hash: null,
    repo_head: repoHead ?? null,
    files: files.map((file) => path.relative(repoPath, file)),
    model: model ?? null,
    extra_context: extraContext ?? null,
    timeout_sec: timeoutSec,
    max_output_chars: maxOutputChars,
    job_dir: directory,
    job_path: path.join(directory, "job.json"),
    events_path: path.join(directory, "events.jsonl"),
    stdout_path: path.join(directory, "stdout.log"),
    stderr_path: path.join(directory, "stderr.log"),
    result_path: path.join(directory, "result.md"),
    patch_path: path.join(directory, "diff.patch"),
    diff_stat_path: path.join(directory, "diff.stat"),
    changed_files: [],
  };
  jobStore.createJob(job);
  return job;
}

function scheduleQueue() {
  while (activeJobs.size < maxConcurrency() && queue.length > 0) {
    const jobId = queue.shift();
    const job = readJob(jobId);
    if (job.status !== "queued") {
      continue;
    }
    startJob(jobId).catch((error) => {
      log(`job ${jobId} crashed: ${error.stack ?? error.message}`);
      try {
        updateJob(jobId, {
          status: "failed",
          finished_at: new Date().toISOString(),
          error: error.message,
        });
        appendEvent(jobId, "failed", { error: error.message });
      } catch (updateError) {
        log(`failed to record crash for ${jobId}: ${updateError.message}`);
      }
    });
  }
}

async function startJob(jobId) {
  let job = readJob(jobId);
  const provider = PROVIDERS[job.provider];
  const binary = resolveProviderBinary(provider);
  const startedAt = new Date().toISOString();
  appendEvent(jobId, "starting", {});

  try {
    const workspacePath = job.mode === "sandbox_patch" ? await createWorktree(job) : job.repo_path;
    job = updateJob(jobId, {
      status: "running",
      started_at: startedAt,
      workspace_path: workspacePath,
      worktree_path: job.mode === "sandbox_patch" ? workspacePath : null,
    });
    const absoluteFiles = job.files.map((file) => path.join(job.repo_path, file));
    const prompt = buildAgentPrompt({
      mode: job.mode,
      repoPath: job.repo_path,
      workspacePath,
      task: job.task,
      files: absoluteFiles,
      extraContext: job.extra_context,
    });
    job = updateJob(jobId, {
      prompt_hash: sha256Hex(prompt),
    });
    const commandArgs = provider.buildArgs({
      mode: job.mode,
      prompt,
      workspacePath,
      model: job.model,
    });
    assertNoDangerousFlags(commandArgs);
    job = updateJob(jobId, {
      command: redactCommand(binary, commandArgs),
    });

    const runPromise = spawnToFiles({
      command: binary,
      args: commandArgs,
      cwd: workspacePath,
      timeoutMs: job.timeout_sec * 1000,
      stdoutPath: job.stdout_path,
      stderrPath: job.stderr_path,
      onChild: (child) => {
        activeJobs.set(jobId, { child });
        updateJob(jobId, { pid: child.pid });
        appendEvent(jobId, "spawned", { pid: child.pid });
      },
    });

    const result = await runPromise;
    activeJobs.delete(jobId);
    job = readJob(jobId);
    const existingStatus = job.status;
    const finalStatus = existingStatus === "cancelled"
      ? "cancelled"
      : result.timedOut
        ? "timed_out"
        : result.exitCode === 0
          ? "succeeded"
          : "failed";

    if (fs.existsSync(job.stdout_path)) {
      fs.copyFileSync(job.stdout_path, job.result_path);
    } else {
      fs.writeFileSync(job.result_path, "");
    }

    let patchTruncated = false;
    let diffStatTruncated = false;
    let changedFiles = [];
    if (job.mode === "sandbox_patch" && job.worktree_path) {
      const artifacts = await collectPatchArtifacts(job);
      patchTruncated = artifacts.patch_truncated;
      diffStatTruncated = artifacts.diff_stat_truncated;
      changedFiles = artifacts.changed_files;
    }

    updateJob(jobId, {
      status: finalStatus,
      finished_at: new Date().toISOString(),
      exit_code: result.exitCode,
      signal: result.signal,
      timed_out: result.timedOut,
      patch_truncated: patchTruncated,
      diff_stat_truncated: diffStatTruncated,
      changed_files: changedFiles,
    });
    appendEvent(jobId, finalStatus, {
      exit_code: result.exitCode,
      signal: result.signal,
      timed_out: result.timedOut,
    });
  } catch (error) {
    activeJobs.delete(jobId);
    const latest = readJob(jobId);
    const status = latest.status === "cancelled" ? "cancelled" : "failed";
    updateJob(jobId, {
      status,
      finished_at: new Date().toISOString(),
      error: error.message,
    });
    appendEvent(jobId, status, { error: error.message });
  } finally {
    scheduleQueue();
  }
}

async function createWorktree(job) {
  const gitRoot = await requireGitRoot(job.repo_path);
  const worktreePath = path.join(job.job_dir, "worktree");
  const result = await runCommand({
    command: "git",
    args: ["-c", "advice.detachedHead=false", "worktree", "add", "--detach", worktreePath, job.base_ref],
    cwd: gitRoot,
    timeoutMs: 60000,
    maxChars: 20000,
  });
  if (result.exitCode !== 0 || result.timedOut) {
    throw rpcError(-32603, "failed to create sandbox worktree", {
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }
  updateJob(job.id, {
    git_root: gitRoot,
    workspace_path: worktreePath,
    worktree_path: worktreePath,
  });
  appendEvent(job.id, "worktree_created", { git_root: gitRoot, worktree_path: worktreePath });
  return worktreePath;
}

async function collectPatchArtifacts(job) {
  const patch = await runCommand({
    command: "git",
    args: ["diff", "--binary"],
    cwd: job.worktree_path,
    timeoutMs: 30000,
    maxChars: PATCH_OUTPUT_LIMIT,
  });
  fs.writeFileSync(job.patch_path, patch.stdout);

  const diffStat = await runCommand({
    command: "git",
    args: ["diff", "--stat"],
    cwd: job.worktree_path,
    timeoutMs: 30000,
    maxChars: 100000,
  });
  fs.writeFileSync(job.diff_stat_path, diffStat.stdout);

  const status = await gitStatus(job.worktree_path);
  return {
    patch_truncated: patch.stdoutTruncated,
    diff_stat_truncated: diffStat.stdoutTruncated,
    changed_files: status.changedFiles,
  };
}

function waitForJob(jobId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      try {
        const job = readJob(jobId);
        if (isTerminalStatus(job.status)) {
          clearInterval(timer);
          resolve(job);
          return;
        }
        if (Date.now() > deadline) {
          clearInterval(timer);
          reject(rpcError(-32603, `timed out waiting for ${jobId}`));
        }
      } catch (error) {
        clearInterval(timer);
        reject(error);
      }
    }, 100);
  });
}

function removeQueuedJob(jobId) {
  const index = queue.indexOf(jobId);
  if (index >= 0) {
    queue.splice(index, 1);
  }
}

function projectJobSummary(job) {
  return {
    job_id: job.id,
    title: job.title,
    provider: job.provider,
    mode: job.mode,
    status: job.status,
    created_at: job.created_at,
    started_at: job.started_at,
    finished_at: job.finished_at,
    repo_path: job.repo_path,
    workspace_path: job.workspace_path,
    worktree_path: job.worktree_path,
    model: job.model,
    files: job.files,
    base_ref: job.base_ref,
    timeout_sec: job.timeout_sec,
  };
}

function listJobIds() {
  return jobStore.listJobIds();
}

function readJob(jobId) {
  return jobStore.getJob(jobId);
}

function updateJob(jobId, patch) {
  return jobStore.updateJob(jobId, patch);
}

function saveJob(job) {
  jobStore.saveJob(job);
}

function appendEvent(jobId, type, data) {
  jobStore.appendEvent(jobId, type, data);
}

function jobDir(jobId) {
  return jobStore.jobDir(jobId);
}

function newJobId() {
  return `job_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

async function getRepoHead(repoPath) {
  const result = await runCommand({
    command: "git",
    args: ["rev-parse", "HEAD"],
    cwd: repoPath,
    timeoutMs: 10000,
    maxChars: 4000,
  });
  if (result.exitCode !== 0 || result.timedOut) {
    return null;
  }
  return result.stdout.trim() || null;
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}
