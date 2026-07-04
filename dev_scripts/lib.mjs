#!/usr/bin/env node

import {
  accessSync,
  constants,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

export { fileURLToPath, path, process };

export class Paths {
  constructor(importMetaUrl) {
    this.importMetaUrl = importMetaUrl;
  }

  scriptDir() {
    return path.dirname(fileURLToPath(this.importMetaUrl));
  }

  repoRootDir() {
    return path.resolve(this.scriptDir(), "..");
  }
}

export const ROOT_DIR = new Paths(import.meta.url).repoRootDir();

export const REPO_OWNER = "awalsh128";
export const REPO_NAME = "cache-apt-pkgs-action";
export const REPO_SLUG = `${REPO_OWNER}/${REPO_NAME}`;
export const REPO_URL = `https://github.com/${REPO_SLUG}.git`;
export const GITHUB_API_BASE_URL = "https://api.github.com";
export const GITHUB_USER_AGENT = `${REPO_NAME}-dev-scripts`;

export const VSCODE_SETTINGS_RELPATH = ".vscode/settings.json";
export const VSCODE_SETTINGS_DEFAULTS = {
  "chat.tools.terminal.autoApprove": {
    "*": true,
  },
  "chat.useAgentsMdFile": true,
};

export const CURRENT_NODE_VERSION = "24";

export function usage(scriptPath, params) {
  return `usage: ${path.basename(scriptPath)} ${params}`;
}

export function fail(message, exitCode = 1) {
  logError(message);
  process.exit(exitCode);
}

export function logInfo(message) {
  console.log(`ℹ️  ${message}`);
}

export function logSuccess(message) {
  console.log(`✅ ${message}`);
}

export function logWarn(message) {
  console.log(`⚠️  ${message}`);
}

export function logError(message) {
  console.error(`❌ ${message}`);
}

export function assertNonEmpty(value, message, usageMessage) {
  if (!value || value.trim().length === 0) {
    if (usageMessage) {
      console.error(usageMessage);
    }
    fail(message);
  }
}

export function commandExists(command) {
  const isExecutable = (candidatePath) => {
    try {
      accessSync(candidatePath, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };

  if (command.includes("/")) {
    return isExecutable(command);
  }

  const pathValue = process.env.PATH ?? "";
  const dirs = pathValue.split(path.delimiter).filter(Boolean);
  return dirs.some((dirPath) => isExecutable(path.join(dirPath, command)));
}

export function ensureDirExists(dirPath) {
  mkdirSync(dirPath, { recursive: true });
}

export function readJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

export function writeJsonFile(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function readNodeMajorVersion(rootDir = ROOT_DIR) {
  const nodeVersionPath = path.join(rootDir, ".node_ver");

  let fileText;
  try {
    fileText = readFileSync(nodeVersionPath, "utf8");
  } catch (error) {
    fail(
      `Missing or unreadable version file at ${nodeVersionPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const lines = fileText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length !== 1) {
    fail(".node_ver must contain exactly one non-empty line.");
  }

  const rawVersion = lines[0];
  if (!/^\d+$/.test(rawVersion)) {
    fail(
      ".node_ver must contain only the Node.js major version (e.g. 20, 24).",
    );
  }

  return rawVersion;
}

function normalizeRunOptions(optionsOrQuiet) {
  if (typeof optionsOrQuiet === "boolean") {
    return {
      cwd: ROOT_DIR,
      env: process.env,
      encoding: "utf8",
      stdio: optionsOrQuiet ? "pipe" : "inherit",
    };
  }

  const options = optionsOrQuiet ?? {};
  return {
    cwd: options.cwd ?? ROOT_DIR,
    env: options.env ?? process.env,
    encoding: options.encoding ?? "utf8",
    stdio:
      options.stdio ?? (options.stdout || options.stderr ? "pipe" : "inherit"),
  };
}

export function run(command, args = [], optionsOrQuiet = {}) {
  const options = normalizeRunOptions(optionsOrQuiet);
  try {
    return execFileSync(command, args, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to execute '${command} ${args.join(" ")}'. ${message}`,
    );
  }
}

export function tryRun(command, args = [], optionsOrQuiet = {}) {
  const options = normalizeRunOptions(optionsOrQuiet);
  const result = spawnSync(command, args, options);

  if (result.error) {
    throw new Error(
      `Failed to spawn '${command} ${args.join(" ")}'. ${result.error.message}`,
    );
  }

  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export function runCaptureOutput(command, args = [], options = {}) {
  return run(command, args, {
    ...options,
    stdout: "pipe",
    stderr: "pipe",
  }).trim();
}

export async function confirmPrompt(
  message,
  yesPattern = /^[yY]$/,
  noPattern = /^[nN]$/,
) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const getText = (pattern) =>
      pattern.source
        .trim()
        .replace(/^\^/, "")
        .replace(/\$$/, "")
        .replace(/\\([^\\])/g, "$1");
    while (true) {
      const answer = await rl
        .question(
          `${message} [${getText(yesPattern)} | ${getText(noPattern)}] `,
        )
        .then((ans) => ans.trim().toLowerCase());
      if (yesPattern.test(answer) || answer.trim() === "") {
        return;
      }
      if (noPattern.test(answer)) {
        fail("Aborted.", 0);
      }
      logError(
        `Invalid option '${answer}' selected. Options are: ${getText(yesPattern)} or ${getText(noPattern)}`,
      );
    }
  } finally {
    rl.close();
  }
}
