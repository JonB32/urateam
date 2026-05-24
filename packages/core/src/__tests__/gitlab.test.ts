/**
 * Unit tests for the GitLab repo provider.
 *
 * All tests run without a live GitLab instance — HTTP calls are intercepted by
 * replacing `globalThis.fetch` with a Vitest spy before each test and restored
 * afterwards via `afterEach`.
 *
 * GitLab API version / tier notes
 * --------------------------------
 * - All APIs exercised here are part of the **GitLab REST API v4**.
 * - Merge-request creation (`POST /api/v4/projects/:id/merge_requests`) and
 *   notes (`POST /api/v4/projects/:id/merge_requests/:iid/notes`) are available
 *   on every tier (Free, Premium, Ultimate) for both gitlab.com and self-hosted
 *   instances running GitLab 13.0+.
 * - The `remove_source_branch` flag is also available on all tiers.
 * - No GitLab-specific EE/paid-tier features are used in this module.
 *
 * Known GitLab-specific limitations
 * -----------------------------------
 * - SSH clone URLs cannot be used with `buildAuthenticatedUrl` (the function
 *   only handles HTTPS URLs).
 * - Project paths that contain URL-special characters must be percent-encoded
 *   before being sent to the API; the implementation uses `encodeURIComponent`.
 * - The 409 conflict fallback fetches opened MRs only — if the existing MR was
 *   closed/merged the list may be empty and the function will throw.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  buildAuthenticatedUrl,
  createMR,
  type GitLabConfig,
  type CreateMROptions,
} from "../repo/gitlab.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Response-like object that satisfies the fetch Response API. */
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

// ---------------------------------------------------------------------------
// buildAuthenticatedUrl
// ---------------------------------------------------------------------------

describe("buildAuthenticatedUrl", () => {
  const config: GitLabConfig = { token: "glpat-secret-token" };

  it("injects oauth2 credentials into a plain HTTPS URL by default", () => {
    const result = buildAuthenticatedUrl(
      "https://gitlab.com/myorg/myrepo.git",
      config,
    );
    expect(result).toBe(
      "https://oauth2:glpat-secret-token@gitlab.com/myorg/myrepo.git",
    );
  });

  it("uses a custom tokenUser when provided", () => {
    const result = buildAuthenticatedUrl(
      "https://gitlab.com/myorg/myrepo.git",
      config,
      "deploy-token-name",
    );
    expect(result).toBe(
      "https://deploy-token-name:glpat-secret-token@gitlab.com/myorg/myrepo.git",
    );
  });

  it("does not overwrite credentials that are already present in the URL", () => {
    const url = "https://existing-user:existing-pass@gitlab.com/myorg/myrepo.git";
    const result = buildAuthenticatedUrl(url, config);
    expect(result).toBe(url);
    expect(result).not.toContain("oauth2");
    expect(result).not.toContain("glpat-secret-token");
  });

  it("works with a self-hosted GitLab instance", () => {
    const result = buildAuthenticatedUrl(
      "https://gitlab.example.com/team/project.git",
      { token: "mytoken", host: "https://gitlab.example.com" },
    );
    expect(result).toBe(
      "https://oauth2:mytoken@gitlab.example.com/team/project.git",
    );
  });

  it("preserves the path, including nested group paths", () => {
    const result = buildAuthenticatedUrl(
      "https://gitlab.com/org/sub/project.git",
      config,
    );
    expect(result).toContain("/org/sub/project.git");
  });

  it("works for URLs without a .git suffix", () => {
    const result = buildAuthenticatedUrl(
      "https://gitlab.com/myorg/myrepo",
      config,
    );
    expect(result).toBe(
      "https://oauth2:glpat-secret-token@gitlab.com/myorg/myrepo",
    );
  });
});

// ---------------------------------------------------------------------------
// createMR
// ---------------------------------------------------------------------------

describe("createMR", () => {
  const config: GitLabConfig = { token: "glpat-test" };
  const options: CreateMROptions = {
    projectPath: "myorg/myrepo",
    sourceBranch: "feature/my-branch",
    targetBranch: "main",
    title: "My feature",
    description: "Adds a cool feature",
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates an MR and returns the web_url on success (201)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeResponse({ web_url: "https://gitlab.com/myorg/myrepo/-/merge_requests/42" }, 201),
    );

    const url = await createMR(config, options);
    expect(url).toBe("https://gitlab.com/myorg/myrepo/-/merge_requests/42");
  });

  it("creates an MR and returns web_url on a 200 response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeResponse({ web_url: "https://gitlab.com/myorg/myrepo/-/merge_requests/7" }, 200),
    );

    const url = await createMR(config, options);
    expect(url).toBe("https://gitlab.com/myorg/myrepo/-/merge_requests/7");
  });

  it("sends the correct API endpoint and headers", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        makeResponse({ web_url: "https://gitlab.com/myorg/myrepo/-/merge_requests/1" }),
      );

    await createMR(config, options);

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://gitlab.com/api/v4/projects/myorg%2Fmyrepo/merge_requests",
    );
    expect((init.headers as Record<string, string>)["PRIVATE-TOKEN"]).toBe(
      "glpat-test",
    );
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
    expect(init.method).toBe("POST");
  });

  it("sends the correct request body fields", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        makeResponse({ web_url: "https://gitlab.com/myorg/myrepo/-/merge_requests/1" }),
      );

    await createMR(config, options);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      source_branch: "feature/my-branch",
      target_branch: "main",
      title: "My feature",
      description: "Adds a cool feature",
      remove_source_branch: true,
    });
  });

  it("on 409 returns the existing MR url when list fetch succeeds", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    // First call: POST → 409 conflict
    fetchSpy.mockResolvedValueOnce(makeResponse("conflict", 409, { ok: false }));

    // Second call: GET list → existing MR
    fetchSpy.mockResolvedValueOnce(
      makeResponse([{ web_url: "https://gitlab.com/myorg/myrepo/-/merge_requests/5" }], 200),
    );

    const url = await createMR(config, options);
    expect(url).toBe("https://gitlab.com/myorg/myrepo/-/merge_requests/5");

    // Verify the list call includes the source/target query params
    const listCallUrl = fetchSpy.mock.calls[1]![0] as string;
    expect(listCallUrl).toContain("source_branch=");
    expect(listCallUrl).toContain("target_branch=main");
    expect(listCallUrl).toContain("state=opened");
  });

  it("on 409 throws when the list fetch returns non-ok", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    fetchSpy.mockResolvedValueOnce(makeResponse("conflict", 409, { ok: false }));
    fetchSpy.mockResolvedValueOnce(makeResponse("forbidden", 403, { ok: false }));

    await expect(createMR(config, options)).rejects.toThrow(
      "GitLab API error 409 creating MR",
    );
  });

  it("on 409 throws when the list is empty (existing MR not found)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    fetchSpy.mockResolvedValueOnce(makeResponse("conflict", 409, { ok: false }));
    fetchSpy.mockResolvedValueOnce(makeResponse([], 200)); // empty list

    await expect(createMR(config, options)).rejects.toThrow(
      "GitLab API error 409 creating MR",
    );
  });

  it("throws on a generic API error (non-409 non-ok status)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeResponse("Unauthorized", 401, { ok: false }),
    );

    await expect(createMR(config, options)).rejects.toThrow(
      "GitLab API error 401 creating MR",
    );
  });

  it("throws on a 500 server error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeResponse("Internal Server Error", 500, { ok: false }),
    );

    await expect(createMR(config, options)).rejects.toThrow(
      "GitLab API error 500 creating MR",
    );
  });

  it("uses a custom self-hosted host", async () => {
    const selfHostedConfig: GitLabConfig = {
      token: "mytoken",
      host: "https://gitlab.example.com",
    };

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        makeResponse({ web_url: "https://gitlab.example.com/myorg/myrepo/-/merge_requests/3" }),
      );

    const url = await createMR(selfHostedConfig, options);
    expect(url).toBe(
      "https://gitlab.example.com/myorg/myrepo/-/merge_requests/3",
    );

    const [callUrl] = fetchSpy.mock.calls[0] as [string];
    expect(callUrl).toMatch(/^https:\/\/gitlab\.example\.com\/api\/v4\//);
  });

  it("percent-encodes project paths that contain slashes", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        makeResponse({ web_url: "https://gitlab.com/a/b/c/-/merge_requests/1" }),
      );

    await createMR(config, { ...options, projectPath: "a/b/c" });

    const [callUrl] = fetchSpy.mock.calls[0] as [string];
    expect(callUrl).toContain("a%2Fb%2Fc");
    expect(callUrl).not.toMatch(/\/a\/b\/c\//);
  });
});

