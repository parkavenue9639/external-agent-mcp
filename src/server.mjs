#!/usr/bin/env node

import readline from "node:readline";
import {
  JSON_RPC_VERSION,
  MAX_OUTPUT_CHARS,
  DEFAULT_MAX_OUTPUT_CHARS,
  DEFAULT_TIMEOUT_SEC,
  MAX_TIMEOUT_SEC,
  DEFAULT_QUALITY_TIMEOUT_SEC,
  MAX_QUALITY_TIMEOUT_SEC,
  DEFAULT_MAX_CHANGED_FILES,
  MAX_CHANGED_FILES,
  SERVER_NAME,
  SERVER_VERSION,
  log,
  toolResult,
} from "./utils.mjs";
import {
  agentStatus,
  analyzeCode,
  cancelJobs,
  cleanupJobs,
  delegateTasks,
  initializeJobs,
  jobResult,
  jobStatus,
  searchJobs,
} from "./jobs.mjs";
import { PROVIDERS } from "./providers.mjs";
import { QUALITY_COMMANDS, qualityFix } from "./quality.mjs";

initializeJobs();

const providerNames = Object.keys(PROVIDERS);
const modeSchema = { type: "string", enum: ["analysis", "sandbox_patch"] };
const statusSchema = {
  type: "string",
  enum: ["queued", "running", "succeeded", "failed", "timed_out", "cancelled", "orphaned"],
};
const providerSchema = {
  type: "string",
  enum: providerNames,
  description: "External agent CLI provider.",
};

const tools = [
  {
    name: "delegate_tasks",
    description:
      "Create one or more asynchronous external-agent jobs. Use job_status and job_result to inspect completion and artifacts.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["repo_path", "provider", "tasks"],
      properties: {
        repo_path: {
          type: "string",
          description: "Absolute path to the repository/workspace.",
        },
        provider: providerSchema,
        model: {
          type: "string",
          description: "Provider-specific model override chosen by the caller.",
        },
        mode: {
          ...modeSchema,
          description: "analysis runs read-only in the repo; sandbox_patch runs in an isolated git worktree.",
        },
        files: focusFilesSchema(),
        extra_context: { type: "string" },
        timeout_sec: timeoutSchema(DEFAULT_TIMEOUT_SEC, MAX_TIMEOUT_SEC),
        max_output_chars: outputLimitSchema(),
        base_ref: {
          type: "string",
          description: "Git ref used for sandbox_patch worktree creation. Defaults to HEAD.",
        },
        tasks: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          items: {
            anyOf: [
              { type: "string" },
              {
                type: "object",
                additionalProperties: false,
                required: ["task"],
                properties: {
                  task: { type: "string" },
                  title: { type: "string" },
                  provider: providerSchema,
                  model: { type: "string" },
                  mode: modeSchema,
                  files: focusFilesSchema(),
                  extra_context: { type: "string" },
                  timeout_sec: timeoutSchema(DEFAULT_TIMEOUT_SEC, MAX_TIMEOUT_SEC),
                  max_output_chars: outputLimitSchema(),
                  base_ref: { type: "string" },
                },
              },
            ],
          },
        },
      },
    },
  },
  {
    name: "job_status",
    description:
      "Read asynchronous job status, including stdout/stderr tails. If no job_ids are supplied, returns recent jobs.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        job_id: { type: "string" },
        job_ids: {
          type: "array",
          items: { type: "string" },
        },
        tail_chars: {
          type: "number",
          description: "Number of trailing stdout/stderr characters to include. Defaults to 4000.",
        },
        limit: {
          type: "number",
          description: "Recent job count when job_ids are omitted. Defaults to 20.",
        },
      },
    },
  },
  {
    name: "job_result",
    description:
      "Read completed or in-progress job outputs, free-form result text, diff metadata, and artifact paths.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        job_id: { type: "string" },
        job_ids: {
          type: "array",
          items: { type: "string" },
        },
        max_output_chars: outputLimitSchema(),
        include_stderr: {
          type: "boolean",
          description: "Include stderr text. Defaults to true.",
        },
      },
    },
  },
  {
    name: "search_jobs",
    description:
      "Search historical external-agent jobs by metadata and lightweight previews. Use job_result for full artifacts.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        repo_path: {
          type: "string",
          description: "Optional exact repository path filter.",
        },
        provider: providerSchema,
        model: {
          type: "string",
          description: "Optional exact model filter.",
        },
        mode: modeSchema,
        status: {
          type: "array",
          items: statusSchema,
          description: "Optional status filter. Matches any listed status.",
        },
        created_after: {
          type: "string",
          description: "Optional ISO timestamp lower bound for created_at.",
        },
        created_before: {
          type: "string",
          description: "Optional ISO timestamp upper bound for created_at.",
        },
        query: {
          type: "string",
          description: "Case-insensitive substring search over task/title/result preview/path metadata.",
        },
        limit: {
          type: "number",
          description: "Maximum jobs to return. Defaults to 20; capped at 100.",
        },
        cursor: {
          type: "string",
          description: "Opaque pagination cursor returned by a previous search_jobs call.",
        },
      },
    },
  },
  {
    name: "cancel_jobs",
    description: "Cancel queued or running asynchronous jobs.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["job_ids"],
      properties: {
        job_ids: {
          type: "array",
          items: { type: "string" },
        },
      },
    },
  },
  {
    name: "cleanup_jobs",
    description:
      "Remove terminal job logs/artifacts and associated sandbox worktrees. Non-terminal jobs require force=true.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["job_ids"],
      properties: {
        job_ids: {
          type: "array",
          items: { type: "string" },
        },
        force: {
          type: "boolean",
          description: "Allow cleanup of non-terminal jobs after sending SIGTERM.",
        },
      },
    },
  },
  {
    name: "analyze_code",
    description:
      "Deprecated compatibility wrapper around delegate_tasks for one read-only analysis job. Prefer delegate_tasks + job_result.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["provider", "repo_path", "task"],
      properties: {
        provider: providerSchema,
        repo_path: {
          type: "string",
          description: "Absolute path to the repository or workspace to analyze.",
        },
        task: {
          type: "string",
          description: "Concrete read-only code analysis task for the external agent.",
        },
        files: focusFilesSchema(),
        extra_context: { type: "string" },
        model: { type: "string" },
        timeout_sec: timeoutSchema(DEFAULT_TIMEOUT_SEC, MAX_TIMEOUT_SEC),
        max_output_chars: outputLimitSchema(),
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
      "Check configured external CLI agent binaries and report provider capability metadata.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        provider: providerSchema,
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
        files: focusFilesSchema(),
        commands: {
          type: "array",
          items: {
            type: "string",
            enum: Object.keys(QUALITY_COMMANDS),
          },
          description: "Quality commands to run. Defaults to ruff_format and ruff_safe_fix.",
        },
        allow_repo_wide: {
          type: "boolean",
          description: "Allow running commands over the whole repo with target '.'. Defaults to false.",
        },
        allow_unsafe_fixes: {
          type: "boolean",
          description: "Required to run ruff_unsafe_fix. Defaults to false.",
        },
        timeout_sec: timeoutSchema(DEFAULT_QUALITY_TIMEOUT_SEC, MAX_QUALITY_TIMEOUT_SEC),
        max_output_chars: outputLimitSchema(),
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

let inputClosed = false;
let pendingRequests = 0;

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

  pendingRequests += 1;
  try {
    const result = await handleRequest(request);
    writeResponse(request.id, result);
  } catch (error) {
    const code = Number.isInteger(error.code) ? error.code : -32603;
    writeError(request.id, code, error.message, error.data);
  } finally {
    pendingRequests -= 1;
    maybeExitAfterInputClose();
  }
});

rl.on("close", () => {
  inputClosed = true;
  maybeExitAfterInputClose();
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
      throw Object.assign(new Error(`Method not found: ${request.method}`), { code: -32601 });
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
    case "delegate_tasks":
      return toolResult(await delegateTasks(args));
    case "job_status":
      return toolResult(await jobStatus(args));
    case "job_result":
      return toolResult(await jobResult(args));
    case "search_jobs":
      return toolResult(await searchJobs(args));
    case "cancel_jobs":
      return toolResult(await cancelJobs(args));
    case "cleanup_jobs":
      return toolResult(await cleanupJobs(args));
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

function focusFilesSchema() {
  return {
    type: "array",
    items: { type: "string" },
    description:
      "Optional repo-relative or absolute file paths to focus on. Absolute paths must stay under repo_path.",
  };
}

function timeoutSchema(defaultValue, maxValue) {
  return {
    type: "number",
    description: `Timeout in seconds. Defaults to ${defaultValue}; capped at ${maxValue}.`,
  };
}

function outputLimitSchema() {
  return {
    type: "number",
    description: `Maximum returned output characters. Defaults to ${DEFAULT_MAX_OUTPUT_CHARS}; capped at ${MAX_OUTPUT_CHARS}.`,
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

function maybeExitAfterInputClose() {
  if (inputClosed && pendingRequests === 0) {
    process.exit(0);
  }
}
