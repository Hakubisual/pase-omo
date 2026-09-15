import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { WorkerStatusSchema } from "../../shared/workers.js";

const WorkerStatusPayloadSchema = z.object({
  workerId: z.string(),
  sessionId: z.string().uuid(),
  status: WorkerStatusSchema,
  error: z.string().optional(),
  stopReason: z.string().optional(),
  timestamp: z.string().datetime(),
});
export type WorkerStatusPayload = z.infer<typeof WorkerStatusPayloadSchema>;

export interface WorkerLifecycleOptions {
  stateDir?: string | undefined;
}

export function generateLifecycleExtensionCode(config: {
  workerId: string;
  sessionId: string;
  statusFilePath: string;
}): string {
  const safeStatusPath = config.statusFilePath.replace(/\\/g, "/");
  const safeWorkerId = JSON.stringify(config.workerId);
  const safeSessionId = JSON.stringify(config.sessionId);

  return `// OmO Worker Lifecycle Extension
import fs from "node:fs";
import path from "node:path";

const workerId = ${safeWorkerId};
const sessionId = ${safeSessionId};
const statusFilePath = ${JSON.stringify(safeStatusPath)};

function writeStatus(status, extra = {}) {
    const parentDir = path.dirname(statusFilePath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
    const payload = {
      workerId,
      sessionId,
      status,
      timestamp: new Date().toISOString(),
      ...extra,
    };
    const tmpFile = statusFilePath + "." + Date.now() + "." + Math.random().toString(36).slice(2) + ".tmp";
    fs.writeFileSync(tmpFile, JSON.stringify(payload, null, 2), "utf8");
    fs.renameSync(tmpFile, statusFilePath);
}

export default function registerWorkerLifecycle(pi) {
  let outcome = null;
  let settled = false;

  pi.on("session_start", async () => {
    writeStatus("running", { event: "session_start" });
  });

  pi.on("agent_start", async () => {
    outcome = null;
    settled = false;
    writeStatus("running", { event: "agent_start" });
  });

  pi.on("agent_end", async (event) => {
    if (event.willRetry) { outcome = null; return; }
    const assistant = event.messages.findLast(message => message.role === "assistant");
    const stopReason = assistant?.stopReason;
    if (event.aborted || stopReason === "aborted") {
      outcome = { status: "cancelled", stopReason: "aborted" };
    } else if (!assistant || stopReason === "error" || stopReason === "length") {
      outcome = {
        status: "failed",
        error: assistant?.errorMessage || "Worker ended without a complete assistant response",
        ...(stopReason ? { stopReason } : {}),
      };
    } else {
      outcome = { status: "completed", ...(stopReason ? { stopReason } : {}) };
    }
  });

  pi.on("agent_settled", async () => {
    if (outcome) {
      settled = true;
      const { status, ...extra } = outcome;
      writeStatus(status, extra);
    }
  });

  pi.on("session_shutdown", async (event) => {
    if (!settled && event.reason !== "reload") {
      writeStatus("cancelled", { stopReason: "session_shutdown" });
    }
  });
}
`;
}

export class WorkerLifecycleWatcher {
  private readonly watchers = new Map<string, fs.FSWatcher>();
  private readonly stateDir: string;

  constructor(options?: WorkerLifecycleOptions) {
    this.stateDir =
      options?.stateDir ||
      path.join(process.env.PASEO_HOME ?? path.join(os.homedir(), ".paseo"), "omo-workers", "lifecycle");
    if (!fs.existsSync(this.stateDir)) {
      fs.mkdirSync(this.stateDir, { recursive: true });
    }
  }

  public getStatusFilePath(workerId: string): string {
    const safeId = workerId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this.stateDir, `${safeId}.status.json`);
  }

  public getExtensionFilePath(workerId: string): string {
    const safeId = workerId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this.stateDir, `${safeId}.extension.js`);
  }

  public createExtensionScript(config: {
    workerId: string;
    sessionId: string;
    statusFilePath?: string | undefined;
  }): { extensionPath: string; statusFilePath: string } {
    const statusFilePath = config.statusFilePath || this.getStatusFilePath(config.sessionId);
    const extensionPath = this.getExtensionFilePath(config.sessionId);

    const source = generateLifecycleExtensionCode({
      workerId: config.workerId,
      sessionId: config.sessionId,
      statusFilePath,
    });

    fs.writeFileSync(extensionPath, source, "utf8");
    return { extensionPath, statusFilePath };
  }

  public emitStatusUpdate(statusFilePath: string, payload: WorkerStatusPayload): void {
    const parentDir = path.dirname(statusFilePath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
    const tmpPath = `${statusFilePath}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), "utf8");
    fs.renameSync(tmpPath, statusFilePath);
  }

  public readStatus(statusFilePath: string): WorkerStatusPayload | null {
    if (!fs.existsSync(statusFilePath)) return null;
    const raw = fs.readFileSync(statusFilePath, "utf8");
    return WorkerStatusPayloadSchema.parse(JSON.parse(raw));
  }

  public watch(
    sessionId: string,
    statusFilePath: string,
    onUpdate: (payload: WorkerStatusPayload) => void,
    onError: (error: Error) => void = error => { throw error; },
  ): () => void {
    const parentDir = path.dirname(statusFilePath);
    const targetBase = path.basename(statusFilePath);
    let signature = "";
    const refresh = () => {
      try {
        const current = this.readStatus(statusFilePath);
        if (!current || current.sessionId !== sessionId) return;
        const next = JSON.stringify(current);
        if (next === signature) return;
        signature = next;
        onUpdate(current);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        onError(error);
      }
    };
    this.watchers.get(sessionId)?.close();
    const watcher = fs.watch(parentDir, (_event, filename) => {
      if (filename === null || filename.toString() === targetBase) refresh();
    });
    watcher.on("error", onError);
    this.watchers.set(sessionId, watcher);
    refresh();
    return () => {
      watcher.close();
      if (this.watchers.get(sessionId) === watcher) this.watchers.delete(sessionId);
    };
  }

  public clear(): void {
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();
  }
}
