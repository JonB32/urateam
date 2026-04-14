import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/**
 * Compute a sha256 fingerprint of a config file on disk. Used to populate
 * the `config.loaded` audit event payload so operators can tell when a
 * running process has a different config than what's currently on disk.
 *
 * Returns `null` if the file cannot be read (fail-open: config loading
 * itself should surface the error, we just skip the fingerprint).
 */
export async function computeConfigFingerprint(
  path: string,
): Promise<string | null> {
  try {
    const bytes = await readFile(path);
    return createHash("sha256").update(bytes).digest("hex");
  } catch {
    return null;
  }
}
