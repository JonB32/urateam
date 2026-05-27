import { describe, it, expect, vi } from "vitest";
import { createTagAndRelease, parseRepoFromUrl } from "../release-manager/github.js";
import { RELEASE_TAG_RE } from "../release-manager/state.js";

describe("parseRepoFromUrl", () => {
  it("parses https github URL", () => {
    expect(parseRepoFromUrl("https://github.com/org/repo")).toEqual({ owner: "org", repo: "repo" });
  });
  it("parses .git suffix", () => {
    expect(parseRepoFromUrl("https://github.com/org/repo.git")).toEqual({ owner: "org", repo: "repo" });
  });
  it("parses git@ ssh URL", () => {
    expect(parseRepoFromUrl("git@github.com:org/repo.git")).toEqual({ owner: "org", repo: "repo" });
  });
  it("throws on unparseable URL", () => {
    expect(() => parseRepoFromUrl("not-a-url")).toThrow();
  });
});

describe("createTagAndRelease", () => {
  function makeMockOctokit(opts: { createRefImpl?: () => any; createReleaseImpl?: () => any } = {}) {
    return {
      git: {
        createRef: vi.fn(opts.createRefImpl ?? (async () => ({ data: {} }))),
      },
      repos: {
        createRelease: vi.fn(opts.createReleaseImpl ?? (async () => ({ data: { html_url: "https://github.com/org/repo/releases/tag/v1.2.4" } }))),
      },
    } as any;
  }

  it("happy path: creates ref then release with generate_release_notes=true", async () => {
    const octokit = makeMockOctokit();
    const r = await createTagAndRelease({
      octokit,
      owner: "org",
      repo: "repo",
      tag: "v1.2.4",
      sha: "abc123",
    });
    expect(r.kind).toBe("ok");
    expect(octokit.git.createRef).toHaveBeenCalledWith({
      owner: "org",
      repo: "repo",
      ref: "refs/tags/v1.2.4",
      sha: "abc123",
    });
    expect(octokit.repos.createRelease).toHaveBeenCalledWith({
      owner: "org",
      repo: "repo",
      tag_name: "v1.2.4",
      target_commitish: "abc123",
      generate_release_notes: true,
      prerelease: false,
    });
    expect(r.kind === "ok" && r.releaseUrl).toMatch(/v1\.2\.4/);
  });

  it("passes prerelease: true when isPrerelease=true", async () => {
    const octokit = makeMockOctokit();
    await createTagAndRelease({
      octokit,
      owner: "org",
      repo: "repo",
      tag: "v1.2.4-beta.1",
      sha: "abc123",
      isPrerelease: true,
    });
    expect(octokit.repos.createRelease).toHaveBeenCalledWith(
      expect.objectContaining({ prerelease: true }),
    );
  });

  it("passes prerelease: false when isPrerelease is omitted", async () => {
    const octokit = makeMockOctokit();
    await createTagAndRelease({
      octokit,
      owner: "org",
      repo: "repo",
      tag: "v1.2.4",
      sha: "abc123",
    });
    expect(octokit.repos.createRelease).toHaveBeenCalledWith(
      expect.objectContaining({ prerelease: false }),
    );
  });

  it("classifies 422 'already exists' as tag_exists", async () => {
    const octokit = makeMockOctokit({
      createRefImpl: async () => {
        const err: any = new Error("Reference already exists");
        err.status = 422;
        throw err;
      },
    });
    const r = await createTagAndRelease({ octokit, owner: "org", repo: "repo", tag: "v1.2.4", sha: "abc" });
    expect(r.kind).toBe("tag_exists");
    expect(octokit.repos.createRelease).not.toHaveBeenCalled();
  });

  it("classifies release-creation failure (after tag created) as release_create_failed", async () => {
    const octokit = makeMockOctokit({
      createReleaseImpl: async () => {
        throw new Error("network error");
      },
    });
    const r = await createTagAndRelease({ octokit, owner: "org", repo: "repo", tag: "v1.2.4", sha: "abc" });
    expect(r.kind).toBe("release_create_failed");
    expect(r.kind === "release_create_failed" && r.message).toMatch(/network error/);
  });

  it("propagates unknown errors from createRef as other_error", async () => {
    const octokit = makeMockOctokit({
      createRefImpl: async () => { throw new Error("403 forbidden"); },
    });
    const r = await createTagAndRelease({ octokit, owner: "org", repo: "repo", tag: "v1.2.4", sha: "abc" });
    expect(r.kind).toBe("other_error");
  });
});

describe("RELEASE_TAG_RE", () => {
  it("matches plain semver tags", () => {
    expect(RELEASE_TAG_RE.test("v1.2.3")).toBe(true);
    expect(RELEASE_TAG_RE.test("1.2.3")).toBe(true);
    expect(RELEASE_TAG_RE.test("v0.0.1")).toBe(true);
    expect(RELEASE_TAG_RE.test("v10.20.30")).toBe(true);
  });

  it("matches prerelease semver tags", () => {
    expect(RELEASE_TAG_RE.test("v1.2.3-beta.1")).toBe(true);
    expect(RELEASE_TAG_RE.test("v1.2.3-rc.2")).toBe(true);
    expect(RELEASE_TAG_RE.test("v1.2.3-alpha.10")).toBe(true);
    expect(RELEASE_TAG_RE.test("1.2.3-beta.1")).toBe(true);
  });

  it("rejects non-semver tags", () => {
    expect(RELEASE_TAG_RE.test("latest")).toBe(false);
    expect(RELEASE_TAG_RE.test("v1.2")).toBe(false);
    expect(RELEASE_TAG_RE.test("v1.2.3.4")).toBe(false);
    expect(RELEASE_TAG_RE.test("v1.2.3-beta")).toBe(false);   // missing .N
    expect(RELEASE_TAG_RE.test("v1.2.3-BETA.1")).toBe(false); // uppercase not matched
  });
});
