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
const fakeRuffPath = path.join(tempRoot, "fake-ruff.mjs");

fs.mkdirSync(repoPath);
fs.writeFileSync(path.join(repoPath, "sample.py"), "x=1\n");
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

function runGit(args) {
  const result = spawnSync("git", args, {
    cwd: repoPath,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

runGit(["init"]);
runGit(["add", "sample.py"]);
runGit(["-c", "user.email=test@example.com", "-c", "user.name=Smoke Test", "commit", "-m", "init"]);

const child = spawn(process.execPath, [serverPath], {
  cwd: root,
  env: {
    ...process.env,
    RUFF_BIN: fakeRuffPath,
    EXTERNAL_AGENT_ALLOWED_ROOTS: tempRoot,
  },
  stdio: ["pipe", "pipe", "pipe"],
});

const responses = new Map();
const stdout = readline.createInterface({ input: child.stdout });

stdout.on("line", (line) => {
  const message = JSON.parse(line);
  responses.set(message.id, message);
});

let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString("utf8");
});

function send(id, method, params = undefined) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
}

function notify(method, params = undefined) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

async function waitFor(id) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (responses.has(id)) {
      return responses.get(id);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for response ${id}. stderr=${stderr}`);
}

send(1, "initialize", {
  protocolVersion: "2024-11-05",
  clientInfo: { name: "smoke-test", version: "0.1.0" },
  capabilities: {},
});
let response = await waitFor(1);
assert.equal(response.result.serverInfo.name, "external-agent-mcp");
assert.equal(response.result.capabilities.tools instanceof Object, true);

notify("notifications/initialized");

send(2, "tools/list");
response = await waitFor(2);
const toolNames = response.result.tools.map((tool) => tool.name);
assert.deepEqual(toolNames.sort(), ["agent_status", "analyze_code", "quality_fix"]);

send(3, "tools/call", {
  name: "agent_status",
  arguments: { timeout_sec: 5 },
});
response = await waitFor(3);
assert.equal(response.result.isError, false);
const payload = JSON.parse(response.result.content[0].text);
assert.equal(payload.server, "external-agent-mcp");
assert.ok(payload.providers.cursor);
assert.ok(payload.providers.gemini);

send(4, "tools/call", {
  name: "quality_fix",
  arguments: {
    repo_path: repoPath,
    files: ["sample.py"],
    commands: ["ruff_format", "ruff_safe_fix"],
    timeout_sec: 5,
  },
});
response = await waitFor(4);
assert.equal(response.result.isError, false);
const qualityPayload = JSON.parse(response.result.content[0].text);
assert.equal(qualityPayload.commands.length, 2);
assert.deepEqual(qualityPayload.newly_changed_files, ["sample.py"]);
assert.equal(qualityPayload.safety_errors.length, 0);
assert.match(fs.readFileSync(path.join(repoPath, "sample.py"), "utf8"), /# format/);
assert.match(fs.readFileSync(path.join(repoPath, "sample.py"), "utf8"), /# check/);

child.stdin.end();
await new Promise((resolve, reject) => {
  child.once("exit", (code) => {
    if (code === 0) {
      resolve();
    } else {
      reject(new Error(`server exited ${code}. stderr=${stderr}`));
    }
  });
});

fs.rmSync(tempRoot, { recursive: true, force: true });

console.log("smoke ok");
