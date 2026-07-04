import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type CommandRunner } from "../node_modules/ts-apt/dist/index.js";

const FORCE_UPDATE_INCREMENT = "4";
const CACHE_DIRNAME = "cache-apt-pkgs";
const CACHE_PREFIX = "cache-apt-pkgs_";

/**
 * Returns true when apt lists contain at least one reachable file.
 *
 * This is used as a cheap signal to skip unnecessary apt-get update calls.
 *
 * @returns True when at least one apt list file is found within the search depth.
 *
 * @example
 * const fresh = isAptListsFresh();
 */
export function isAptListsFresh(): boolean {
  const aptListsPath = "/var/lib/apt/lists";
  const maxDepth = 5;

  function search(currentPath: string, currentDepth: number): boolean {
    if (currentDepth > maxDepth) {
      return false;
    }

    try {
      const stats = fs.statSync(currentPath);
      if (stats.isDirectory()) {
        const entries = fs.readdirSync(currentPath);
        for (const entry of entries) {
          const fullPath = path.join(currentPath, entry);
          if (search(fullPath, currentDepth + 1)) {
            return true;
          }
        }
      } else {
        return true;
      }
    } catch {
      // Ignore permission errors or inaccessible paths.
    }

    return false;
  }

  return search(aptListsPath, 0);
}

/**
 * Simple package descriptor used by helper code.
 *
 * @example
 * const pkg = new Package("curl", "8.5.0");
 * const encoded = pkg.serialize(); // curl@8.5.0
 */
export class Package {
  constructor(
    /** Package name, for example "curl". */
    readonly name: string,
    /** Package version, for example "8.5.0". */
    readonly version: string,
  ) {}

  /**
   * Serializes the package descriptor.
   *
   * @returns Package serialized as name@version.
   */
  serialize(): string {
    return `${this.name}@${this.version}`;
  }
}

/**
 * Structured representation of cache key components.
 *
 * @example
 * const key = new CacheKey("v1", "4", "x86_64", ["curl=8.5.0"]);
 */
export class CacheKey {
  constructor(
    /** User-provided cache salt/version. */
    readonly version: string,
    /** Internal increment used to force broad invalidation. */
    readonly forceUpdateIncrement: string,
    /** Architecture string from `arch`. */
    readonly arch: string,
    /** Sorted normalized package specifiers. */
    readonly normalizedPackages: string[],
  ) {}

  /**
   * Serializes cache key fields to a stable, human-readable format.
   *
   * @returns Serialized cache key components.
   */
  serialize(): string {
    return `${this.version} | ${this.forceUpdateIncrement} | ${this.arch} | ${this.normalizedPackages.join(",")}`;
  }
}

/**
 * Parses a serialized cache key into its component fields.
 *
 * @param serialized Serialized cache key string.
 * @returns Parsed cache key object.
 * @throws Error when serialized value does not contain all expected fields.
 *
 * @example
 * const parsed = deserializeCacheKey("v1|4|x86_64|curl=8.5.0");
 */
export function deserializeCacheKey(serialized: string): CacheKey {
  const parts = serialized.split("|").map((part) => part.trim());
  if (parts.length !== 4) {
    throw new Error(`Invalid serialized cache key: ${serialized}`);
  }

  const [version, forceUpdateIncrement, arch, normalizedPackagesStr] = parts;
  return new CacheKey(
    version!,
    forceUpdateIncrement!,
    arch!,
    normalizedPackagesStr!
      .split(",")
      .map((packageSpecifier) => packageSpecifier.trim()),
  );
}

/**
 * Computes action cache path and cache keys for package sets.
 *
 * @example
 * const cacheStore = new Cache("cache-apt-pkgs", commandRunner);
 * const key = await cacheStore.getKey(["curl=8.5.0"], "v1");
 */
export class Cache {
  /** Absolute cache directory path. */
  private readonly cachePath: string;
  /** Command runner used for architecture detection. */
  private readonly commandRunner: CommandRunner;

  constructor(cacheDir: string = CACHE_DIRNAME, commandRunner: CommandRunner) {
    this.cachePath = path.join(os.homedir(), cacheDir);
    this.commandRunner = commandRunner;
  }

  /**
   * Absolute path to the local cache directory.
   *
   * @returns Absolute cache directory path.
   */
  get path(): string {
    return this.cachePath;
  }

  /**
   * Generates the normalized cache key used by GitHub Actions cache.
   *
   * @param normalizedPackages Sorted package specifiers.
   * @param version User-provided cache version salt.
   * @returns Cache key with action-specific prefix.
   */
  async getKey(normalizedPackages: string[], version: string): Promise<string> {
    const architecture = (await this.commandRunner.run("arch")).stdout.trim();
    let value = `${normalizedPackages.join(" ")} @ ${version} ${FORCE_UPDATE_INCREMENT}`;

    if (architecture !== "x86_64") {
      value = `${value} ${architecture}`;
    }

    const hash = crypto.createHash("md5").update(value).digest("hex");
    return `${CACHE_PREFIX}${hash}`;
  }
}
