import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { OmoLaunch } from "./omo-cli.js";

/** Correlated reply envelope of the OmO RPC protocol. */
export interface OmoResponse {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

/** Any uncorrelated record. `type` is the wire type verbatim. */
export interface OmoEvent {
  type: string;
  [key: string]: unknown;
}

export interface OmoProcessOptions {
  launch: OmoLaunch;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  onEvent(event: OmoEvent): void;
  /** Called once when the child exits, with collected stderr for diagnostics. */
  onExit(info: { code: number | null; signal: string | null; stderr: string }): void;
  log?(message: string): void;
}

const REQUEST_TIMEOUT_MS = 180_000;
const STDERR_LIMIT = 16_384;

/**
 * One `omo --mode rpc` child speaking newline-delimited JSON.
 *
 * Framing facts this class encodes, verified against omo 2026.9.13:
 * - one JSON object per line on stdin and stdout, LF terminated;
 * - extensions occasionally write plain text to stdout, so a line that does not
 *   parse as JSON is skipped rather than treated as a protocol violation;
 * - a record carrying our `id` settles exactly that request; everything else is
 *   an event;
 * - `extension_ui_response` is one-way and reuses the request's native id.
 */
export class OmoProcess {
  private child: ChildProcessWithoutNullStreams | undefined;
  private stdoutBuffer = "";
  private stderrTail = "";
  private readonly pending = new Map<
    string,
    { resolve(value: OmoResponse): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >();
  private exited = false;
  private resolveExit: (() => void) | undefined;
  /**
   * Settles once the child is gone (exit, spawn failure, or the kill backstop
   * in `stop()`), so a caller that replaces this process can wait for the old
   * one to release the session file before the new one opens it.
   *
   * A process that was never started settles only through `stop()`, so callers
   * bound the wait rather than awaiting this alone.
   */
  readonly whenExited: Promise<void> = new Promise<void>((resolve) => {
    this.resolveExit = resolve;
  });

  constructor(private readonly options: OmoProcessOptions) {}

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get stderr(): string {
    return this.stderrTail;
  }

  start(): void {
    if (this.child) throw new Error("OmO process already started");
    const child = spawn(this.options.launch.command, [...this.options.launch.base, ...this.options.args], {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    this.child = child;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consume(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_LIMIT);
    });
    child.on("error", (error) => {
      this.settleAllWith(new Error(`OmO process failed to start: ${error.message}`));
      this.finish(null, null);
    });
    child.on("exit", (code, signal) => {
      this.settleAllWith(new Error(`OmO process exited (code ${code ?? "null"})`));
      this.finish(code, signal);
    });
  }

  private finish(code: number | null, signal: string | null): void {
    if (this.exited) return;
    this.exited = true;
    this.resolveExit?.();
    this.options.onExit({ code, signal, stderr: this.stderrTail });
  }

  private consume(chunk: string): void {
    this.stdoutBuffer += chunk;
    for (;;) {
      const index = this.stdoutBuffer.indexOf("\n");
      if (index < 0) break;
      const line = this.stdoutBuffer.slice(0, index).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
      if (!line.trim()) continue;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        // Extension chatter on stdout is not a protocol error.
        continue;
      }
      this.route(record);
    }
  }

  private route(record: unknown): void {
    if (typeof record !== "object" || record === null) return;
    const value = record as Record<string, unknown>;
    if (value.type === "response" && typeof value.id === "string") {
      const waiter = this.pending.get(value.id);
      if (waiter) {
        this.pending.delete(value.id);
        clearTimeout(waiter.timer);
        waiter.resolve(value as unknown as OmoResponse);
        return;
      }
    }
    if (typeof value.type === "string") this.options.onEvent(value as OmoEvent);
  }

  private settleAllWith(error: Error): void {
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
  }

  /** Send a command and await its correlated response. */
  request(command: string, params: Record<string, unknown> = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<OmoResponse> {
    const child = this.child;
    if (!child || this.exited) return Promise.reject(new Error("OmO process is not running"));
    const id = randomUUID();
    const payload = JSON.stringify({ ...params, id, type: command });
    return new Promise<OmoResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`OmO command timed out: ${command}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${payload}\n`, (error) => {
        if (!error) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error(`OmO stdin write failed: ${error.message}`));
      });
    });
  }

  /** Await a command and unwrap `data`, turning `success: false` into a rejection. */
  async call<T>(command: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    const response = await this.request(command, params, timeoutMs);
    if (!response.success) throw new Error(response.error || `OmO command failed: ${command}`);
    return response.data as T;
  }

  /** One-way record; used for `extension_ui_response`, whose id is not ours. */
  notify(record: Record<string, unknown>): void {
    const child = this.child;
    if (!child || this.exited) return;
    child.stdin.write(`${JSON.stringify(record)}\n`);
  }

  /**
   * Best-effort teardown that returns immediately.
   *
   * Paseo closes provider connections while it is also tearing the plugin's IPC
   * channel down, so a slow `close()` races the host's own reply. Closing stdin
   * is what makes OmO shut its session down cleanly; the timer is the backstop.
   */
  stop(): void {
    const child = this.child;
    if (!child || this.exited) {
      // Nothing to wait for: a process that never spawned would otherwise leave
      // `whenExited` pending forever.
      this.resolveExit?.();
      return;
    }
    try {
      child.stdin.end();
    } catch {
      // The pipe may already be gone; the kill timer still applies.
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Already reaped.
      }
    }, 1500);
    timer.unref();
  }
}
