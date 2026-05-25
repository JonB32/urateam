/**
 * Minimal `.env` read / upsert preserving unrelated keys, comments, and blank
 * lines. We don't need the full `dotenv` spec — just replace-or-append.
 *
 * `upsertEnvFile` writes atomically by writing a sibling `<path>.tmp` first
 * and then renaming. Same-FS rename is atomic on POSIX and on Windows in
 * Node 22, which is the only target.
 */
import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { dirname } from "node:path";

export function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    out[key] = value;
  }
  return out;
}

export function upsertEnvFile(
  path: string,
  updates: Record<string, string>,
): void {
  mkdirSync(dirname(path), { recursive: true });
  const updateKeys = new Set(Object.keys(updates));
  const seen = new Set<string>();

  let lines: string[] = [];
  if (existsSync(path)) {
    lines = readFileSync(path, "utf8").split("\n");
  }

  const out: string[] = [];
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      out.push(raw);
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq < 1) {
      out.push(raw);
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    if (updateKeys.has(key)) {
      out.push(`${key}=${updates[key]}`);
      seen.add(key);
    } else {
      out.push(raw);
    }
  }

  while (out.length > 0 && out[out.length - 1] === "") out.pop();

  for (const key of updateKeys) {
    if (!seen.has(key)) {
      out.push(`${key}=${updates[key]}`);
    }
  }
  out.push("");

  const tmp = `${path}.tmp`;
  writeFileSync(tmp, out.join("\n"));
  renameSync(tmp, path);
}
