import * as cache from "@actions/cache";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createPackageManager,
  type CommandRunner,
  DefaultCommandRunner,
  type PackageManager,
} from "../node_modules/ts-apt/dist/index.js";
import { type PackageName } from "../node_modules/ts-apt/dist/types.js";
import { isAptListsFresh } from "./io.js";
import { readManifestAsCsv, writeManifest } from "./manifest.js";
import * as tar from "tar";
import winston from "winston";

/**
 * Tar module contract used by {@link ActionRunner}.
 *
 * @example
 * const tarModule = await import("tar");
 */
type TarModule = typeof import("tar");

/**
 * Strategy for handling empty package inputs.
 *
 * @example
 * const behavior: EmptyPackageBehavior = "warn";
 */
type EmptyPackageBehavior = "error" | "warn" | "ignore";

const FORCE_UPDATE_INCREMENT = "4";
const CACHE_DIRNAME = "cache-apt-pkgs";
const CACHE_PREFIX = "cache-apt-pkgs_";

/**
 * Inputs accepted by the GitHub Action runtime.
 *
 * @example
 * const inputs: ActionInputs = {
 *   packages: "curl git",
 *   version: "v1",
 *   executeInstallScripts: false,
 *   emptyPackagesBehavior: "error",
 *   debug: false,
 * };
 */
export interface ActionInputs {
  /** Raw package input from action YAML. */
  readonly packages: string;
  /** User-controlled cache salt/version. */
  readonly version: string;
  /** Whether preinst/postinst scripts are executed on restore. */
  readonly executeInstallScripts: boolean;
  /** Behavior when normalized package input is empty. */
  readonly emptyPackagesBehavior: EmptyPackageBehavior;
  /** Enables verbose logging when true. */
  readonly debug: boolean;
}

/**
 * Outputs emitted by the GitHub Action runtime.
 *
 * @example
 * const outputs: ActionOutputs = {
 *   cacheHit: true,
 *   packageVersionList: "curl=8.5.0",
 *   allPackageVersionList: "curl=8.5.0,libcurl4=8.5.0",
 * };
 */
export interface ActionOutputs {
  /** True when cache restore key exactly matches requested key. */
  readonly cacheHit: boolean;
  /** CSV list of requested package versions. */
  readonly packageVersionList: string;
  /** CSV list of all installed package versions including dependencies. */
  readonly allPackageVersionList: string;
}

/**
 * Serializable package specifier understood by ts-apt.
 *
 * @example
 * const p = new ActionPackageName("curl", "8.5.0");
 * const value = p.serialize(); // curl=8.5.0
 */
export class ActionPackageName implements PackageName {
  constructor(
    /** Package name, for example "curl". */
    readonly name: string,
    /** Optional version pin, for example "8.5.0". */
    readonly version?: string,
    /** Optional distro qualifier used by ts-apt types. */
    readonly distro?: string,
  ) {}

  /**
   * Serializes the package descriptor for ts-apt APIs.
   *
   * @returns Serialized package specifier, including version when provided.
   */
  serialize(): string {
    return this.version ? `${this.name}=${this.version}` : this.name;
  }
}

/**
 * Converts a user package specifier into a typed package descriptor.
 *
 * @param packageSpecifier Specifier in name or name=version format.
 * @returns Typed package descriptor.
 * @throws Error when package name is empty.
 *
 * @example
 * const pkg = toPackageName("curl=8.5.0");
 * const value = pkg.serialize(); // curl=8.5.0
 */
function toPackageName(packageSpecifier: string): ActionPackageName {
  const [name, version] = packageSpecifier.split("=");
  if (!name) {
    throw new Error("Package name cannot be empty.");
  }

  return new ActionPackageName(name, version);
}

/**
 * Parses a strict boolean string used by Action inputs.
 *
 * @param value Raw input value.
 * @param fieldName Input field name used in validation errors.
 * @returns Parsed boolean value.
 * @throws Error when value is not "true" or "false".
 *
 * @example
 * const debug = parseBoolean("true", "debug"); // true
 */
export function parseBoolean(value: string, fieldName: string): boolean {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }

  throw new Error(
    `${fieldName} value '${value}' must be either true or false.`,
  );
}

/**
 * Normalizes package input by splitting on comma, backslash, and whitespace.
 *
 * @param inputPackages Raw package input from action configuration.
 * @returns Sorted list of normalized package specifiers.
 *
 * @example
 * const packages = normalizeInputPackages("git, curl\\vim");
 * // ["curl", "git", "vim"]
 */
export function normalizeInputPackages(inputPackages: string): string[] {
  return inputPackages
    .replace(/[,\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((part) => part.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Orchestrates package normalization, cache restore/save, install, and outputs.
 *
 * @example
 * const runner = new ActionRunner(commandRunner, tar, logger);
 * const outputs = await runner.runAction(inputs);
 */
export class ActionRunner {
  /** Shell command runner used for architecture and script execution. */
  private readonly commandRunner: CommandRunner;
  /** Tar adapter used for archive create/extract operations. */
  private readonly tar: TarModule;
  /** Logger used for restore/install script tracing. */
  private readonly logger: winston.Logger;

  constructor(
    commandRunner: CommandRunner,
    tarModule: TarModule,
    logger: winston.Logger,
  ) {
    this.commandRunner = commandRunner;
    this.tar = tarModule;
    this.logger = logger;
  }

  /**
   * Instance wrapper over {@link parseBoolean} for easier unit testing.
   *
   * @param value Raw input value.
   * @param fieldName Input field name used in validation errors.
   * @returns Parsed boolean value.
   *
   * @example
   * const enabled = runner.parseBoolean("false", "debug");
   */
  parseBoolean(value: string, fieldName: string): boolean {
    return parseBoolean(value, fieldName);
  }

  /**
   * Instance wrapper over {@link normalizeInputPackages}.
   *
   * @param inputPackages Raw package input from action configuration.
   * @returns Sorted list of normalized package specifiers.
   *
   * @example
   * const normalized = runner.normalizeInputPackages("curl git");
   */
  normalizeInputPackages(inputPackages: string): string[] {
    return normalizeInputPackages(inputPackages);
  }

  /**
   * Resolves a concrete version for an unpinned package name.
   *
   * @param packageManager ts-apt package manager instance used for metadata lookup.
   * @param packageName Package name without a version pin.
   * @returns Resolved package version.
   * @throws Error when no version can be resolved.
   *
   * @example
   * const version = await runner.resolvePackageVersion(manager, "curl");
   */
  async resolvePackageVersion(
    packageManager: PackageManager,
    packageName: string,
  ): Promise<string> {
    const packageInfo = await packageManager.getPackageInfo([
      toPackageName(packageName),
    ]);
    const version = packageInfo[0]?.version;
    if (!version) {
      throw new Error(
        `Unable to resolve package version for '${packageName}'.`,
      );
    }

    return version;
  }

  /**
   * Ensures each package has a pinned version to make cache behavior deterministic.
   *
   * @param packageManager ts-apt package manager instance used for version resolution.
   * @param inputPackages Raw package input string.
   * @returns Sorted list of package specifiers in name=version form.
   *
   * @example
   * const packages = await runner.normalizePackagesWithVersions(manager, "curl git=2.39");
   */
  async normalizePackagesWithVersions(
    packageManager: PackageManager,
    inputPackages: string,
  ): Promise<string[]> {
    const raw = this.normalizeInputPackages(inputPackages);
    const packages = await Promise.all(
      raw.map(async (pkg) => {
        if (pkg.includes("=")) {
          return pkg;
        }

        return `${pkg}=${await this.resolvePackageVersion(packageManager, pkg)}`;
      }),
    );

    return packages.sort((a, b) => a.localeCompare(b));
  }

  /**
   * Handles behavior when package input resolves to an empty list.
   *
   * @param behavior Empty-package handling strategy.
   * @param packages Normalized package list.
   * @returns Nothing.
   * @throws Error when behavior is "error" and packages is empty.
   *
   * @example
   * runner.validateEmptyPackages("warn", []);
   */
  validateEmptyPackages(
    behavior: EmptyPackageBehavior,
    packages: string[],
  ): void {
    if (packages.length > 0) {
      return;
    }

    if (behavior === "ignore") {
      return;
    }

    if (behavior === "warn") {
      process.stdout.write("::warning::Packages argument is empty.\n");
      return;
    }

    throw new Error("Packages argument is empty.");
  }

  /**
   * Returns the local cache root used by this action.
   *
   * @returns Absolute cache directory path.
   *
   * @example
   * const cacheRoot = runner.getCacheRoot();
   */
  getCacheRoot(): string {
    return path.join(os.homedir(), CACHE_DIRNAME);
  }

  /**
   * Builds a stable cache key from packages, user version, force bump, and arch.
   *
   * @param normalizedPackages Sorted package specifiers.
   * @param version User-provided cache version salt.
   * @returns Cache key with action-specific prefix.
   *
   * @example
   * const key = await runner.getCacheKey(["curl=8.5.0"], "v1");
   */
  async getCacheKey(
    normalizedPackages: string[],
    version: string,
  ): Promise<string> {
    const architecture = (await this.commandRunner.run("arch")).stdout.trim();
    let value = `${normalizedPackages.join(" ")} @ ${version} ${FORCE_UPDATE_INCREMENT}`;

    if (architecture !== "x86_64") {
      value = `${value} ${architecture}`;
    }

    const hash = crypto.createHash("md5").update(value).digest("hex");
    return `${CACHE_PREFIX}${hash}`;
  }

  /**
   * Finds dpkg lifecycle scripts for a package when present.
   *
   * @param packageName Package name.
   * @param extension Script extension to resolve.
   * @param root Root filesystem path used to resolve dpkg metadata.
   * @returns Absolute script path when found.
   *
   * @example
   * const preinst = runner.findInstallScript("curl", "preinst", "/");
   */
  findInstallScript(
    packageName: string,
    extension: "preinst" | "postinst",
    root: string,
  ): string | undefined {
    const scriptsDir = path.join(root, "var", "lib", "dpkg", "info");
    if (!fs.existsSync(scriptsDir)) {
      return undefined;
    }

    const pattern = new RegExp(`^${packageName}(:.*)?\\.${extension}$`);
    const matches = fs
      .readdirSync(scriptsDir)
      .filter((entry) => pattern.test(entry))
      .sort((a, b) => a.localeCompare(b));
    const candidate = matches[0];
    if (!candidate) {
      return undefined;
    }

    return path.join(scriptsDir, candidate);
  }

  /**
   * Converts absolute paths to tar-relative paths.
   *
   * @param filePath Absolute or relative file path.
   * @returns Path relative to tar root.
   *
   * @example
   * const relative = runner.tarRelativePath("/usr/bin/curl"); // usr/bin/curl
   */
  tarRelativePath(filePath: string): string {
    return filePath.startsWith("/") ? filePath.slice(1) : filePath;
  }

  /**
   * Collects installed file and lifecycle script paths for archive creation.
   *
   * @param packageManager ts-apt package manager instance.
   * @param packageName Package name.
   * @returns Sorted unique file list suitable for tar archiving.
   *
   * @example
   * const files = await runner.buildFileListForPackage(manager, "curl");
   */
  async buildFileListForPackage(
    packageManager: PackageManager,
    packageName: string,
  ): Promise<string[]> {
    const files = (
      await packageManager.listInstalledFiles(toPackageName(packageName))
    )
      .filter((filePath) => {
        if (!fs.existsSync(filePath)) {
          return false;
        }

        const stat = fs.lstatSync(filePath);
        return stat.isFile() || stat.isSymbolicLink();
      })
      .map(this.tarRelativePath);

    const preinst = this.findInstallScript(packageName, "preinst", "/");
    const postinst = this.findInstallScript(packageName, "postinst", "/");

    if (preinst) {
      files.push(this.tarRelativePath(preinst));
    }
    if (postinst) {
      files.push(this.tarRelativePath(postinst));
    }

    return Array.from(new Set(files)).sort((a, b) => a.localeCompare(b));
  }

  /**
   * Updates apt lists only when the local lists directory appears stale.
   *
   * @param packageManager ts-apt package manager instance.
   * @returns Nothing.
   *
   * @example
   * await runner.updateAptLists(manager);
   */
  async updateAptLists(packageManager: PackageManager): Promise<void> {
    if (isAptListsFresh()) {
      return;
    }

    await packageManager.update();
  }

  /**
   * Converts a versioned specifier like "pkg=1.2" into "pkg".
   *
   * @param packageSpecifier Versioned or unversioned package specifier.
   * @returns Package name only.
   *
   * @example
   * const name = runner.packageSpecifierToName("curl=8.5.0"); // curl
   */
  packageSpecifierToName(packageSpecifier: string): string {
    return packageSpecifier.split("=")[0] ?? packageSpecifier;
  }

  /**
   * Installs packages, archives installed files, and writes manifest files.
   *
   * @param cacheDir Cache directory path.
   * @param packages Package names to install.
   * @param packageManager ts-apt package manager instance configured for install.
   * @returns Nothing.
   *
   * @example
   * await runner.installAndCachePackages("/tmp/cache", ["curl"], installManager);
   */
  async installAndCachePackages(
    cacheDir: string,
    packages: string[],
    packageManager: PackageManager,
  ): Promise<void> {
    await this.updateAptLists(packageManager);
    writeManifest(path.join(cacheDir, "manifest_main.log"), packages);

    const installedPackages = await packageManager.install(
      packages.map(toPackageName),
    );

    const manifestAll: string[] = [];
    for (const pkg of installedPackages) {
      const packageName = pkg.name;
      const packageVersion = pkg.version;
      if (!packageName || !packageVersion) {
        continue;
      }

      const archivePath = path.join(
        cacheDir,
        `${packageName}=${packageVersion}.tar`,
      );
      if (!fs.existsSync(archivePath)) {
        const filesToArchive = await this.buildFileListForPackage(
          packageManager,
          packageName,
        );
        await this.tar.create(
          {
            cwd: "/",
            file: archivePath,
            portable: false,
            preservePaths: false,
            follow: false,
            noDirRecurse: false,
          },
          filesToArchive,
        );
      }

      manifestAll.push(`${packageName}=${packageVersion}`);
    }

    writeManifest(path.join(cacheDir, "manifest_all.log"), manifestAll);
  }

  /**
   * Restores archived files and optionally executes package install scripts.
   *
   * @param cacheDir Cache directory path.
   * @param executeInstallScripts Whether to execute preinst/postinst scripts.
   * @returns Nothing.
   *
   * @example
   * await runner.restorePackages("/tmp/cache", false);
   */
  async restorePackages(
    cacheDir: string,
    executeInstallScripts: boolean,
  ): Promise<void> {
    const archives = fs
      .readdirSync(cacheDir)
      .filter((entry) => entry.endsWith(".tar"))
      .sort((a, b) => a.localeCompare(b));

    for (const archive of archives) {
      const archivePath = path.join(cacheDir, archive);
      await this.tar.extract({
        cwd: "/",
        file: archivePath,
        preservePaths: true,
      });

      if (!executeInstallScripts) {
        continue;
      }

      const packageName = archive.split("=")[0] ?? "";
      if (!packageName) {
        continue;
      }

      const preinst = this.findInstallScript(packageName, "preinst", "/");
      if (preinst) {
        this.logger.info(`Running pre-install script for ${packageName}`);
        await this.commandRunner.run("sudo", ["sh", "-x", preinst, "install"]);
      }

      const postinst = this.findInstallScript(packageName, "postinst", "/");
      if (postinst) {
        this.logger.info(`Running post-install script for ${packageName}`);
        await this.commandRunner.run("sudo", [
          "sh",
          "-x",
          postinst,
          "configure",
        ]);
      }
    }
  }

  /**
   * Executes the end-to-end action flow and returns action outputs.
   *
   * @param inputs Validated action inputs.
   * @returns Action outputs consumed by the workflow runtime.
   *
   * @example
   * const outputs = await runner.runAction(inputs);
   */
  async runAction(inputs: ActionInputs): Promise<ActionOutputs> {
    if (/\s/.test(inputs.version)) {
      throw new Error(
        `Version value '${inputs.version}' cannot contain spaces.`,
      );
    }

    const packageInfoManager = await createPackageManager(false);
    const normalizedPackages = await this.normalizePackagesWithVersions(
      packageInfoManager,
      inputs.packages,
    );
    this.validateEmptyPackages(
      inputs.emptyPackagesBehavior,
      normalizedPackages,
    );

    const cacheDir = this.getCacheRoot();
    fs.mkdirSync(cacheDir, { recursive: true });

    if (normalizedPackages.length === 0) {
      writeManifest(path.join(cacheDir, "manifest_main.log"), []);
      writeManifest(path.join(cacheDir, "manifest_all.log"), []);
      return {
        cacheHit: false,
        packageVersionList: "",
        allPackageVersionList: "",
      };
    }

    const key = await this.getCacheKey(normalizedPackages, inputs.version);
    fs.writeFileSync(
      path.join(cacheDir, "cache_key.md5"),
      key.replace(CACHE_PREFIX, ""),
      "utf8",
    );

    const restoredKey = await cache.restoreCache([cacheDir], key);
    const cacheHit = restoredKey === key;

    if (cacheHit) {
      await this.restorePackages(cacheDir, inputs.executeInstallScripts);
    } else {
      const installManager = await createPackageManager(true);
      const installTargets = normalizedPackages.map((packageSpecifier) =>
        this.packageSpecifierToName(packageSpecifier),
      );
      await this.installAndCachePackages(
        cacheDir,
        installTargets,
        installManager,
      );
      await cache.saveCache([cacheDir], key);
    }

    return {
      cacheHit,
      packageVersionList: readManifestAsCsv(
        path.join(cacheDir, "manifest_main.log"),
      ),
      allPackageVersionList: readManifestAsCsv(
        path.join(cacheDir, "manifest_all.log"),
      ),
    };
  }
}

/**
 * Public entrypoint used by src/index.ts and tests.
 *
 * @param inputs Validated action inputs.
 * @param logger Logger instance used for command and restore diagnostics.
 * @returns Action outputs consumed by the workflow runtime.
 *
 * @example
 * const outputs = await runAction(inputs, logger);
 */
export async function runAction(
  inputs: ActionInputs,
  logger: winston.Logger,
): Promise<ActionOutputs> {
  const commandRunner = new DefaultCommandRunner(logger, logger);
  const actionRunner = new ActionRunner(commandRunner, tar, logger);
  return await actionRunner.runAction(inputs);
}
