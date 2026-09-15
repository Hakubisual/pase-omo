import { expect, test } from "vitest";

import { emptySessionsCopy, localPathLabel } from "./dag";

/**
 * The global DAG surface opens with no project path chosen, so the "no sessions"
 * card used to render the literal text `경로 ""에 ...` — quoting a path the user
 * never typed and reading like a bug. An unset path is a prompt, not a result.
 */

test("an unset project path asks for one instead of quoting an empty path", () => {
  const copy = emptySessionsCopy("");

  expect(copy.description).not.toContain('""');
  expect(copy.description).not.toContain("경로 \"\"");
  // It has to say what to do next, not report an empty search.
  expect(copy.title).not.toBe("발견된 OmO 세션이 없습니다");
  expect(copy.title.length).toBeGreaterThan(0);
  expect(copy.description.length).toBeGreaterThan(0);
});

test("a path that really has no sessions uses a shortened daemon-local label", () => {
  const copy = emptySessionsCopy("E:/DEV/FREE");

  expect(copy.title).toBe("발견된 OmO 세션이 없습니다");
  expect(copy.description).toContain("…/DEV/FREE");
  expect(copy.description).not.toContain("E:/DEV/FREE");
});

test("a whitespace-only path counts as unset rather than as a real search", () => {
  expect(emptySessionsCopy("   ").title).toBe(emptySessionsCopy("").title);
});

test("daemon-local Windows and POSIX paths are shortened while ordinary labels are preserved", () => {
  expect(localPathLabel("C:\\Users\\daemon\\project")).toBe("…/daemon/project");
  expect(localPathLabel("/srv/paseo/worktrees/project")).toBe("…/worktrees/project");
  expect(localPathLabel("project-name")).toBe("project-name");
});
