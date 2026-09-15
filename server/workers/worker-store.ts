import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { WorkerError, WorkerRecordSchema, type WorkerRecord } from "../../shared/workers.js";
import { atomicWriteJson } from "./atomic-json.js";

const GroupSchema = z.object({
  workspaceId: z.string().min(1),
  agentId: z.string().min(1),
  workers: z.array(WorkerRecordSchema),
});
type WorkerGroup = z.infer<typeof GroupSchema>;

export interface WorkerStoreOptions {
  readonly storageDir?: string | undefined;
}

export class WorkerStore extends EventEmitter {
  private readonly storageDir: string;

  constructor(options?: WorkerStoreOptions) {
    super();
    this.storageDir = options?.storageDir ??
      path.join(process.env.PASEO_HOME ?? path.join(os.homedir(), ".paseo"), "omo-workers", "state");
    fs.mkdirSync(this.storageDir, { recursive: true });
  }

  private getFilePath(workspaceId: string, agentId: string): string {
    const key = createHash("sha256").update(JSON.stringify([workspaceId, agentId])).digest("hex");
    return path.join(this.storageDir, `${key}.json`);
  }

  public getWorkers(workspaceId: string, agentId: string): WorkerRecord[] {
    const file = this.getFilePath(workspaceId, agentId);
    if (!fs.existsSync(file)) return [];
    const group = GroupSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
    if (group.workspaceId !== workspaceId || group.agentId !== agentId ||
        group.workers.some(worker => worker.workspaceId !== workspaceId || worker.agentId !== agentId)) {
      throw new WorkerError("FOREIGN_OWNER", "Worker state belongs to another chat");
    }
    return group.workers;
  }

  public getWorker(workspaceId: string, agentId: string, workerId: string): WorkerRecord | undefined {
    return this.getWorkers(workspaceId, agentId).find(worker => worker.id === workerId);
  }

  public async saveWorkers(workspaceId: string, agentId: string, workers: WorkerRecord[]): Promise<void> {
    const group = GroupSchema.parse({ workspaceId, agentId, workers });
    const file = this.getFilePath(workspaceId, agentId);
    await atomicWriteJson(file, group);
    this.emit("change", group);
  }

  public async updateWorker(
    workspaceId: string,
    agentId: string,
    workerId: string,
    patch: Partial<WorkerRecord>,
  ): Promise<WorkerRecord> {
    const workers = this.getWorkers(workspaceId, agentId);
    const index = workers.findIndex(worker => worker.id === workerId);
    const current = workers[index];
    if (!current) throw new WorkerError("WORKER_NOT_FOUND", `Worker with ID "${workerId}" not found`);
    const updated = WorkerRecordSchema.parse({ ...current, ...patch });
    workers[index] = updated;
    await this.saveWorkers(workspaceId, agentId, workers);
    return updated;
  }

  public getAllGroups(): WorkerGroup[] {
    return fs.readdirSync(this.storageDir)
      .filter(file => file.endsWith(".json"))
      .map(file => GroupSchema.parse(JSON.parse(fs.readFileSync(path.join(this.storageDir, file), "utf8"))));
  }
}
