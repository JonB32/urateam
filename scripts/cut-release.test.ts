import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  bumpVersion,
  bumpAll,
  bumpPackageJson,
  bumpDockerfile,
  bumpComposeFile,
  buildChangelogEntry,
  insertChangelogEntry,
  nextReleaseTag,
} from "./cut-release-lib.ts";

test("bumpVersion: patch / minor / major", () => {
  assert.equal(bumpVersion("0.1.23", "patch"), "0.1.24");
  assert.equal(bumpVersion("0.1.23", "minor"), "0.2.0");
  assert.equal(bumpVersion("0.1.23", "major"), "1.0.0");
  assert.equal(bumpVersion("9.99.99", "patch"), "9.99.100");
});

test("bumpVersion: rejects non-semver input", () => {
  assert.throws(() => bumpVersion("not-a-version", "patch"));
  assert.throws(() => bumpVersion("1.2", "patch"));
  assert.throws(() => bumpVersion("v1.2.3", "patch"));
});

test("bumpAll bumps every package by the same kind", () => {
  const out = bumpAll(
    { core: "0.1.23", cli: "0.1.25", dashboard: "0.1.23", createUrateam: "0.1.26" },
    "patch",
  );
  assert.deepEqual(out, {
    core: "0.1.24",
    cli: "0.1.26",
    dashboard: "0.1.24",
    createUrateam: "0.1.27",
  });
});

test("bumpPackageJson replaces only the top-level version field", () => {
  const input = `{
  "name": "foo",
  "version": "0.1.23",
  "private": true,
  "dependencies": {
    "bar": "version 0.1.23"
  }
}
`;
  const out = bumpPackageJson(input, "0.1.24");
  assert.equal(
    out,
    `{
  "name": "foo",
  "version": "0.1.24",
  "private": true,
  "dependencies": {
    "bar": "version 0.1.23"
  }
}
`,
  );
});

test("bumpDockerfile updates only the URATEAM_*_VERSION ARGs", () => {
  const input =
    "ARG URATEAM_CORE_VERSION=0.1.23\n" +
    "ARG URATEAM_CLI_VERSION=0.1.25\n" +
    "ARG URATEAM_DASHBOARD_VERSION=0.1.23\n" +
    "ARG CLAUDE_CODE_VERSION=2.1.128\n";
  const out = bumpDockerfile(input, {
    core: "0.1.24",
    cli: "0.1.26",
    dashboard: "0.1.24",
  });
  assert.equal(
    out,
    "ARG URATEAM_CORE_VERSION=0.1.24\n" +
      "ARG URATEAM_CLI_VERSION=0.1.26\n" +
      "ARG URATEAM_DASHBOARD_VERSION=0.1.24\n" +
      "ARG CLAUDE_CODE_VERSION=2.1.128\n",
  );
});

test("bumpComposeFile updates only the URATEAM_*_VERSION args", () => {
  const input =
    "        URATEAM_CORE_VERSION: 0.1.23\n" +
    "        URATEAM_CLI_VERSION: 0.1.25\n" +
    "        URATEAM_DASHBOARD_VERSION: 0.1.23\n" +
    "        CLAUDE_CODE_VERSION: 2.1.128\n";
  const out = bumpComposeFile(input, {
    core: "0.1.24",
    cli: "0.1.26",
    dashboard: "0.1.24",
  });
  assert.match(out, /URATEAM_CORE_VERSION: 0\.1\.24/);
  assert.match(out, /URATEAM_CLI_VERSION: 0\.1\.26/);
  assert.match(out, /URATEAM_DASHBOARD_VERSION: 0\.1\.24/);
  assert.match(out, /CLAUDE_CODE_VERSION: 2\.1\.128/);
});

test("buildChangelogEntry produces keep-a-changelog format", () => {
  const entry = buildChangelogEntry({
    releaseTag: "v0.1.38",
    date: "2026-05-08",
    prev: { core: "0.1.23", cli: "0.1.25", dashboard: "0.1.23", createUrateam: "0.1.26" },
    next: { core: "0.1.24", cli: "0.1.26", dashboard: "0.1.24", createUrateam: "0.1.27" },
  });
  assert.match(entry, /^## \[0\.1\.38\] — 2026-05-08$/m);
  assert.match(entry, /Bumps:/);
  assert.match(entry, /`@urateam\/core`: 0\.1\.23 → 0\.1\.24/);
  assert.match(entry, /`create-urateam`: 0\.1\.26 → 0\.1\.27/);
  assert.match(entry, /TODO: replace/);
});

test("insertChangelogEntry: prepends above the latest version section", () => {
  const existing =
    "# Changelog\n\nintro line\n\n## [0.1.37] — 2026-05-07\n\nv0.1.37 body\n";
  const entry = "## [0.1.38] — 2026-05-08\n\nv0.1.38 body\n\n";
  const out = insertChangelogEntry(existing, entry);
  // New entry must appear before the old one
  const newIdx = out.indexOf("## [0.1.38]");
  const oldIdx = out.indexOf("## [0.1.37]");
  assert.ok(newIdx > -1 && oldIdx > -1 && newIdx < oldIdx);
});

test("insertChangelogEntry: idempotent — same version already present is a no-op", () => {
  const existing =
    "# Changelog\n\n## [0.1.38] — 2026-05-08\n\nbody\n\n## [0.1.37] — 2026-05-07\n\n";
  const entry = "## [0.1.38] — 2026-05-08\n\nfresh body\n\n";
  assert.equal(insertChangelogEntry(existing, entry), existing);
});

test("insertChangelogEntry: file with no existing version sections appends to the end", () => {
  const existing = "# Changelog\n\nintro only\n";
  const entry = "## [0.1.0] — 2024-01-01\n\nbody\n\n";
  const out = insertChangelogEntry(existing, entry);
  assert.match(out, /intro only[\s\S]*## \[0\.1\.0\]/);
});

test("nextReleaseTag: takes latest from sorted list, ignores non-semver tags", () => {
  assert.equal(
    nextReleaseTag(["v0.1.38", "v0.1.37", "some-other-tag"], "patch"),
    "v0.1.39",
  );
  assert.equal(nextReleaseTag(["v0.1.38"], "minor"), "v0.2.0");
  assert.equal(nextReleaseTag([], "patch"), "v0.0.1");
});
