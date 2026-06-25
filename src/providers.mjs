import path from "node:path";
import { requireNonEmptyString, rpcError } from "./utils.mjs";

export const PROVIDERS = {
  cursor: {
    displayName: "Cursor Agent",
    binaryEnv: "CURSOR_AGENT_BIN",
    defaultBinary: "/usr/local/bin/cursor",
    versionArgs: ["agent", "--version"],
    capabilities: {
      supports_analysis: true,
      supports_sandbox_patch: "experimental",
      supports_models: true,
      safe_write_mode: "experimental_non_forced_headless",
    },
    buildArgs: ({ mode, prompt, workspacePath, model }) => {
      const args = [
        "agent",
        "--print",
        "--trust",
        "--workspace",
        workspacePath,
        "--output-format",
        "text",
      ];
      if (mode === "analysis") {
        args.push("--mode=plan");
      } else {
        args.push("--sandbox", "enabled");
      }
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
    capabilities: {
      supports_analysis: true,
      supports_sandbox_patch: true,
      supports_models: true,
      safe_write_mode: "auto_edit",
    },
    buildArgs: ({ mode, prompt, model }) => {
      const args = [
        "--prompt",
        prompt,
        "--approval-mode",
        mode === "analysis" ? "plan" : "auto_edit",
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
    outputFormat: "claude_stream_json",
    capabilities: {
      supports_analysis: true,
      supports_sandbox_patch: true,
      supports_models: true,
      safe_write_mode: "acceptEdits_with_restricted_tools",
    },
    buildArgs: ({ mode, prompt, model }) => {
      const args = [
        "--print",
        "--permission-mode",
        mode === "analysis" ? "plan" : "acceptEdits",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
      ];
      if (mode === "sandbox_patch") {
        args.push("--allowedTools", "Read,Edit,MultiEdit,Write,Glob,Grep,LS");
      }
      if (model) {
        args.push("--model", model);
      }
      args.push(prompt);
      return args;
    },
  },
};

export const DANGEROUS_FLAGS = new Set([
  "--force",
  "--yolo",
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
  "--permission-mode=bypassPermissions",
  "bypassPermissions",
]);

export function requireProvider(value) {
  const provider = requireNonEmptyString(value, "provider");
  if (!Object.hasOwn(PROVIDERS, provider)) {
    throw rpcError(-32602, `provider must be one of: ${Object.keys(PROVIDERS).join(", ")}`);
  }
  return provider;
}

export function resolveProviderBinary(provider) {
  return process.env[provider.binaryEnv] || provider.defaultBinary;
}

export function assertNoDangerousFlags(commandArgs) {
  const found = commandArgs.filter((arg) => DANGEROUS_FLAGS.has(arg));
  if (found.length) {
    throw rpcError(-32603, `provider adapter emitted dangerous flags: ${found.join(", ")}`);
  }
}

export function validateMode(value) {
  const mode = value ?? "analysis";
  if (mode !== "analysis" && mode !== "sandbox_patch") {
    throw rpcError(-32602, "mode must be analysis or sandbox_patch");
  }
  return mode;
}

export function buildAgentPrompt({ mode, repoPath, workspacePath, task, files, extraContext }) {
  const fileSection = files.length
    ? `Focus files:\n${files.map((file) => `- ${path.relative(repoPath, file)}`).join("\n")}\n\n`
    : "";
  const contextSection = extraContext ? `Extra context:\n${extraContext}\n\n` : "";
  const base = [
    mode === "analysis" ? "Read-only code analysis task." : "Sandboxed patch task.",
    `Original repository: ${repoPath}`,
    `Current workspace: ${workspacePath}`,
    "",
    fileSection.trimEnd(),
    contextSection.trimEnd(),
    "Instructions:",
  ];

  if (mode === "analysis") {
    base.push(
      "- Inspect only the code, docs, tests, and config needed for the task.",
      "- Do not edit files, run destructive commands, install dependencies, or change git state.",
      "- Return your result as free-form text with concrete repo-relative paths when useful.",
    );
  } else {
    base.push(
      "- You are running in an isolated git worktree created for this job.",
      "- Make only the edits needed for the task inside the current workspace.",
      "- Do not modify global config, install dependencies, or run destructive commands.",
      "- Return a concise free-form summary of what changed and any tests you ran or skipped.",
    );
  }

  base.push("", "Task:", task);
  return base.filter((part) => part !== "").join("\n");
}
