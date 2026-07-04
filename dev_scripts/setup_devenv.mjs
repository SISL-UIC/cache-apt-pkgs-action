#!/usr/bin/env node

import { existsSync } from "node:fs";
import {
  ROOT_DIR,
  commandExists,
  ensureDirExists,
  fail,
  logError,
  logInfo,
  logSuccess,
  logWarn,
  readNodeMajorVersion,
  readJsonFile,
  run,
  tryRun,
  VSCODE_SETTINGS_DEFAULTS,
  VSCODE_SETTINGS_RELPATH,
  writeJsonFile,
} from "./lib.mjs";

function ensureVscodeSettingsFile() {
  const vscodeDir = `${ROOT_DIR}/.vscode`;
  const vscodeSettingsPath = `${ROOT_DIR}/${VSCODE_SETTINGS_RELPATH}`;

  ensureDirExists(vscodeDir);

  if (!existsSync(vscodeSettingsPath)) {
    writeJsonFile(vscodeSettingsPath, VSCODE_SETTINGS_DEFAULTS);
    logWarn(`Created missing ${vscodeSettingsPath}`);
  }

  return vscodeSettingsPath;
}

function loadVscodeSettingsJson() {
  const vscodeSettingsPath = ensureVscodeSettingsFile();
  return {
    vscodeSettingsPath,
    vscodeSettingsJson: readJsonFile(vscodeSettingsPath),
  };
}

function ensureAgentsFilesUsed() {
  const { vscodeSettingsPath, vscodeSettingsJson } = loadVscodeSettingsJson();

  if (!vscodeSettingsJson["chat.useAgentsMdFile"]) {
    vscodeSettingsJson["chat.useAgentsMdFile"] = true;
    writeJsonFile(vscodeSettingsPath, vscodeSettingsJson);
    logWarn(
      `Updated ${vscodeSettingsPath} to enable chat.useAgentsMdFile for AGENTS.md support.`,
    );
  }
}

function ensureAptDependencies() {
  if (!commandExists("apt-get")) {
    fail("apt-get is required for system dependency installation.");
  }

  const aptPackages = [
    ["git", "git"],
    ["gh", "gh"],
    ["jq", "jq"],
    ["curl", "curl"],
    ["shellcheck", "shellcheck"],
    ["flock", "util-linux"],
  ];

  const missingPackages = [
    ...new Set(
      aptPackages
        .filter(([command]) => !commandExists(command))
        .map(([, packageName]) => packageName),
    ),
  ];

  if (missingPackages.length === 0) {
    logSuccess("All required apt CLI dependencies are already installed.");
    return;
  }

  const aptRunner = commandExists("sudo")
    ? (args) => run("sudo", ["apt-get", ...args])
    : (args) => run("apt-get", args);

  logInfo(`Installing missing apt packages: ${missingPackages.join(" ")}`);
  aptRunner(["update"]);
  aptRunner(["install", "-y", ...missingPackages]);
}

function ensureNodeDependencies(nodeVersionMajor) {
  if (!commandExists("npm")) {
    fail(
      `npm is required but not installed. Install Node.js >=${nodeVersionMajor} first.`,
    );
  }

  // Fast deterministic install path aligned with lockfile-based CI behavior.
  logInfo(
    "Installing npm dependencies (including devDependencies) via npm ci...",
  );
  run("npm", ["ci", "--include=dev"]);
}

function parseAuditJson(outputText) {
  if (!outputText || outputText.trim().length === 0) {
    fail("npm audit produced empty output.");
  }

  try {
    return JSON.parse(outputText);
  } catch {
    const firstBraceIndex = outputText.indexOf("{");
    const lastBraceIndex = outputText.lastIndexOf("}");
    if (firstBraceIndex >= 0 && lastBraceIndex > firstBraceIndex) {
      return JSON.parse(outputText.slice(firstBraceIndex, lastBraceIndex + 1));
    }
    fail("Unable to parse npm audit JSON output.");
  }
}

function getAuditCounts() {
  const audit = tryRun("npm", ["audit", "--json"], {
    cwd: ROOT_DIR,
    stdio: "pipe",
  });

  const report = parseAuditJson(audit.stdout ?? "");
  const vulnerabilities = report?.metadata?.vulnerabilities ?? {};

  return {
    critical: Number(vulnerabilities.critical ?? 0),
    high: Number(vulnerabilities.high ?? 0),
  };
}

function runAuditFix(force = false) {
  const args = force ? ["audit", "fix", "--force"] : ["audit", "fix"];
  const result = tryRun("npm", args, {
    cwd: ROOT_DIR,
    stdio: "inherit",
  });

  if (!result.ok) {
    logWarn(
      `npm ${args.join(" ")} exited with code ${result.status ?? "unknown"}. Continuing to verification...`,
    );
  }
}

function ensureAuditRemediation() {
  let counts = getAuditCounts();
  logInfo(`Audit baseline: high=${counts.high}, critical=${counts.critical}.`);

  if (counts.high === 0 && counts.critical === 0) {
    logSuccess("No high/critical npm vulnerabilities detected.");
    return;
  }

  logWarn(
    `Detected vulnerabilities: high=${counts.high}, critical=${counts.critical}. Running npm audit fix...`,
  );
  runAuditFix(false);
  counts = getAuditCounts();
  logInfo(
    `Audit after npm audit fix: high=${counts.high}, critical=${counts.critical}.`,
  );

  if (counts.high === 0 && counts.critical === 0) {
    logSuccess(
      "High/critical npm vulnerabilities remediated with npm audit fix.",
    );
    return;
  }

  logWarn(
    `High/critical vulnerabilities remain: high=${counts.high}, critical=${counts.critical}. Running npm audit fix --force...`,
  );
  runAuditFix(true);
  counts = getAuditCounts();
  logInfo(
    `Audit after npm audit fix --force: high=${counts.high}, critical=${counts.critical}.`,
  );

  if (counts.high > 0 || counts.critical > 0) {
    fail(
      `Unable to remediate all high/critical vulnerabilities: high=${counts.high}, critical=${counts.critical}.`,
    );
  }

  logSuccess("High/critical npm vulnerabilities remediated.");
}

async function main() {
  const nodeVersionMajor = readNodeMajorVersion();
  logInfo("Ensuring .vscode settings file present...");
  ensureVscodeSettingsFile();
  logInfo("Ensuring chat.useAgentsMdFile is enabled...");
  ensureAgentsFilesUsed();
  logInfo("Ensuring required APT dependencies are installed...");
  ensureAptDependencies();
  logInfo(
    `Setting up development environment for Node.js v${nodeVersionMajor}.x...`,
  );
  ensureNodeDependencies(nodeVersionMajor);
  ensureAuditRemediation();
  logSuccess("Development environment setup complete.");
}

try {
  await main();
} catch (error) {
  logError(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
