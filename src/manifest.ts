import fs from "node:fs";

/**
 * Writes manifest entries as newline-delimited, sorted values.
 *
 * @param filePath Output manifest path.
 * @param entries Manifest entries to normalize and write.
 * @returns Nothing.
 *
 * @example
 * writeManifest("/tmp/manifest.log", ["git=2.39", "curl=8.5.0"]);
 */
export function writeManifest(filePath: string, entries: string[]): void {
  const normalized = [...entries]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  fs.writeFileSync(filePath, normalized.join("\n"), "utf8");
}

/**
 * Reads a newline-delimited manifest and returns a CSV string.
 *
 * @param filePath Input manifest path.
 * @returns Comma-separated manifest entries or an empty string when missing.
 *
 * @example
 * const csv = readManifestAsCsv("/tmp/manifest.log");
 */
export function readManifestAsCsv(filePath: string): string {
  if (!fs.existsSync(filePath)) {
    return "";
  }

  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(",");
}
