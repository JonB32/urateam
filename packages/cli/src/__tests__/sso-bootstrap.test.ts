import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { bootstrapSsoFromEnv } from "../sso-bootstrap.js";

// Stub the core module so we don't actually hit WorkOS during tests.
vi.mock("@urateam/core", async () => {
  const actual = await vi.importActual<typeof import("@urateam/core")>(
    "@urateam/core",
  );
  return {
    ...actual,
    getDefaultWorkosClient: vi.fn(async (_apiKey: string) => ({
      getAuthorizationUrl: async () => "https://stub/auth",
      authenticateWithCode: async () => ({
        user: {
          id: "u",
          email: "u@example.com",
          firstName: null,
          lastName: null,
        },
      }),
    })),
  };
});

const FULL_ENV: NodeJS.ProcessEnv = {
  URATEAM_SSO_ENABLED: "true",
  URATEAM_WORKOS_API_KEY: "sk_test",
  URATEAM_WORKOS_CLIENT_ID: "client_test",
  URATEAM_WORKOS_REDIRECT_URI: "https://dash.example.com/auth/callback",
  URATEAM_SSO_STATE_SECRET: "0123456789abcdef0123456789abcdef",
};

// The first dynamic import("@urateam/core") in a worker is slow (~3s) because
// it pulls in the whole core barrel. Give each test 15s of headroom.
describe("bootstrapSsoFromEnv", { timeout: 15_000 }, () => {
  let exitSpy: any;
  let errorSpy: any;

  beforeEach(() => {
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((_code?: number) => {
        throw new Error("__EXIT__");
      }) as never);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("returns undefined when SSO is not enabled", async () => {
    const result = await bootstrapSsoFromEnv({});
    expect(result).toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("returns sso config + workos client when all env vars are present", async () => {
    const result = await bootstrapSsoFromEnv({ ...FULL_ENV });
    expect(result).toBeDefined();
    expect(result!.sso.enabled).toBe(true);
    expect(result!.sso.workosClientId).toBe("client_test");
    expect(result!.sso.redirectUri).toBe(
      "https://dash.example.com/auth/callback",
    );
    expect(result!.workos).toBeDefined();
    expect(typeof result!.workos.getAuthorizationUrl).toBe("function");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("exits when URATEAM_WORKOS_API_KEY is missing", async () => {
    const env = { ...FULL_ENV };
    delete env.URATEAM_WORKOS_API_KEY;
    await expect(bootstrapSsoFromEnv(env)).rejects.toThrow("__EXIT__");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalled();
    const msg = errorSpy.mock.calls[0]!.join(" ");
    expect(msg).toContain("URATEAM_WORKOS_API_KEY");
  });

  it("exits when URATEAM_SSO_STATE_SECRET is missing", async () => {
    const env = { ...FULL_ENV };
    delete env.URATEAM_SSO_STATE_SECRET;
    await expect(bootstrapSsoFromEnv(env)).rejects.toThrow("__EXIT__");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("accepts optional allowedDomain", async () => {
    const result = await bootstrapSsoFromEnv({
      ...FULL_ENV,
      URATEAM_SSO_ALLOWED_DOMAIN: "acme.com",
    });
    expect(result!.sso.allowedDomain).toBe("acme.com");
  });
});
