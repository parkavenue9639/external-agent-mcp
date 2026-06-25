import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { appendLimited } from "./utils.mjs";

export async function runCommand({ command, args, cwd, timeoutMs, maxChars, stdin, env }) {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let killTimer = null;
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;

    const child = spawn(command, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: [stdin == null ? "ignore" : "pipe", "pipe", "pipe"],
    });

    if (stdin != null) {
      child.stdin.end(stdin);
    }

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 5000);
    }, timeoutMs);

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
      if (killTimer) {
        clearTimeout(killTimer);
      }
      reject(error);
    });

    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      resolve({
        exitCode,
        signal,
        timedOut,
        stdout,
        stdoutTruncated,
        stderr,
        stderrTruncated,
      });
    });
  });
}

export function spawnToFiles({
  command,
  args,
  cwd,
  timeoutMs,
  stdoutPath,
  stderrPath,
  stdin,
  env,
  onChild,
}) {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let killTimer = null;
    fs.mkdirSync(path.dirname(stdoutPath), { recursive: true });
    fs.mkdirSync(path.dirname(stderrPath), { recursive: true });

    const stdout = fs.createWriteStream(stdoutPath, { flags: "a" });
    const stderr = fs.createWriteStream(stderrPath, { flags: "a" });
    const child = spawn(command, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (stdin != null) {
      child.stdin.end(stdin);
    } else {
      child.stdin.end();
    }

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 5000);
    }, timeoutMs);

    child.stdout.on("data", (chunk) => stdout.write(chunk));
    child.stderr.on("data", (chunk) => stderr.write(chunk));

    if (onChild) {
      onChild(child);
    }

    child.on("error", (error) => {
      clearTimeout(timer);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      stdout.destroy();
      stderr.destroy();
      reject(error);
    });

    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      stdout.end(() => {
        stderr.end(() => {
          resolve({
            exitCode,
            signal,
            timedOut,
          });
        });
      });
    });
  });
}
