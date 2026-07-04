#!/usr/bin/env node

import {
  ROOT_DIR,
  fail,
  logError,
  logInfo,
  logSuccess,
  runCaptureOutput,
  REPO_SLUG,
} from "./lib.mjs";

import packageJson from "../package.json" with { type: "json" };
import vscodeSettingsJson from "../.vscode/settings.json" with { type: "json" };
import tsconfigJson from "../tsconfig.json" with { type: "json" };
import typedocJson from "../typedoc.json" with { type: "json" };

function tokenizePath(pathExpression) {
  const tokens = [];
  let index = 0;

  while (index < pathExpression.length) {
    const ch = pathExpression[index];

    if (ch === ".") {
      index += 1;
      continue;
    }

    if (ch === "[") {
      const endIndex = pathExpression.indexOf("]", index);
      if (endIndex < 0) {
        throw new Error(`Invalid path expression '${pathExpression}'`);
      }

      const indexText = pathExpression.slice(index + 1, endIndex).trim();
      if (!/^\d+$/.test(indexText)) {
        throw new Error(`Invalid array index in path '${pathExpression}'`);
      }

      tokens.push(Number(indexText));
      index = endIndex + 1;
      continue;
    }

    let endIndex = index;
    while (
      endIndex < pathExpression.length &&
      pathExpression[endIndex] !== "." &&
      pathExpression[endIndex] !== "["
    ) {
      endIndex += 1;
    }

    tokens.push(pathExpression.slice(index, endIndex));
    index = endIndex;
  }

  return tokens;
}

function getByPath(root, pathExpression) {
  const tokens = tokenizePath(pathExpression);
  let cursor = root;

  for (const token of tokens) {
    if (typeof token === "number") {
      if (!Array.isArray(cursor) || token < 0 || token >= cursor.length) {
        return { found: false, value: undefined };
      }
      cursor = cursor[token];
      continue;
    }

    if (cursor === null || typeof cursor !== "object") {
      return { found: false, value: undefined };
    }

    if (!Object.prototype.hasOwnProperty.call(cursor, token)) {
      return { found: false, value: undefined };
    }

    cursor = cursor[token];
  }

  return { found: true, value: cursor };
}

function createErrorCollector(fileLabel) {
  const errors = [];
  return {
    errors,
    add(message) {
      errors.push(`${fileLabel}: ${message}`);
    },
  };
}

function valueType(value) {
  if (Array.isArray(value)) {
    return "array";
  }

  if (value === null) {
    return "null";
  }

  return typeof value;
}

function expectFieldType(doc, fieldPath, expectedType, addError) {
  const result = getByPath(doc, fieldPath);
  if (!result.found) {
    addError(`missing required field '${fieldPath}'`);
    return;
  }

  const actualType = valueType(result.value);
  if (actualType !== expectedType) {
    addError(
      `field '${fieldPath}' type '${actualType}' does not match expected '${expectedType}'`,
    );
  }
}

function expectFieldValue(
  doc,
  fieldPath,
  expectedValue,
  addError,
  errorMessage,
) {
  const result = getByPath(doc, fieldPath);
  if (!result.found) {
    addError(`missing required field '${fieldPath}'`);
    return;
  }

  if (result.value !== expectedValue) {
    addError(
      `field '${fieldPath}' value '${result.value}' does not match expected '${expectedValue}'${errorMessage ? `: ${errorMessage}` : ""}`,
    );
  }
}

function validatePackageJson(json) {
  const { errors, add } = createErrorCollector("package.json");
  logInfo("Validating package.json...");

  expectFieldValue(json, "name", "cache-apt-pkgs-action", add);
  expectFieldValue(
    json,
    "version",
    "0.0.0-semantically-released",
    add,
    "version is updated automatically by semantic-release and should not be changed manually",
  );
  expectFieldValue(json, "license", "Apache-2.0", add);
  expectFieldValue(json, "repository.type", "git", add);
  expectFieldValue(
    json,
    "repository.url",
    `https://github.com/${REPO_SLUG}.git`,
    add,
  );

  return errors;
}

function validateTsconfigJson(json) {
  logInfo("Validating tsconfig.json...");
  const { errors, add } = createErrorCollector("tsconfig.json");

  expectFieldType(json, "extends", "string", add);
  expectFieldType(json, "compilerOptions", "object", add);

  return errors;
}

function validateTypedocJson(json) {
  logInfo("Validating typedoc.json...");
  const { errors, add } = createErrorCollector("typedoc.json");

  expectFieldType(json, "entryPoints", "array", add);
  expectFieldType(json, "out", "string", add);

  return errors;
}

function validateVscodeSettingsJson(json) {
  logInfo("Validating .vscode/settings.json...");
  const { errors, add } = createErrorCollector(".vscode/settings.json");

  expectFieldType(json, "chat.tools.terminal.autoApprove", "object", add);
  expectFieldValue(json, "chat.useAgentsMdFile", true, add);

  return errors;
}

function runGitNameOnly(args, cwd) {
  const output = runCaptureOutput("git", args, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (!output) {
    return [];
  }

  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function getProhibitedPathsChanges() {
  const prohibitedPaths = ["docs/api"];
  const staged = runGitNameOnly(
    ["diff", "--name-only", "--cached", "--", ...prohibitedPaths],
    ROOT_DIR,
  );
  const unstaged = runGitNameOnly(
    ["diff", "--name-only", "--", ...prohibitedPaths],
    ROOT_DIR,
  );
  const untracked = runGitNameOnly(
    ["ls-files", "--others", "--exclude-standard", "--", ...prohibitedPaths],
    ROOT_DIR,
  );

  return [...new Set([...staged, ...unstaged, ...untracked])].sort(
    (left, right) => left.localeCompare(right),
  );
}

function main() {
  const errors = [
    ...validatePackageJson(packageJson),
    ...validateTsconfigJson(tsconfigJson),
    ...validateTypedocJson(typedocJson),
    ...validateVscodeSettingsJson(vscodeSettingsJson),
  ];

  const changedPaths = getProhibitedPathsChanges();
  if (changedPaths.length > 0) {
    errors.push(
      `git-change-check: detected changes in prohibited paths (docs/api): ${changedPaths.join(", ")}`,
    );
  }

  if (errors.length > 0) {
    logError(`Found ${errors.length} validation issue(s):`);
    for (const errorText of errors) {
      logError(`- ${errorText}`);
    }
    fail("Validation failed.");
  }

  logSuccess("Validation passed.");
}

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
