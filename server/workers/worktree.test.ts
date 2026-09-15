import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createWorkerWorktree,
  ensureGitRepository,
  execGit,
  listWorktrees,
  resolveWorktreePath,
  sanitizeBranchName,
} from "./worktree.js";

describe("Git worktree manager", () => {
  let tempDir: string;
  let repoDir: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-test-"));
    repoDir = path.join(tempDir, "repo");
    fs.mkdirSync(repoDir, { recursive: true });

    // Initialize real git repo
    await execGit(["init", "-b", "main"], repoDir);
    await execGit(["config", "user.name", "Paseo Tester"], repoDir);
    await execGit(["config", "user.email", "tester@paseo.dev"], repoDir);

    // Initial commit
    const readme = path.join(repoDir, "README.md");
    fs.writeFileSync(readme, "# Test Repo\n", "utf8");
    await execGit(["add", "README.md"], repoDir);
    await execGit(["commit", "-m", "Initial commit"], repoDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("ensures a directory is a valid git repository", async () => {
    const { repoRoot } = await ensureGitRepository(repoDir);
    expect(repoRoot.toLowerCase()).toBe(path.resolve(repoDir).toLowerCase());
  });

  it("explicitly rejects non-git repositories with clear error", async () => {
    const nonGitDir = path.join(tempDir, "non-git-folder");
    fs.mkdirSync(nonGitDir, { recursive: true });

    await expect(ensureGitRepository(nonGitDir)).rejects.toThrow(
      `Directory is not a git repository: ${nonGitDir}`,
    );
  });

  it("rejects a non-git workspace even when it contains a nested Git repository", async () => {
    await expect(ensureGitRepository(tempDir)).rejects.toThrow(
      `Directory is not a git repository: ${tempDir}`,
    );
  });

  it("places worker checkouts outside the source repository", () => {
    // Given a source checkout, when allocating a worker path, then indexing the
    // source cannot recursively discover copies of itself.
    const target = resolveWorktreePath(repoDir, "isolated-worker");
    expect(path.relative(repoDir, target).split(path.sep)[0]).toBe("..");
  });

  it("sanitizes branch names safely", () => {
    expect(sanitizeBranchName("feature/worker 1 #123")).toBe("feature/worker-1--123");
    expect(sanitizeBranchName("   worker-branch   ")).toBe("worker-branch");
  });

  it("creates an isolated git worktree with dedicated branch", async () => {
    const targetPath = resolveWorktreePath(repoDir, "worker-alpha");
    const result = await createWorkerWorktree({
      repoRoot: repoDir,
      targetPath,
      branch: "omo/worker-alpha",
    });

    expect(result.path.toLowerCase()).toBe(path.resolve(targetPath).toLowerCase());
    expect(result.branch).toBe("omo/worker-alpha");
    expect(fs.existsSync(targetPath)).toBe(true);

    const worktrees = await listWorktrees(repoDir);
    const found = worktrees.find(
      (wt) => path.resolve(wt.path).toLowerCase() === path.resolve(targetPath).toLowerCase(),
    );
    expect(found).toBeDefined();
    expect(found?.branch).toBe("omo/worker-alpha");
  });

  it("re-uses existing active worktree without deleting or failing", async () => {
    const targetPath = resolveWorktreePath(repoDir, "worker-beta");
    const first = await createWorkerWorktree({
      repoRoot: repoDir,
      targetPath,
      branch: "omo/worker-beta",
    });

    const second = await createWorkerWorktree({
      repoRoot: repoDir,
      targetPath,
      branch: "omo/worker-beta",
    });

    expect(second.path.toLowerCase()).toBe(first.path.toLowerCase());
    expect(second.branch).toBe("omo/worker-beta");
  });
});
