#!/usr/bin/env node

import { fail, logSuccess, readJsonFile, ROOT_DIR } from "./lib.mjs";

const tag = process.env.RELEASE_TAG;
if (!tag) {
  fail("RELEASE_TAG is required for release preflight checks.");
}

if (!/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(tag)) {
  fail(
    `Release tag '${tag}' is invalid. Expected semantic version format like v1.2.3 or v1.2.3-rc.1`,
  );
}

const packageJsonPath = `${ROOT_DIR}/package.json`;
const packageJson = readJsonFile(packageJsonPath);

if (
  typeof packageJson.version !== "string" ||
  packageJson.version.length === 0
) {
  fail("package.json version is missing or invalid.");
}

const expectedTag = `v${packageJson.version}`;
if (tag !== expectedTag) {
  fail(
    `Release tag and package version mismatch: RELEASE_TAG='${tag}' but package.json version='${packageJson.version}'. Expected tag '${expectedTag}'.`,
  );
}

logSuccess(
  `Release preflight passed for tag ${tag} and package version ${packageJson.version}.`,
);
