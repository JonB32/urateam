/**
 * Unit tests for the Bitbucket repo provider.
 *
 * All tests run without a live Bitbucket instance — HTTP calls are intercepted
 * by replacing `globalThis.fetch` with a Vitest spy before each test.
 *
 * Bitbucket API tier notes
 * -----------------------
 * - All APIs exercised here are part of the Bitbucket REST API v2.
 * - PR creation, comments, and merging are available on all Bitbucket Cloud plans.
 * - Bitbucket Data Center (self-hosted) uses the same API endpoints via a
 *   configurable `apiBaseUrl` in `BitbucketConfig`.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  buildBitbucketAuthenticatedUrl,
  createBitbucketPR,
  addBitbucketPRComment,
  mergeBitbucketPR,
  parseBitbucketUrl,
  type BitbucketConfig,
  type CreateBitbucketPROptions,
} from "../repo/bitbucket.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResponse(
  body: unknown,
  status = 200,
  opts: { ok?: boolean } = {},
): Response {
  const ok = opts.ok ?? (status >= 200 && status < 300);
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok,
    status,
    json: async () => (typeof body === "string" ? JSON.parse(body) : body),
    text: async () => text,
  } as unknown as Response;
}

const oauthConfig: BitbucketConfig = { accessToken: "bbtoken-abc123" };
const appPwdConfig: BitbucketConfig = {
  appUsername: "myuser",
  appPassword: "myapppassword",
};

// ---------------------------------------------------------------------------
// parseBitbucketUrl
// ---------------------------------------------------------------------------

describe("parseBitbucketUrl", () => {
  it("parses an HTTPS URL", () => {
    expect(parseBitbucketUrl("https://bitbucket.org/myworkspace/myrepo")).toEqual({
      workspace: "myworkspace",
      repoSlug: "myrepo",
    });
  });

  it("parses an HTTPS URL with .git suffix", () => {
    expect(parseBitbucketUrl("https://bitbucket.org/myworkspace/myrepo.git")).toEqual({
      workspace: "myworkspace",
      repoSlug: "myrepo",
    });
  });

  it("parses an SSH URL", () => {
    expect(parseBitbucketUrl("git@bitbucket.org:myworkspace/myrepo.git")).toEqual({
      workspace: "myworkspace",
      repoSlug: "myrepo",
    });
  });

  it("throws for an unrecognised URL format", () => {
    expect(() => parseBitbucketUrl("not-a-valid-url")).toThrow("Unable to parse Bitbucket repo URL");
  });

  it("parses slugs containing dots (HTTPS, no .git)", () => {
    // Regression: the original regex used [^/.]+ which truncated `my.repo` to `my`.
    expect(parseBitbucketUrl("https://bitbucket.org/ws/my.repo")).toEqual({
      workspace: "ws",
      repoSlug: "my.repo",
    });
  });

  it("parses slugs containing dots (HTTPS with .git suffix)", () => {
    expect(parseBitbucketUrl("https://bitbucket.org/ws/my.repo.git")).toEqual({
      workspace: "ws",
      repoSlug: "my.repo",
    });
  });

  it("parses slugs containing dots (SSH with .git suffix)", () => {
    expect(parseBitbucketUrl("git@bitbucket.org:ws/my.repo.git")).toEqual({
      workspace: "ws",
      repoSlug: "my.repo",
    });
  });
});

// ---------------------------------------------------------------------------
// buildBitbucketAuthenticatedUrl
// ---------------------------------------------------------------------------

describe("buildBitbucketAuthenticatedUrl", () => {
  it("injects OAuth token as x-token-auth user", () => {
    const result = buildBitbucketAuthenticatedUrl(
      "https://bitbucket.org/myworkspace/myrepo.git",
      oauthConfig,
    );
    expect(result).toBe(
      "https://x-token-auth:bbtoken-abc123@bitbucket.org/myworkspace/myrepo.git",
    );
  });

  it("injects App Password credentials as username:password", () => {
    const result = buildBitbucketAuthenticatedUrl(
      "https://bitbucket.org/myworkspace/myrepo.git",
      appPwdConfig,
    );
    expect(result).toBe(
      "https://myuser:myapppassword@bitbucket.org/myworkspace/myrepo.git",
    );
  });

  it("does not overwrite credentials already present in the URL", () => {
    const url = "https://existing:creds@bitbucket.org/workspace/repo.git";
    expect(buildBitbucketAuthenticatedUrl(url, oauthConfig)).toBe(url);
  });

  it("throws when neither accessToken nor appPassword is provided", () => {
    expect(() =>
      buildBitbucketAuthenticatedUrl("https://bitbucket.org/ws/repo.git", {}),
    ).toThrow("BitbucketConfig requires either accessToken or appUsername+appPassword");
  });
});

// ---------------------------------------------------------------------------
// createBitbucketPR
// ---------------------------------------------------------------------------

describe("createBitbucketPR", () => {
  const options: CreateBitbucketPROptions = {
    workspace: "myworkspace",
    repoSlug: "myrepo",
    sourceBranch: "agent/LIN-42-my-feature",
    targetBranch: "main",
    title: "My feature",
    description: "Adds a cool feature",
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a PR and returns the web URL", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeResponse({ links: { html: { href: "https://bitbucket.org/myworkspace/myrepo/pull-requests/42" } } }, 201),
    );

    const url = await createBitbucketPR(oauthConfig, options);
    expect(url).toBe("https://bitbucket.org/myworkspace/myrepo/pull-requests/42");
  });

  it("sends the correct API endpoint", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeResponse({ links: { html: { href: "https://bitbucket.org/myworkspace/myrepo/pull-requests/1" } } }),
    );

    await createBitbucketPR(oauthConfig, options);

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.bitbucket.org/2.0/repositories/myworkspace/myrepo/pullrequests");
  });

  it("uses Bearer auth for OAuth tokens", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeResponse({ links: { html: { href: "https://bitbucket.org/myworkspace/myrepo/pull-requests/1" } } }),
    );

    await createBitbucketPR(oauthConfig, options);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer bbtoken-abc123");
  });

  it("uses Basic auth for App Passwords", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeResponse({ links: { html: { href: "https://bitbucket.org/myworkspace/myrepo/pull-requests/1" } } }),
    );

    await createBitbucketPR(appPwdConfig, options);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const authHeader = (init.headers as Record<string, string>)["Authorization"];
    expect(authHeader).toMatch(/^Basic /);
    const decoded = Buffer.from(authHeader.slice(6), "base64").toString();
    expect(decoded).toBe("myuser:myapppassword");
  });

  it("sends correct request body fields", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeResponse({ links: { html: { href: "https://bitbucket.org/myworkspace/myrepo/pull-requests/1" } } }),
    );

    await createBitbucketPR(oauthConfig, options);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      title: "My feature",
      description: "Adds a cool feature",
      source: { branch: { name: "agent/LIN-42-my-feature" } },
      destination: { branch: { name: "main" } },
      close_source_branch: true,
    });
  });

  it("sets draft: true when draft option is provided", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeResponse({ links: { html: { href: "https://bitbucket.org/myworkspace/myrepo/pull-requests/1" } } }),
    );

    await createBitbucketPR(oauthConfig, { ...options, draft: true });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.draft).toBe(true);
  });

  it("throws on a non-ok API response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeResponse("Unauthorized", 401, { ok: false }),
    );

    await expect(createBitbucketPR(oauthConfig, options)).rejects.toThrow(
      "Bitbucket API error 401 creating PR",
    );
  });

  it("uses a custom apiBaseUrl when provided", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeResponse({ links: { html: { href: "https://bitbucket.example.com/repos/myworkspace/myrepo/pull-requests/1" } } }),
    );

    const selfHostedConfig: BitbucketConfig = {
      accessToken: "mytoken",
      apiBaseUrl: "https://bitbucket.example.com/rest/api/2.0",
    };
    await createBitbucketPR(selfHostedConfig, options);

    const [url] = fetchSpy.mock.calls[0] as [string];
    expect(url).toMatch(/^https:\/\/bitbucket\.example\.com/);
  });
});

// ---------------------------------------------------------------------------
// addBitbucketPRComment
// ---------------------------------------------------------------------------

describe("addBitbucketPRComment", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts a comment to the correct endpoint", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeResponse({ id: 1 }, 201),
    );

    await addBitbucketPRComment(oauthConfig, "myworkspace", "myrepo", 42, "Hello from the agent");

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.bitbucket.org/2.0/repositories/myworkspace/myrepo/pullrequests/42/comments");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.content.raw).toBe("Hello from the agent");
  });

  it("resolves without error on a 201 response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeResponse({ id: 2 }, 201));
    await expect(addBitbucketPRComment(oauthConfig, "ws", "repo", 1, "test")).resolves.toBeUndefined();
  });

  it("throws a descriptive error on non-ok response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeResponse("Not Found", 404, { ok: false }),
    );

    await expect(
      addBitbucketPRComment(oauthConfig, "ws", "repo", 99, "comment"),
    ).rejects.toThrow("Bitbucket API error 404 adding PR comment");
  });
});

// ---------------------------------------------------------------------------
// mergeBitbucketPR
// ---------------------------------------------------------------------------

describe("mergeBitbucketPR", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns true on a successful merge", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeResponse({ state: "MERGED" }, 200));
    const result = await mergeBitbucketPR(oauthConfig, "ws", "repo", 42);
    expect(result).toBe(true);
  });

  it("returns false on a non-ok response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeResponse("Conflict", 409, { ok: false }),
    );
    const result = await mergeBitbucketPR(oauthConfig, "ws", "repo", 42);
    expect(result).toBe(false);
  });

  it("returns false when fetch throws", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network error"));
    const result = await mergeBitbucketPR(oauthConfig, "ws", "repo", 42);
    expect(result).toBe(false);
  });

  it("sends the merge_strategy in the request body", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeResponse({ state: "MERGED" }, 200),
    );

    await mergeBitbucketPR(oauthConfig, "ws", "repo", 42, "squash");

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.merge_strategy).toBe("squash");
  });

  it("posts to the correct merge endpoint", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeResponse({ state: "MERGED" }, 200),
    );

    await mergeBitbucketPR(oauthConfig, "myworkspace", "myrepo", 7);

    const [url] = fetchSpy.mock.calls[0] as [string];
    expect(url).toBe("https://api.bitbucket.org/2.0/repositories/myworkspace/myrepo/pullrequests/7/merge");
  });
});
