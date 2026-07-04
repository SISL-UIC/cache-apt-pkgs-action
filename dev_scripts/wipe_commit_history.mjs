#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import {
  ROOT_DIR,
  assertNonEmpty,
  fail,
  logInfo,
  logSuccess,
  logWarn,
  REPO_SLUG,
  run,
  runCaptureOutput,
  tryRun,
  usage,
} from "./lib.mjs";

const target = process.argv[2] ?? "";
const confirmFlag = process.argv[3] ?? "";
const usageMessage = usage(
  process.argv[1],
  "<target branch> --confirm-destructive",
);

assertNonEmpty(target, "Target branch is empty", usageMessage);

if (confirmFlag !== "--confirm-destructive") {
  fail(
    "WARNING: This operation force-rewrites history and has irreversible side effects.\n" +
      "To proceed, re-run the command with the --confirm-destructive flag.",
  );
}

const rootDir = ROOT_DIR;
const timestamp = new Date().toISOString().replace(/[:T]/g, "_").slice(0, 19);
function ensureRepo() {
  logInfo(`Ensuring ${rootDir} is a git repository...`);
  if (
    !tryRun("git", ["rev-parse", "--is-inside-work-tree"], { cwd: rootDir }).ok
  ) {
    fail(`${rootDir} is not a git repository`);
  }
}

function resolveTargetRef(branch) {
  if (
    tryRun("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
      cwd: rootDir,
    }).ok
  ) {
    logInfo(`Target branch ${branch} exists locally.`);
    return branch;
  }

  if (
    tryRun(
      "git",
      ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`],
      { cwd: rootDir },
    ).ok
  ) {
    return `origin/${branch}`;
  }

  fail(`Target branch ${branch} does not exist locally or on origin`);
}

function listGitHubRunIds() {
  const output = runCaptureOutput(
    "gh",
    ["run", "list", "--limit", "1000", "--json", "databaseId"],
    { cwd: rootDir },
  );

  if (!output) {
    logWarn("No GitHub workflow runs found.");
    return [];
  }

  let runs;
  try {
    runs = JSON.parse(output);
    logInfo(`Found ${runs.length} GitHub workflow run(s) to delete.\n`);
  } catch (error) {
    fail(
      `Unable to parse gh run list response: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!Array.isArray(runs)) {
    logWarn("No GitHub workflow runs found.");
    return [];
  }

  return runs
    .map((runEntry) => String(runEntry?.databaseId ?? "").trim())
    .filter((runId) => /^\d+$/.test(runId));
}

function deleteGitHubRuns() {
  const runIds = listGitHubRunIds();
  if (runIds.length === 0) {
    logInfo("No GitHub workflow runs found to delete.");
    return;
  }

  logInfo(`Deleting ${runIds.length} GitHub workflow run(s)...`);
  for (const runId of runIds) {
    run("gh", ["run", "delete", runId, "--repo", REPO_SLUG], {
      cwd: rootDir,
    });
  }
}

function main() {
  ensureRepo();

  const targetRef = resolveTargetRef(target);
  const backupBranch = `backup/pre-wipe-${target}-${timestamp}`;
  const backupTag = `pre-wipe-${target}-${timestamp}`;
  const mirrorDir = path.resolve(
    rootDir,
    "..",
    `cache-apt-pkgs-action.mirror-backup.${timestamp}.git`,
  );

  logInfo(`Creating mirror backup at ${mirrorDir}...`);
  if (tryRun("test", ["-d", mirrorDir]).ok) {
    fail(`${mirrorDir} already exists`);
  }

  logInfo(`Cloning ${rootDir} to mirror backup...`);
  run("git", ["clone", "--mirror", ".", mirrorDir], { cwd: rootDir });

  logInfo(`Creating backup refs from ${targetRef}...`);
  run("git", ["branch", backupBranch, targetRef], { cwd: rootDir });
  run(
    "git",
    [
      "tag",
      "-a",
      backupTag,
      "-m",
      `Backup before history rewrite of ${target}`,
      targetRef,
    ],
    { cwd: rootDir },
  );
  logInfo(`Pushing backup refs ${backupBranch} and ${backupTag} to origin...`);
  run("git", ["push", "origin", `refs/heads/${backupBranch}`], {
    cwd: rootDir,
  });
  run("git", ["push", "origin", `refs/tags/${backupTag}`], { cwd: rootDir });

  logSuccess("Backup complete. Recovery refs:");
  logSuccess(`  branch: ${backupBranch}`);
  logSuccess(`  tag:    ${backupTag}`);
  logSuccess(`  mirror: ${mirrorDir}`);
  logWarn("To restore original history later:");
  logWarn(
    `  git push --force origin refs/heads/${backupBranch}:refs/heads/${target}`,
  );

  logInfo(`Rewriting history of ${target}...`);
  run("git", ["checkout", "-B", target, targetRef], { cwd: rootDir });
  run("git", ["checkout", "--orphan", `temp_wipe_${target}`], { cwd: rootDir });
  run("git", ["add", "-A"], { cwd: rootDir });
  run("git", ["commit", "-m", "Initial commit"], { cwd: rootDir });
  run("git", ["branch", "-D", target], { cwd: rootDir });
  run("git", ["branch", "-m", target], { cwd: rootDir });
  logInfo(`Force-pushing rewritten history to origin/${target}...`);
  run("git", ["push", "--force", "origin", target], { cwd: rootDir });

  logInfo("Deleting GitHub workflow runs associated with the old history...");
  deleteGitHubRuns();

  logSuccess("Wipe commit history complete.");
}

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
