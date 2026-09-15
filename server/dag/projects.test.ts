import { describe, expect, it } from "vitest";
import type { SessionHeader } from "../provider/omo-store.js";
import { groupProjects } from "./projects.js";

const header = (cwd: string, updatedAt: string, id = `${cwd}-${updatedAt}`): SessionHeader => ({
  id,
  cwd,
  createdAt: updatedAt,
  updatedAt,
  child: false,
  file: `${cwd}/${id}.jsonl`,
});

describe("groupProjects", () => {
  it("orders projects by their most recent session, not by walk order", () => {
    const projects = groupProjects([
      header("E:/DEV/old", "2026-01-01T00:00:00.000Z"),
      header("E:/DEV/current", "2026-09-01T00:00:00.000Z"),
      header("E:/DEV/current", "2026-09-15T00:00:00.000Z"),
    ]);

    expect(projects.map((project) => project.cwd)).toEqual(["E:/DEV/current", "E:/DEV/old"]);
    expect(projects[0]?.updatedAt).toBe("2026-09-15T00:00:00.000Z");
    expect(projects[0]?.sessionCount).toBe(2);
  });

  it("drops headers with no usable cwd instead of offering a blank shortcut", () => {
    const projects = groupProjects([header("   ", "2026-09-15T00:00:00.000Z"), header("E:/DEV/real", "2026-09-14T00:00:00.000Z")]);

    expect(projects.map((project) => project.cwd)).toEqual(["E:/DEV/real"]);
  });

  it("caps the list so the surface stays a shortcut rather than a directory listing", () => {
    const many = Array.from({ length: 30 }, (_, index) =>
      header(`E:/DEV/p${index}`, `2026-09-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`),
    );

    expect(groupProjects(many, 5)).toHaveLength(5);
  });
});
