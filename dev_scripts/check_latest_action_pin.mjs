#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

function usage() {
  console.error(
    "usage: node dev_scripts/check_latest_action_pin.mjs <owner/repo[/path]@ref | owner/repo[/path] ref | --scan [directory]>",
  );
}

function parseInput(argv) {
  if (argv[0] === "--scan") {
    return {
      mode: "scan",
      rootDir: argv[1] ?? ".github",
    };
  }

  if (argv.length === 1) {
    const atIndex = argv[0].lastIndexOf("@");
    if (atIndex <= 0 || atIndex === argv[0].length - 1) {
      usage();
      process.exit(1);
    }

    return {
      mode: "single",
      actionPath: argv[0].slice(0, atIndex),
      currentRef: argv[0].slice(atIndex + 1),
    };
  }

  if (argv.length === 2) {
    return {
      mode: "single",
      actionPath: argv[0],
      currentRef: argv[1],
    };
  }

  usage();
  process.exit(1);
}

function parseRepoSlug(actionPath) {
  const parts = actionPath.split("/").filter(Boolean);
  if (parts.length < 2) {
    throw new Error(
      `Action path '${actionPath}' must include at least owner/repo.`,
    );
  }

  return `${parts[0]}/${parts[1]}`;
}

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function buildTagMap(repoSlug) {
  const remoteUrl = `https://github.com/${repoSlug}.git`;
  const output = git(["ls-remote", "--tags", remoteUrl]);
  const tagMap = new Map();

  for (const line of output.split("\n")) {
    if (!line.trim()) {
      continue;
    }

    const [sha, ref] = line.split(/\s+/);
    const prefix = "refs/tags/";
    if (!sha || !ref || !ref.startsWith(prefix)) {
      continue;
    }

    const rawTag = ref.slice(prefix.length);
    const isPeeled = rawTag.endsWith("^{}");
    const tag = isPeeled ? rawTag.slice(0, -3) : rawTag;
    if (isPeeled || !tagMap.has(tag)) {
      tagMap.set(tag, sha.toLowerCase());
    }
  }

  return tagMap;
}

function resolveRefSha(repoSlug, ref, tagMap) {
  const normalizedRef = ref.toLowerCase();
  if (/^[0-9a-f]{40}$/.test(normalizedRef)) {
    return normalizedRef;
  }

  if (tagMap.has(ref)) {
    return tagMap.get(ref);
  }

  const remoteUrl = `https://github.com/${repoSlug}.git`;
  const output = git(["ls-remote", remoteUrl, ref]);
  const firstLine = output.split("\n")[0] ?? "";
  const [sha] = firstLine.split(/\s+/);
  if (!sha) {
    throw new Error(`Unable to resolve ref '${ref}' for ${repoSlug}.`);
  }

  return sha.toLowerCase();
}

async function fetchJson(url) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "cache-apt-pkgs-action-pin-checker",
  };

  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  const response = await fetch(url, { headers });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API request failed (${response.status}): ${body}`);
  }

  return response.json();
}

async function getLatestRelease(repoSlug) {
  return fetchJson(`https://api.github.com/repos/${repoSlug}/releases/latest`);
}

async function getReleases(repoSlug) {
  const releases = await fetchJson(
    `https://api.github.com/repos/${repoSlug}/releases?per_page=100`,
  );
  return Array.isArray(releases) ? releases : [];
}

function findReleaseBySha(releases, tagMap, sha) {
  return (
    releases.find(
      (release) => tagMap.get(release.tag_name)?.toLowerCase() === sha,
    ) ?? null
  );
}

function printField(label, value) {
  console.log(`${label}: ${value ?? "none"}`);
}

function walkFiles(rootDir) {
  const results = [];

  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(fullPath));
      continue;
    }

    if (entry.name.endsWith(".yml") || entry.name.endsWith(".yaml")) {
      results.push(fullPath);
    }
  }

  return results.sort((a, b) => a.localeCompare(b));
}

function findActionPins(rootDir) {
  const results = [];
  const usesPattern = /^\s*uses:\s*["']?([^"'\s#]+)["']?/;

  for (const filePath of walkFiles(rootDir)) {
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split(/\r?\n/);

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const match = usesPattern.exec(line);
      if (!match) {
        continue;
      }

      const spec = match[1] ?? "";
      if (
        !spec.includes("@") ||
        spec.startsWith("./") ||
        spec.startsWith("docker://")
      ) {
        continue;
      }

      const atIndex = spec.lastIndexOf("@");
      const actionPath = spec.slice(0, atIndex);
      const currentRef = spec.slice(atIndex + 1);
      if (!actionPath || !currentRef) {
        continue;
      }

      results.push({
        filePath,
        lineNumber: index + 1,
        actionPath,
        currentRef,
      });
    }
  }

  return results;
}

const repoCache = new Map();

async function getRepoData(repoSlug) {
  const cached = repoCache.get(repoSlug);
  if (cached) {
    return cached;
  }

  const promise = (async () => {
    const tagMap = buildTagMap(repoSlug);
    const [latestRelease, releases] = await Promise.all([
      getLatestRelease(repoSlug),
      getReleases(repoSlug),
    ]);
    return { tagMap, latestRelease, releases };
  })();

  repoCache.set(repoSlug, promise);
  return promise;
}

async function analyzeAction(actionPath, currentRef) {
  const repoSlug = parseRepoSlug(actionPath);
  const { tagMap, latestRelease, releases } = await getRepoData(repoSlug);
  const currentSha = resolveRefSha(repoSlug, currentRef, tagMap);
  const currentRelease = findReleaseBySha(releases, tagMap, currentSha);
  const latestSha = latestRelease
    ? (tagMap.get(latestRelease.tag_name) ?? null)
    : null;
  const isCurrent = latestSha !== null && latestSha === currentSha;

  return {
    actionPath,
    repoSlug,
    currentRef,
    currentSha,
    currentRelease,
    latestRelease,
    latestSha,
    isCurrent,
  };
}

function printAnalysis(analysis) {
  console.log(`Action: ${analysis.actionPath}`);
  printField("Repository", analysis.repoSlug);
  printField("Current ref", analysis.currentRef);
  printField("Current sha", analysis.currentSha);
  printField("Current release", analysis.currentRelease?.tag_name ?? null);
  printField("Current release URL", analysis.currentRelease?.html_url ?? null);
  printField("Latest release", analysis.latestRelease?.tag_name ?? null);
  printField(
    "Latest pin",
    analysis.latestSha ? `${analysis.actionPath}@${analysis.latestSha}` : null,
  );
  printField("Latest release URL", analysis.latestRelease?.html_url ?? null);
  printField(
    "Status",
    analysis.latestSha === null
      ? "no release found"
      : analysis.isCurrent
        ? "up to date"
        : "update available",
  );
}

async function main() {
  const input = parseInput(process.argv.slice(2));

  if (input.mode === "scan") {
    const rootDir = path.resolve(process.cwd(), input.rootDir);
    const pins = findActionPins(rootDir);
    if (pins.length === 0) {
      console.log(`No pinned GitHub Actions found under ${input.rootDir}.`);
      return;
    }

    let updateCount = 0;
    for (const pin of pins) {
      const analysis = await analyzeAction(pin.actionPath, pin.currentRef);
      console.log(`File: ${pin.filePath}:${pin.lineNumber}`);
      printAnalysis(analysis);
      console.log("");
      if (analysis.latestSha && !analysis.isCurrent) {
        updateCount += 1;
      }
    }

    console.log(`Scanned ${pins.length} pinned action reference(s).`);
    console.log(`Updates available: ${updateCount}`);
    if (updateCount > 0) {
      process.exitCode = 2;
    }
    return;
  }

  const analysis = await analyzeAction(input.actionPath, input.currentRef);
  printAnalysis(analysis);

  if (analysis.latestSha && !analysis.isCurrent) {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
