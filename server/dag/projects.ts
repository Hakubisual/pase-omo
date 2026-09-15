import type { DagProject } from "../../shared/dag.js";
import { readSessionHeaders, sessionsDir, type SessionHeader } from "../provider/omo-store.js";

/** More than this and the surface is a list to scroll, not a shortcut. */
const MAX_PROJECTS = 20;

/**
 * Groups OmO session headers into the projects they were run in.
 *
 * Pure so the grouping is testable without a session tree on disk: recency is
 * the only ordering that matters, because the project a user wants is nearly
 * always the one they just worked in.
 */
export function groupProjects(headers: readonly SessionHeader[], limit = MAX_PROJECTS): DagProject[] {
  const byCwd = new Map<string, { cwd: string; sessionCount: number; updatedAt: string }>();

  for (const header of headers) {
    const cwd = header.cwd.trim();
    if (!cwd) continue;
    const existing = byCwd.get(cwd);
    if (existing === undefined) {
      byCwd.set(cwd, { cwd, sessionCount: 1, updatedAt: header.updatedAt });
      continue;
    }
    existing.sessionCount += 1;
    // The project's recency is its newest session, not whichever header the
    // directory walk happened to reach last.
    if (header.updatedAt > existing.updatedAt) existing.updatedAt = header.updatedAt;
  }

  return [...byCwd.values()]
    .sort((left, right) => (left.updatedAt < right.updatedAt ? 1 : left.updatedAt > right.updatedAt ? -1 : 0))
    .slice(0, limit);
}

export async function listProjects(): Promise<{ projects: DagProject[] }> {
  const headers = await readSessionHeaders(sessionsDir());
  return { projects: groupProjects(headers) };
}
