#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ROOT_DIR, fail, logInfo, logSuccess } from "./lib.mjs";

function toLog(result) {
  return `*** CMD_LINE ${result.cmdLine}\n*** EXIT_CODE ${result.exitCode}\n*** STDOUT\n${result.stdout}*** STDERR\n${result.stderr}`;
}

async function execute(cmdLine) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const parts = cmdLine.trim().split(/\s+/);
    const command = parts[0]; // "apt-get"
    const args = parts.slice(1);

    const child = spawn("sudo", [command, ...args], {
      stdio: ["inherit", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: `${process.env.PATH}:/usr/bin`,
        DEBIAN_FRONTEND: "noninteractive",
        DEBCONF_NONINTERACTIVE_SEEN: "true",
      },
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("error", (error) => {
      rejectPromise(error);
    });

    child.on("close", (code) => {
      if (code !== 0) {
        rejectPromise(
          new Error(
            `Command '${cmdLine}' failed with exit code ${code ?? "unknown"}.`,
          ),
        );
        return;
      }

      resolvePromise({
        cmdLine,
        stdout,
        stderr,
        exitCode: 0,
      });
    });
  });
}

async function writeLogFile(baseDir, relativePath, result) {
  const outputPath = resolve(baseDir, `${relativePath}.log`);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, toLog(result), "utf8");
  return outputPath;
}

async function main() {
  const testDataDir = resolve(ROOT_DIR, "test/data");
  let written = 0;

  for (const entry of testLogFiles) {
    if (entry.preExecCmdLine) {
      for (const cmd of entry.preExecCmdLine) {
        await execute(cmd);
      }
    }

    const result = await execute(entry.execCmdLine);
    const outputPath = await writeLogFile(testDataDir, entry.filepath, result);
    written += 1;
    logInfo(`Wrote ${outputPath}`);
  }

  await execute("apt-get upgrade -y");
  await execute("apt-get autoremove -y");

  logSuccess(`Wrote ${written} command execution log(s).`);
}

const testLogFiles = [
  {
    filepath: "autoclean",
    execCmdLine: "apt-get autoclean",
  },
  {
    filepath: "autoremove_found",
    preExecCmdLine: ["apt-get install -y xdot", "apt-get remove -y xdot"],
    execCmdLine: "apt-get autoremove -y",
  },
  {
    filepath: "autoremove_notfound",
    preExecCmdLine: ["apt-get autoremove -y"],
    execCmdLine: "apt-get autoremove -y",
  },
  {
    filepath: "cacheshow_mixedfoundnotfound",
    execCmdLine: "apt-cache show xdot python3 nonexistentpackage",
  },
  {
    filepath: "cacheshow_multiplefound",
    execCmdLine: "apt-cache show xdot python3",
  },
  {
    filepath: "cacheshow_singlefound",
    execCmdLine: "apt-cache show python3",
  },
  {
    filepath: "cacheshow_singlenotfound",
    execCmdLine: "apt-cache show nonexistentpackage",
  },
  {
    filepath: "install_mixedfoundnotfound",
    preExecCmdLine: ["apt-get remove -y xdot"],
    execCmdLine: "apt-get install -y xdot nonexistentpackage",
  },
  {
    filepath: "install_mixedinstallstatus",
    preExecCmdLine: [
      "apt-get install -y xdot",
      "apt-get remove -y rolldice",
      "apt-get autoremove -y",
    ],
    execCmdLine: "apt-get install -y rolldice xdot",
  },
  {
    filepath: "install_singleinstalled",
    preExecCmdLine: ["apt-get install -y xdot"],
    execCmdLine: "apt-get install -y xdot",
  },
  {
    filepath: "install_singlenotfound",
    execCmdLine: "apt-get install -y nonexistentpackage",
  },
  {
    filepath: "install_singlenotinstalled",
    preExecCmdLine: ["apt-get remove -y xdot", "apt-get autoremove -y"],
    execCmdLine: "apt-get install -y xdot",
  },
  {
    filepath: "listinstalled",
    execCmdLine: "dpkg-query -W -f ${binary:Package}=${Version}\\n",
  },
  {
    filepath: "listinstalledfiles_found",
    execCmdLine: "dpkg-query -L xdot",
  },
  {
    filepath: "listinstalledfiles_notfound",
    execCmdLine: "dpkg-query -L nonexistentpackage",
  },
  {
    filepath: "listupgradable_found",
    preExecCmdLine: [
      "apt-get remove -y firefox-locale-en",
      "apt-get install -y firefox-locale-en=75.0+build3-0ubuntu1",
      "apt-get remove -y uuid-dev",
      "apt-get install -y uuid-dev=2.34-0.1ubuntu9",
    ],
    execCmdLine: "apt list --upgradeable",
  },
  {
    filepath: "listupgradable_notfound",
    preExecCmdLine: ["apt-get upgrade -y"],
    execCmdLine: "apt list --upgradeable",
  },
  {
    filepath: "remove_mixedfoundnotfound",
    preExecCmdLine: ["apt-get install -y xdot"],
    execCmdLine: "apt-get remove -y xdot nonexistentpackage",
  },
  {
    filepath: "remove_mixedinstallstatus",
    preExecCmdLine: ["apt-get install -y xdot", "apt-get remove -y rolldice"],
    execCmdLine: "apt-get remove -y rolldice xdot",
  },
  {
    filepath: "remove_singlenotinstalled",
    preExecCmdLine: ["apt-get remove -y xdot"],
    execCmdLine: "apt-get remove -y xdot",
  },
  {
    filepath: "remove_singlenotfound",
    execCmdLine: "apt-get remove -y nonexistentpackage",
  },
  {
    filepath: "remove_singleinstalled",
    preExecCmdLine: ["apt-get install -y xdot"],
    execCmdLine: "apt-get remove -y xdot",
  },
  {
    filepath: "search_multiplefound",
    execCmdLine: "apt search vim",
  },
  {
    filepath: "search_nonefound",
    execCmdLine: "apt search nonexistentpackage",
  },
  {
    filepath: "search_singlefound",
    execCmdLine: "apt search vim-vimerl-syntax",
  },
  {
    filepath: "search_namesonlysinglefound",
    execCmdLine: "apt search --names-only bash",
  },
  {
    filepath: "update",
    execCmdLine: "apt-get update -y",
  },
  {
    filepath: "upgrade_mixedfoundnotfound",
    preExecCmdLine: ["apt-get remove -y xdot"],
    execCmdLine: "apt-get upgrade -y xdot nonexistentpackage",
  },
  {
    filepath: "upgrade_mixedupgradestatus",
    preExecCmdLine: [
      "apt-get install -y xdot",
      "apt-get remove -y xxd",
      "apt-get install -y xxd=2:8.1.2269-1ubuntu5.30",
    ],
    execCmdLine: "apt-get upgrade -y xxd xdot",
  },
  {
    filepath: "upgrade_singleupgraded",
    preExecCmdLine: ["apt-get upgrade -y xdot"],
    execCmdLine: "apt-get upgrade -y xdot",
  },
  {
    filepath: "upgrade_singlenotfound",
    execCmdLine: "apt-get upgrade -y nonexistentpackage",
  },
  {
    filepath: "upgrade_singlenotupgraded",
    preExecCmdLine: [
      "apt-get remove -y xxd",
      "apt-get install -y xxd=2:8.1.2269-1ubuntu5.30",
    ],
    execCmdLine: "apt-get upgrade -y xxd",
  },
  {
    filepath: "upgrade_singleupgraded",
    preExecCmdLine: ["apt-get install xdot"],
    execCmdLine: "apt-get upgrade xdot",
  },
];

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
