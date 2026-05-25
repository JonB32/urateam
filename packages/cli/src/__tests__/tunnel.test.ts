import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import {
  TunnelManager,
  CloudflaredMissingError,
  type TunnelManagerOpts,
} from "../lib/tunnel.js";

/**
 * Build a mock child-process for cloudflared. We use a real EventEmitter +
 * Readable streams so the `data` / `exit` listeners the TunnelManager
 * attaches behave like the real surface.
 */
function makeFakeChild(): {
  child: EventEmitter & {
    stdout: Readable;
    stderr: Readable;
    kill: ReturnType<typeof vi.fn>;
    exitCode: number | null;
    killed: boolean;
  };
  emitStderr: (line: string) => void;
  emitExit: (code: number | null, signal: NodeJS.Signals | null) => void;
} {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const child = new EventEmitter() as any;
  child.stdout = stdout;
  child.stderr = stderr;
  child.exitCode = null;
  child.killed = false;
  child.kill = vi.fn((_sig: string) => {
    child.killed = true;
    return true;
  });
  return {
    child,
    emitStderr: (line: string) => stderr.push(`${line}\n`),
    emitExit: (code, signal) => {
      child.exitCode = code;
      child.emit("exit", code, signal);
    },
  };
}

function makeOpts(
  overrides: Partial<TunnelManagerOpts> = {},
): TunnelManagerOpts {
  return {
    mode: "cloudflare-quick",
    localPort: 3000,
    initialRestartDelayMs: 10,
    maxRestartDelayMs: 100,
    maxRestartAttempts: 3,
    urlDetectTimeoutMs: 500,
    log: () => {},
    ...overrides,
  };
}

describe("TunnelManager — cloudflare-quick", () => {
  it("parses the public URL from cloudflared's stderr", async () => {
    const { child, emitStderr } = makeFakeChild();
    const spawnMock = vi.fn(() => child as any);
    const mgr = new TunnelManager(makeOpts({ spawn: spawnMock as any }));
    const startPromise = mgr.start();
    // Give the child time to be wired up before pushing the URL.
    setTimeout(() => {
      emitStderr("2025-01-01 INF Starting tunnel");
      emitStderr(
        "2025-01-01 INF +-----------+ Your quick tunnel is up at https://abc123.trycloudflare.com",
      );
    }, 5);
    const result = await startPromise;
    expect(result.publicUrl).toBe("https://abc123.trycloudflare.com");
    expect(result.restartCount).toBe(0);
    expect(spawnMock).toHaveBeenCalledWith(
      "cloudflared",
      expect.arrayContaining(["tunnel", "--url", "http://localhost:3000"]),
      expect.any(Object),
    );
  });

  it("times out when no URL appears in stderr", async () => {
    const { child } = makeFakeChild();
    const spawnMock = vi.fn(() => child as any);
    const mgr = new TunnelManager(
      makeOpts({ spawn: spawnMock as any, urlDetectTimeoutMs: 50 }),
    );
    await expect(mgr.start()).rejects.toThrow(/did not see/);
  });

  it("throws CloudflaredMissingError when spawn throws ENOENT", async () => {
    const spawnMock = vi.fn(() => {
      const err: NodeJS.ErrnoException = new Error("ENOENT");
      err.code = "ENOENT";
      throw err;
    });
    const mgr = new TunnelManager(makeOpts({ spawn: spawnMock as any }));
    await expect(mgr.start()).rejects.toBeInstanceOf(CloudflaredMissingError);
  });

  it("throws CloudflaredMissingError when child emits ENOENT", async () => {
    const { child, emitExit } = makeFakeChild();
    const spawnMock = vi.fn(() => child as any);
    const mgr = new TunnelManager(
      makeOpts({ spawn: spawnMock as any, urlDetectTimeoutMs: 500 }),
    );
    const startPromise = mgr.start();
    setTimeout(() => {
      const err: NodeJS.ErrnoException = new Error("ENOENT");
      err.code = "ENOENT";
      child.emit("error", err);
      emitExit(127, null);
    }, 5);
    await expect(startPromise).rejects.toBeInstanceOf(CloudflaredMissingError);
    // wireSupervisor schedules a restart timer on exit; stop() cancels it so
    // it doesn't spawn a new child and produce an unhandled rejection later.
    await mgr.stop();
  });
});

describe("TunnelManager — cloudflare-token", () => {
  it("requires both token and publicUrl", async () => {
    const mgr1 = new TunnelManager(
      makeOpts({ mode: "cloudflare-token" }),
    );
    await expect(mgr1.start()).rejects.toThrow(/token/);
    const mgr2 = new TunnelManager(
      makeOpts({ mode: "cloudflare-token", token: "tok" }),
    );
    await expect(mgr2.start()).rejects.toThrow(/publicUrl/);
  });

  it("returns the static publicUrl without waiting for stderr parsing", async () => {
    const { child } = makeFakeChild();
    const spawnMock = vi.fn(() => child as any);
    const mgr = new TunnelManager(
      makeOpts({
        mode: "cloudflare-token",
        token: "tok-abc",
        publicUrl: "https://urateam.example.com",
        spawn: spawnMock as any,
      }),
    );
    const result = await mgr.start();
    expect(result.publicUrl).toBe("https://urateam.example.com");
    expect(spawnMock).toHaveBeenCalledWith(
      "cloudflared",
      expect.arrayContaining(["tunnel", "run", "--token", "tok-abc"]),
      expect.any(Object),
    );
  });
});

describe("TunnelManager — restart-on-exit + graceful shutdown", () => {
  it("emits 'stopped' on child exit", async () => {
    const { child, emitStderr, emitExit } = makeFakeChild();
    const spawnMock = vi.fn(() => child as any);
    // Use a long restart delay so the restart timer cannot fire before stop() is called.
    const mgr = new TunnelManager(
      makeOpts({ spawn: spawnMock as any, initialRestartDelayMs: 60_000 }),
    );
    const startPromise = mgr.start();
    setTimeout(
      () => emitStderr("Your quick tunnel is up at https://abc.trycloudflare.com"),
      5,
    );
    await startPromise;
    const stopped = new Promise<{ exitCode: number | null; signal: string | null }>(
      (resolve) => mgr.once("stopped", resolve),
    );
    emitExit(1, null);
    const evt = await stopped;
    expect(evt.exitCode).toBe(1);
    // Cancel the pending restart timer to avoid a dangling URL-detect timeout
    // that would emit "error" with no listener after the test ends.
    await mgr.stop();
  });

  it("restarts after a non-zero exit with exponential backoff", async () => {
    vi.useFakeTimers();
    try {
      const spawnedChildren: ReturnType<typeof makeFakeChild>[] = [];
      const spawnMock = vi.fn(() => {
        const c = makeFakeChild();
        spawnedChildren.push(c);
        return c.child as any;
      });
      const mgr = new TunnelManager(
        makeOpts({
          spawn: spawnMock as any,
          initialRestartDelayMs: 100,
          maxRestartAttempts: 3,
          urlDetectTimeoutMs: 9999,
        }),
      );
      const startPromise = mgr.start();
      // First child emits URL
      spawnedChildren[0]!.emitStderr(
        "Your quick tunnel is up at https://a.trycloudflare.com",
      );
      await startPromise;
      // Crash the first child.
      spawnedChildren[0]!.emitExit(1, null);
      // Allow the backoff timer (100ms) to fire and the second child to spawn.
      await vi.advanceTimersByTimeAsync(100);
      expect(spawnMock).toHaveBeenCalledTimes(2);
      // Crash second child; next backoff is 200ms.
      spawnedChildren[1]!.emitStderr(
        "Your quick tunnel is up at https://b.trycloudflare.com",
      );
      spawnedChildren[1]!.emitExit(1, null);
      await vi.advanceTimersByTimeAsync(99);
      expect(spawnMock).toHaveBeenCalledTimes(2); // not yet
      await vi.advanceTimersByTimeAsync(1);
      expect(spawnMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("getRestartCount() reflects supervisor restart attempts", async () => {
    vi.useFakeTimers();
    try {
      const spawnedChildren: ReturnType<typeof makeFakeChild>[] = [];
      const spawnMock = vi.fn(() => {
        const c = makeFakeChild();
        spawnedChildren.push(c);
        return c.child as any;
      });
      const mgr = new TunnelManager(
        makeOpts({
          spawn: spawnMock as any,
          initialRestartDelayMs: 10,
          maxRestartAttempts: 5,
          urlDetectTimeoutMs: 9999,
        }),
      );
      const startPromise = mgr.start();
      spawnedChildren[0]!.emitStderr(
        "Your quick tunnel is up at https://a.trycloudflare.com",
      );
      await startPromise;
      expect(mgr.getRestartCount()).toBe(0);
      spawnedChildren[0]!.emitExit(1, null);
      await vi.advanceTimersByTimeAsync(10);
      // Restart-attempt 1 has fired and spawned a new child.
      expect(spawnMock).toHaveBeenCalledTimes(2);
      expect(mgr.getRestartCount()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after maxRestartAttempts and emits 'error'", async () => {
    vi.useFakeTimers();
    try {
      const spawnedChildren: ReturnType<typeof makeFakeChild>[] = [];
      const spawnMock = vi.fn(() => {
        const c = makeFakeChild();
        spawnedChildren.push(c);
        return c.child as any;
      });
      const mgr = new TunnelManager(
        makeOpts({
          spawn: spawnMock as any,
          initialRestartDelayMs: 10,
          maxRestartAttempts: 2,
          urlDetectTimeoutMs: 9999,
        }),
      );
      const errored = new Promise<Error>((resolve) =>
        mgr.once("error", resolve),
      );
      const startPromise = mgr.start();
      spawnedChildren[0]!.emitStderr(
        "Your quick tunnel is up at https://a.trycloudflare.com",
      );
      await startPromise;
      // Crash repeatedly past the cap.
      for (let i = 0; i < 5; i++) {
        if (!spawnedChildren[i]) break;
        spawnedChildren[i]!.emitExit(1, null);
        await vi.advanceTimersByTimeAsync(1000);
        if (spawnedChildren[i + 1]) {
          spawnedChildren[i + 1]!.emitStderr(
            `Your quick tunnel is up at https://x${i}.trycloudflare.com`,
          );
        }
      }
      const err = await errored;
      expect(err.message).toMatch(/giving up/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop() SIGTERMs the child and cancels a pending restart", async () => {
    const { child, emitStderr, emitExit } = makeFakeChild();
    const spawnMock = vi.fn(() => child as any);
    const mgr = new TunnelManager(
      makeOpts({
        spawn: spawnMock as any,
        initialRestartDelayMs: 60_000,
      }),
    );
    const startPromise = mgr.start();
    setTimeout(
      () => emitStderr("Your quick tunnel is up at https://abc.trycloudflare.com"),
      5,
    );
    await startPromise;
    // Trigger an exit so a restart-timer is pending.
    emitExit(1, null);
    // Now stop — pending restart must be cancelled.
    const stopPromise = mgr.stop();
    // Stop awaits the child's exit promise; that exit has already fired.
    await stopPromise;
    // After stop, no further spawn calls should happen.
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("stop() while child is running sends SIGTERM", async () => {
    const { child, emitStderr, emitExit } = makeFakeChild();
    const spawnMock = vi.fn(() => child as any);
    const mgr = new TunnelManager(makeOpts({ spawn: spawnMock as any }));
    const startPromise = mgr.start();
    setTimeout(
      () => emitStderr("Your quick tunnel is up at https://abc.trycloudflare.com"),
      5,
    );
    await startPromise;
    const stopPromise = mgr.stop();
    // Mock the child's exit response to SIGTERM.
    setTimeout(() => emitExit(null, "SIGTERM"), 5);
    await stopPromise;
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
