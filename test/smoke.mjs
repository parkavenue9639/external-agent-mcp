import { spawn, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(root, "src", "server.mjs");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "external-agent-mcp-"));
const repoPath = path.join(tempRoot, "repo");
const jobRoot = path.join(tempRoot, "jobs");
const fakeAgentPath = path.join(tempRoot, "fake-agent.mjs");
const fakeRuffPath = path.join(tempRoot, "fake-ruff.mjs");

fs.mkdirSync(repoPath, { recursive: true });
fs.writeFileSync(path.join(repoPath, "sample.py"), "x=1\n");
writeFakeAgent();
writeFakeRuff();
initGitRepo();

let client = startServer();
try {
  await initialize(client);
  await assertToolList(client);
  await assertAgentStatus(client);
  const analysisJobId = await assertAnalysisJob(client);
  const patchJobId = await assertSandboxPatchJob(client);
  await assertSearchJobs(client, analysisJobId, patchJobId);
  await assertParallelQueue(client);
  await assertCancel(client);
  await assertTimeout(client);
  await assertQualityFix(client);
  await assertCleanup(client, analysisJobId, patchJobId);
  await stopServer(client);

  client = startServer();
  await initialize(client);
  await assertRestartOrphan(client);
  client = null;
} finally {
  if (client && !client.exited) {
    client.child.kill("SIGTERM");
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log("smoke ok");

function writeFakeAgent() {
  fs.writeFileSync(
    fakeAgentPath,
    [
      "#!/usr/bin/env node",
      "import fs from 'node:fs';",
      "const args = process.argv.slice(2);",
      "if (args.includes('--version')) {",
      "  console.log('fake-agent 1.0.0');",
      "  process.exit(0);",
      "}",
      "function promptFromArgs() {",
      "  const promptIndex = args.indexOf('--prompt');",
      "  if (promptIndex >= 0) return args[promptIndex + 1] ?? '';",
      "  return args[args.length - 1] ?? '';",
      "}",
      "const prompt = promptFromArgs();",
      "const wait = prompt.match(/WAIT_(\\d+)/);",
      "if (wait) {",
      "  await new Promise((resolve) => setTimeout(resolve, Number(wait[1])));",
      "}",
      "if (prompt.includes('PATCH_SAMPLE')) {",
      "  fs.appendFileSync('sample.py', '# patched by fake agent\\n');",
      "}",
      "console.log('FAKE_AGENT_OK');",
      "console.log(`cwd=${process.cwd()}`);",
      "console.log(`argv=${args.join(' ')}`);",
      "console.log(`prompt_tail=${prompt.split('\\n').slice(-4).join(' | ')}`);",
      "",
    ].join("\n"),
  );
  fs.chmodSync(fakeAgentPath, 0o755);
}

function writeFakeRuff() {
  fs.writeFileSync(
    fakeRuffPath,
    [
      "#!/usr/bin/env node",
      "import fs from 'node:fs';",
      "const args = process.argv.slice(2);",
      "const targets = args.filter((arg) => !arg.startsWith('-') && !['format', 'check'].includes(arg));",
      "for (const target of targets) {",
      "  if (target === '.') continue;",
      "  fs.appendFileSync(target, `# ${args[0]}\\n`);",
      "}",
      "console.log(`fake ruff ${args.join(' ')}`);",
      "",
    ].join("\n"),
  );
  fs.chmodSync(fakeRuffPath, 0o755);
}

function initGitRepo() {
  runGit(["init"]);
  runGit(["add", "sample.py"]);
  runGit(["-c", "user.email=test@example.com", "-c", "user.name=Smoke Test", "commit", "-m", "init"]);
}

function runGit(args) {
  const result = spawnSync("git", args, {
    cwd: repoPath,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

function startServer() {
  const child = spawn(process.execPath, [serverPath], {
    cwd: root,
    env: {
      ...process.env,
      CURSOR_AGENT_BIN: fakeAgentPath,
      GEMINI_BIN: fakeAgentPath,
      CLAUDE_BIN: fakeAgentPath,
      RUFF_BIN: fakeRuffPath,
      EXTERNAL_AGENT_ALLOWED_ROOTS: tempRoot,
      EXTERNAL_AGENT_JOB_ROOT: jobRoot,
      EXTERNAL_AGENT_MAX_CONCURRENCY: "2",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const responses = new Map();
  const stdout = readline.createInterface({ input: child.stdout });
  let stderr = "";
  let nextId = 1;
  let exited = false;

  stdout.on("line", (line) => {
    const message = JSON.parse(line);
    responses.set(message.id, message);
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  child.once("exit", () => {
    exited = true;
  });

  return {
    child,
    responses,
    stdout,
    get stderr() {
      return stderr;
    },
    get exited() {
      return exited;
    },
    async request(method, params = undefined, timeoutMs = 10000) {
      const id = nextId;
      nextId += 1;
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (responses.has(id)) {
          return responses.get(id);
        }
        await sleep(25);
      }
      throw new Error(`Timed out waiting for response ${id}. stderr=${stderr}`);
    },
    notify(method, params = undefined) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    },
  };
}

async function stopServer(server) {
  server.child.stdin.end();
  await new Promise((resolve, reject) => {
    server.child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`server exited ${code}. stderr=${server.stderr}`));
      }
    });
  });
}

async function initialize(server) {
  const response = await server.request("initialize", {
    protocolVersion: "2024-11-05",
    clientInfo: { name: "smoke-test", version: "1.0.0" },
    capabilities: {},
  });
  assert.equal(response.result.serverInfo.name, "external-agent-mcp");
  assert.equal(response.result.serverInfo.version, "1.0.0");
  assert.equal(response.result.capabilities.tools instanceof Object, true);
  server.notify("notifications/initialized");
}

async function assertToolList(server) {
  const response = await server.request("tools/list");
  const toolNames = response.result.tools.map((tool) => tool.name).sort();
  assert.deepEqual(toolNames, [
    "agent_status",
    "analyze_code",
    "cancel_jobs",
    "cleanup_jobs",
    "delegate_tasks",
    "job_result",
    "job_status",
    "quality_fix",
    "search_jobs",
  ]);
}

async function assertAgentStatus(server) {
  const payload = await callTool(server, "agent_status", { timeout_sec: 5 });
  assert.equal(payload.server, "external-agent-mcp");
  assert.equal(payload.max_concurrency, 2);
  for (const provider of ["cursor", "gemini", "claude"]) {
    assert.equal(payload.providers[provider].exists, true);
    assert.equal(payload.providers[provider].version, "fake-agent 1.0.0");
    assert.equal(payload.providers[provider].capabilities.supports_analysis, true);
    const args = [
      ...payload.providers[provider].analysis_args,
      ...payload.providers[provider].sandbox_patch_args,
    ];
    assert.equal(args.includes("--force"), false);
    assert.equal(args.includes("--yolo"), false);
    assert.equal(args.includes("--dangerously-skip-permissions"), false);
    assert.equal(args.includes("bypassPermissions"), false);
  }
}

async function assertAnalysisJob(server) {
  const payload = await callTool(server, "delegate_tasks", {
    provider: "cursor",
    repo_path: repoPath,
    mode: "analysis",
    tasks: ["ANALYZE_ONE"],
    timeout_sec: 5,
  });
  assert.equal(payload.jobs.length, 1);
  const jobId = payload.jobs[0].job_id;
  const status = await waitForTerminal(server, jobId);
  assert.equal(status.status, "succeeded");
  const result = await callTool(server, "job_result", { job_id: jobId });
  assert.match(result.jobs[0].result_text, /FAKE_AGENT_OK/);
  assert.equal(result.jobs[0].mode, "analysis");
  assert.equal(fs.existsSync(result.jobs[0].logs.stdout), true);
  return jobId;
}

async function assertSandboxPatchJob(server) {
  const originalBefore = fs.readFileSync(path.join(repoPath, "sample.py"), "utf8");
  const payload = await callTool(server, "delegate_tasks", {
    provider: "cursor",
    repo_path: repoPath,
    mode: "sandbox_patch",
    tasks: [{ task: "PATCH_SAMPLE", files: ["sample.py"] }],
    timeout_sec: 5,
  });
  assert.equal(payload.warnings.length, 1);
  const jobId = payload.jobs[0].job_id;
  const status = await waitForTerminal(server, jobId);
  assert.equal(status.status, "succeeded");
  const result = await callTool(server, "job_result", { job_id: jobId });
  assert.deepEqual(result.jobs[0].changed_files, ["sample.py"]);
  assert.match(result.jobs[0].diff_stat, /sample.py/);
  assert.equal(fs.existsSync(result.jobs[0].patch_path), true);
  assert.equal(fs.readFileSync(path.join(repoPath, "sample.py"), "utf8"), originalBefore);
  const gitStatus = spawnSync("git", ["status", "--porcelain"], { cwd: repoPath, encoding: "utf8" });
  assert.equal(gitStatus.stdout, "");
  return jobId;
}

async function assertSearchJobs(server, analysisJobId, patchJobId) {
  const byQuery = await callTool(server, "search_jobs", {
    repo_path: repoPath,
    provider: "cursor",
    status: ["succeeded"],
    query: "PATCH_SAMPLE",
    limit: 10,
  });
  assert.equal(byQuery.jobs.length, 1);
  assert.equal(byQuery.jobs[0].job_id, patchJobId);
  assert.equal(byQuery.jobs[0].artifact_paths.result.endsWith("result.md"), true);
  assert.equal(byQuery.jobs[0].task_preview.includes("PATCH_SAMPLE"), true);
  assert.ok(byQuery.jobs[0].task_hash);
  assert.ok(byQuery.jobs[0].repo_head);

  const firstPage = await callTool(server, "search_jobs", {
    repo_path: repoPath,
    provider: "cursor",
    status: ["succeeded"],
    limit: 1,
  });
  assert.equal(firstPage.jobs.length, 1);
  assert.ok(firstPage.next_cursor);

  const secondPage = await callTool(server, "search_jobs", {
    repo_path: repoPath,
    provider: "cursor",
    status: ["succeeded"],
    limit: 1,
    cursor: firstPage.next_cursor,
  });
  assert.equal(secondPage.jobs.length, 1);
  assert.notEqual(firstPage.jobs[0].job_id, secondPage.jobs[0].job_id);
  assert.ok([analysisJobId, patchJobId].includes(firstPage.jobs[0].job_id));
  assert.ok([analysisJobId, patchJobId].includes(secondPage.jobs[0].job_id));

  const byResultPreview = await callTool(server, "search_jobs", {
    query: "FAKE_AGENT_OK",
    limit: 20,
  });
  assert.ok(byResultPreview.jobs.some((job) => job.job_id === analysisJobId));
}

async function assertParallelQueue(server) {
  const payload = await callTool(server, "delegate_tasks", {
    provider: "cursor",
    repo_path: repoPath,
    mode: "analysis",
    tasks: ["WAIT_600 A", "WAIT_600 B", "WAIT_600 C"],
    timeout_sec: 5,
  });
  const ids = payload.jobs.map((job) => job.job_id);
  let snapshot = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    snapshot = await callTool(server, "job_status", { job_ids: ids, tail_chars: 0 });
    const statuses = snapshot.jobs.map((job) => job.status);
    if (statuses.filter((status) => status === "running").length === 2 && statuses.includes("queued")) {
      break;
    }
    await sleep(50);
  }
  assert.equal(snapshot.jobs.filter((job) => job.status === "running").length, 2);
  assert.equal(snapshot.jobs.filter((job) => job.status === "queued").length, 1);
  for (const id of ids) {
    const status = await waitForTerminal(server, id);
    assert.equal(status.status, "succeeded");
  }
}

async function assertCancel(server) {
  const payload = await callTool(server, "delegate_tasks", {
    provider: "cursor",
    repo_path: repoPath,
    mode: "analysis",
    tasks: ["WAIT_2000 CANCEL_ME"],
    timeout_sec: 5,
  });
  const jobId = payload.jobs[0].job_id;
  await waitForStatus(server, jobId, "running");
  const cancelled = await callTool(server, "cancel_jobs", { job_ids: [jobId] });
  assert.equal(cancelled.jobs[0].cancelled, true);
  const status = await waitForTerminal(server, jobId);
  assert.equal(status.status, "cancelled");
}

async function assertTimeout(server) {
  const payload = await callTool(server, "delegate_tasks", {
    provider: "cursor",
    repo_path: repoPath,
    mode: "analysis",
    tasks: ["WAIT_2000 TIMEOUT_ME"],
    timeout_sec: 1,
  });
  const jobId = payload.jobs[0].job_id;
  const status = await waitForTerminal(server, jobId, 5000);
  assert.equal(status.status, "timed_out");
}

async function assertQualityFix(server) {
  const payload = await callTool(server, "quality_fix", {
    repo_path: repoPath,
    files: ["sample.py"],
    commands: ["ruff_format", "ruff_safe_fix"],
    timeout_sec: 5,
  });
  assert.equal(payload.commands.length, 2);
  assert.deepEqual(payload.newly_changed_files, ["sample.py"]);
  assert.equal(payload.safety_errors.length, 0);
  assert.match(fs.readFileSync(path.join(repoPath, "sample.py"), "utf8"), /# format/);
  assert.match(fs.readFileSync(path.join(repoPath, "sample.py"), "utf8"), /# check/);
}

async function assertCleanup(server, analysisJobId, patchJobId) {
  const payload = await callTool(server, "cleanup_jobs", {
    job_ids: [analysisJobId, patchJobId],
  });
  assert.equal(payload.jobs.length, 2);
  assert.equal(payload.jobs.every((job) => job.cleaned), true);
}

async function assertRestartOrphan(server) {
  const payload = await callTool(server, "delegate_tasks", {
    provider: "cursor",
    repo_path: repoPath,
    mode: "analysis",
    tasks: ["WAIT_3000 ORPHAN_ME"],
    timeout_sec: 10,
  });
  const jobId = payload.jobs[0].job_id;
  await waitForStatus(server, jobId, "running");
  server.child.kill("SIGTERM");
  await waitForExit(server.child);

  const restarted = startServer();
  try {
    await initialize(restarted);
    const status = await callTool(restarted, "job_status", { job_id: jobId, tail_chars: 0 });
    assert.equal(status.jobs[0].status, "orphaned");
    await callTool(restarted, "cleanup_jobs", { job_ids: [jobId], force: true });
  } finally {
    await stopServer(restarted);
  }
}

function waitForExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
  });
}

async function callTool(server, name, args) {
  const response = await server.request("tools/call", {
    name,
    arguments: args,
  }, 20000);
  if (response.error) {
    throw new Error(`${name} RPC error: ${JSON.stringify(response.error)}`);
  }
  assert.equal(response.result.isError, false, `${name} returned MCP error`);
  return JSON.parse(response.result.content[0].text);
}

async function waitForTerminal(server, jobId, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const payload = await callTool(server, "job_status", { job_id: jobId, tail_chars: 0 });
    const job = payload.jobs[0];
    if (["succeeded", "failed", "timed_out", "cancelled", "orphaned"].includes(job.status)) {
      return job;
    }
    await sleep(50);
  }
  throw new Error(`Timed out waiting for terminal status for ${jobId}`);
}

async function waitForStatus(server, jobId, expected, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const payload = await callTool(server, "job_status", { job_id: jobId, tail_chars: 0 });
    const job = payload.jobs[0];
    if (job.status === expected) {
      return job;
    }
    if (["succeeded", "failed", "timed_out", "cancelled", "orphaned"].includes(job.status)) {
      throw new Error(`Expected ${expected}, got terminal status ${job.status} for ${jobId}`);
    }
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${expected} status for ${jobId}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
