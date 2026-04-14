import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function getPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Built layout: dist/version.js → ../package.json
  // Source layout (tsx): src/version.ts → ../package.json
  const pkgPath = join(here, "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
  return pkg.version;
}
