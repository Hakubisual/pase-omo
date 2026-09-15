import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(temporary, file);
        break;
      } catch (error) {
        // A concurrent reader can briefly deny replacing an otherwise writable
        // file. Windows raises this as a sharing violation, and networked or
        // mounted POSIX filesystems report the same codes, so the retry is not
        // gated on the platform.
        if (!(error instanceof Error) ||
            !("code" in error) || !["EPERM", "EACCES", "EBUSY"].includes(String(error.code)) ||
            attempt === 5) throw error;
        await new Promise(resolve => setTimeout(resolve, 10 * 2 ** attempt));
      }
    }
  } catch (error) {
    try {
      await fs.rm(temporary, { force: true });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "State write and temporary-file cleanup failed");
    }
    throw error;
  }
}
