/**
 * `ura start --tunnel <mode>` runtime: wraps `cloudflared` as a child process.
 *
 * Two modes:
 *   - "cloudflare-quick": `cloudflared tunnel --url http://localhost:<port>`.
 *     Cloudflare assigns a random `*.trycloudflare.com` URL, which is parsed
 *     out of cloudflared's stderr.
 *   - "cloudflare-token": `cloudflared tunnel --token <token> run`. Operator
 *     has already configured a named tunnel in Cloudflare; the public URL
 *     is known ahead of time and must be passed via `opts.publicUrl` /
 *     `URATEAM_PUBLIC_URL`.
 *
 * Restart-on-exit: the child is supervised with exponential-backoff retries
 * (default 1s → 2s → 4s ... capped at 30s, max 10 attempts). On `stop()`
 * the supervisor cancels any pending retry timer and SIGTERMs the child.
 *
 * All I/O is injectable for tests; the real `spawn` is only invoked when the
 * caller doesn't override `opts.spawn`.
 */
import {
  spawn as realSpawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { EventEmitter } from "node:events";

export type TunnelMode = "cloudflare-quick" | "cloudflare-token";

export interface TunnelManagerOpts {
  mode: TunnelMode;
  /** Required for "cloudflare-token" — typically from `CLOUDFLARE_TUNNEL_TOKEN`. */
  token?: string;
  /** Static public URL — required for "cloudflare-token", ignored for quick. */
  publicUrl?: string;
  /** Local port the daemon listens on. For "cloudflare-quick". */
  localPort: number;
  /**
   * Override for real `spawn` — tests pass a stub returning a controllable
   * EventEmitter with `stdout`, `stderr`, `kill`, and an `on("exit", ...)`
   * surface.
   */
  spawn?: typeof realSpawn;
  /** Initial restart delay (ms). Default 1000. */
  initialRestartDelayMs?: number;
  /** Max restart delay (ms). Default 30000. */
  maxRestartDelayMs?: number;
  /** Max restart attempts before giving up. Default 10. */
  maxRestartAttempts?: number;
  /** Time to wait for the public URL to appear in stderr (quick mode). Default 30s. */
  urlDetectTimeoutMs?: number;
  /** Logger (defaults to console.log). */
  log?: (msg: string) => void;
}

export interface TunnelStartResult {
  publicUrl: string;
  restartCount: number;
}

/** Cloudflare quick-tunnel stderr line we parse the URL out of. */
const QUICK_URL_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

/**
 * Thrown when the `cloudflared` binary isn't installed (ENOENT on spawn).
 * Carries an install hint so the start command can render an actionable
 * error.
 */
export class CloudflaredMissingError extends Error {
  constructor() {
    super(
      "cloudflared binary not found. Install it:\n" +
        "  macOS:  brew install cloudflared\n" +
        "  Linux:  https://pkg.cloudflare.com/index.html (apt/yum)\n" +
        "  Other:  https://github.com/cloudflare/cloudflared/releases",
    );
    this.name = "CloudflaredMissingError";
  }
}

export class TunnelManager extends EventEmitter {
  private child: ChildProcess | null = null;
  private restartCount = 0;
  private shuttingDown = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private publicUrl: string | null = null;
  private readonly spawnFn: typeof realSpawn;
  private readonly initialRestartDelayMs: number;
  private readonly maxRestartDelayMs: number;
  private readonly maxRestartAttempts: number;
  private readonly urlDetectTimeoutMs: number;
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: TunnelManagerOpts) {
    super();
    this.spawnFn = opts.spawn ?? realSpawn;
    this.initialRestartDelayMs = opts.initialRestartDelayMs ?? 1000;
    this.maxRestartDelayMs = opts.maxRestartDelayMs ?? 30000;
    this.maxRestartAttempts = opts.maxRestartAttempts ?? 10;
    this.urlDetectTimeoutMs = opts.urlDetectTimeoutMs ?? 30000;
    this.log = opts.log ?? ((m) => console.log(m));
  }

  /**
   * Start the tunnel. Resolves with the detected (quick) or pre-configured
   * (token) public URL. Throws `CloudflaredMissingError` on ENOENT.
   */
  async start(): Promise<TunnelStartResult> {
    if (this.opts.mode === "cloudflare-token") {
      if (!this.opts.token) {
        throw new Error(
          "TunnelManager: cloudflare-token mode requires `token` (or CLOUDFLARE_TUNNEL_TOKEN env var)",
        );
      }
      if (!this.opts.publicUrl) {
        throw new Error(
          "TunnelManager: cloudflare-token mode requires `publicUrl` (or URATEAM_PUBLIC_URL env var)",
        );
      }
      this.publicUrl = this.opts.publicUrl;
    }

    const url = await this.spawnAndDetectUrl();
    this.publicUrl = url;
    return { publicUrl: url, restartCount: this.restartCount };
  }

  /**
   * Stop the tunnel. Cancels any pending restart, SIGTERMs the child, and
   * awaits the exit. Subsequent restarts (e.g. an exit fired during
   * shutdown) are skipped.
   */
  async stop(): Promise<void> {
    this.shuttingDown = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.child && this.child.exitCode === null && !this.child.killed) {
      const exited = new Promise<void>((resolve) => {
        this.child!.once("exit", () => resolve());
      });
      this.child.kill("SIGTERM");
      await exited;
    }
  }

  private buildArgs(): string[] {
    if (this.opts.mode === "cloudflare-quick") {
      return [
        "tunnel",
        "--no-autoupdate",
        "--url",
        `http://localhost:${this.opts.localPort}`,
      ];
    }
    return [
      "tunnel",
      "--no-autoupdate",
      "run",
      "--token",
      this.opts.token!,
    ];
  }

  private spawnChild(): ChildProcess {
    const spawnOpts: SpawnOptions = { stdio: ["ignore", "pipe", "pipe"] };
    try {
      return this.spawnFn("cloudflared", this.buildArgs(), spawnOpts);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new CloudflaredMissingError();
      }
      throw err;
    }
  }

  private async spawnAndDetectUrl(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = this.spawnChild();
      } catch (err) {
        reject(err);
        return;
      }

      // Hoisted so onError can cancel it before the promise is already settled.
      let urlTimer: ReturnType<typeof setTimeout> | undefined;

      // Synchronous ENOENT surfaces as an "error" event on the child, not as
      // a throw — cover both paths.
      const onError = (err: NodeJS.ErrnoException) => {
        clearTimeout(urlTimer);
        if (err.code === "ENOENT") {
          reject(new CloudflaredMissingError());
        } else {
          reject(err);
        }
      };
      child.once("error", onError);
      this.child = child;
      this.wireSupervisor(child);

      if (this.opts.mode === "cloudflare-token") {
        // We already have a static publicUrl; the spawn either succeeds or
        // exits — the supervisor handles both. Resolve immediately.
        resolve(this.opts.publicUrl!);
        return;
      }

      urlTimer = setTimeout(() => {
        reject(
          new Error(
            `TunnelManager: did not see a *.trycloudflare.com URL within ${this.urlDetectTimeoutMs}ms`,
          ),
        );
      }, this.urlDetectTimeoutMs);

      const onStderr = (chunk: Buffer | string) => {
        const text = chunk.toString();
        const match = text.match(QUICK_URL_REGEX);
        if (match) {
          clearTimeout(urlTimer);
          child.stderr?.removeListener("data", onStderr);
          this.log(`🌐 Public URL: ${match[0]}`);
          resolve(match[0]);
        }
      };
      child.stderr?.on("data", onStderr);
    });
  }

  /**
   * Wire the supervisor: on unexpected exit, schedule a restart with
   * exponential backoff. Caps at `maxRestartAttempts` then emits "error".
   */
  private wireSupervisor(child: ChildProcess): void {
    child.once("exit", (code, signal) => {
      this.child = null;
      this.emit("stopped", {
        exitCode: code,
        signal,
        restartCount: this.restartCount,
      });
      if (this.shuttingDown) return;
      if (this.restartCount >= this.maxRestartAttempts) {
        this.emit(
          "error",
          new Error(
            `TunnelManager: cloudflared exited ${this.restartCount} times in a row; giving up`,
          ),
        );
        return;
      }
      const delay = Math.min(
        this.initialRestartDelayMs * 2 ** this.restartCount,
        this.maxRestartDelayMs,
      );
      this.log(
        `tunnel: cloudflared exited (code=${code}, signal=${signal}); restart #${this.restartCount + 1} in ${delay}ms`,
      );
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        this.restartCount += 1;
        this.restart().catch((err) => this.emit("error", err));
      }, delay);
    });
  }

  private async restart(): Promise<void> {
    if (this.shuttingDown) return;
    if (this.opts.mode === "cloudflare-quick") {
      try {
        const url = await this.spawnAndDetectUrl();
        this.publicUrl = url;
        this.emit("started", {
          publicUrl: url,
          restartCount: this.restartCount,
        });
      } catch (err) {
        this.emit("error", err);
      }
      return;
    }
    // token mode: spawn child; publicUrl is already known.
    try {
      const child = this.spawnChild();
      this.child = child;
      this.wireSupervisor(child);
      this.emit("started", {
        publicUrl: this.publicUrl!,
        restartCount: this.restartCount,
      });
    } catch (err) {
      this.emit("error", err);
    }
  }

  /** Currently-known public URL, or null before `start()`. */
  getPublicUrl(): string | null {
    return this.publicUrl;
  }

  /**
   * Total restart attempts made since `start()`. Never resets within the
   * lifetime of a single TunnelManager — so even a long stable period
   * followed by a single new failure still incurs the cap-tier delay.
   * Operators who care can construct a fresh manager. Used by the
   * `tunnel.stopped` audit event to attribute flap loops correctly.
   */
  getRestartCount(): number {
    return this.restartCount;
  }
}
