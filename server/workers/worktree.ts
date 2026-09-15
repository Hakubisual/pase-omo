import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { WorkerError } from "../../shared/workers.js";

const execFileAsync = promisify(execFile);

export interface GitWorktreeEntry {
  path: string;
  head: string;
  branch?: string | undefined;
  bare?: boolean | undefined;
  detached?: boolean | undefined;
}

export interface CreateWorktreeOptions {
  repoRoot: string;
  targetPath: string;
  branch: string;
  baseRef?: string | undefined;
}

export async function execGit(
  args: readonly string[],
  cwd?: string,
): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync("git", [...args], {
      cwd,
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 60_000,
    });
    return {
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const message = "stderr" in error && typeof error.stderr === "string"
      ? error.stderr.trim() : error.message;
    throw new WorkerError("GIT_FAILED", `Git command failed [git ${args.join(" ")}]: ${message}`, { cause: error });
  }
}

export async function ensureGitRepository(targetDir: string): Promise<{ repoRoot: string }> {
  const resolved = path.resolve(targetDir);
  if (!fs.existsSync(resolved)) {
    throw new WorkerError("NOT_GIT_REPO", `Directory is not a git repository: ${targetDir}`);
  }

  try {
    const { stdout } = await execGit(["rev-parse", "--show-toplevel"], resolved);
    const repoRoot = path.resolve(stdout);
    return { repoRoot };
  } catch (error) {
    if (!(error instanceof WorkerError)) throw error;
    throw new WorkerError("NOT_GIT_REPO", `Directory is not a git repository: ${targetDir}`, { cause: error });
  }
}

export function sanitizeBranchName(raw: string): string {
  const sanitized = raw
    .trim()
    .replace(/[^a-zA-Z0-9._/-]/g, "-")
    .replace(/\/+/g, "/")
    .replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : `worker-${Date.now()}`;
}

export function resolveWorktreePath(repoRoot: string, workerId: string): string {
  const safeId = workerId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const root = path.resolve(repoRoot);
  const key = createHash("sha256").update(root).digest("hex").slice(0, 12);
  return path.join(path.dirname(root), ".paseo-worktrees", `${path.basename(root)}-${key}`, safeId);
}

export async function listWorktrees(repoRoot: string): Promise<GitWorktreeEntry[]> {
  await ensureGitRepository(repoRoot);
  const { stdout } = await execGit(["worktree", "list", "--porcelain"], repoRoot);
  const entries: GitWorktreeEntry[] = [];

  const blocks = stdout.split(/\n\s*\n/);
  for (const block of blocks) {
    if (!block.trim()) continue;
    const lines = block.trim().split("\n");
    let currentPath = "";
    let head = "";
    let branch: string | undefined = undefined;
    let bare = false;
    let detached = false;

    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        currentPath = path.resolve(line.slice("worktree ".length).trim());
      } else if (line.startsWith("HEAD ")) {
        head = line.slice("HEAD ".length).trim();
      } else if (line.startsWith("branch ")) {
        const branchRef = line.slice("branch ".length).trim();
        branch = branchRef.startsWith("refs/heads/")
          ? branchRef.slice("refs/heads/".length)
          : branchRef;
      } else if (line === "bare") {
        bare = true;
      } else if (line === "detached") {
        detached = true;
      }
    }

    if (currentPath) {
      entries.push({
        path: currentPath,
        head,
        branch,
        bare,
        detached,
      });
    }
  }

  return entries;
}

export async function createWorkerWorktree(
  options: CreateWorktreeOptions,
): Promise<{ path: string; branch: string }> {
  const { repoRoot } = await ensureGitRepository(options.repoRoot);
  const targetPath = path.resolve(options.targetPath);
  const branch = sanitizeBranchName(options.branch);
  const baseRef = options.baseRef || "HEAD";

  // Check if worktree directory already exists in git worktree list
  const existingWorktrees = await listWorktrees(repoRoot);
  const matched = existingWorktrees.find(
    (wt) => path.resolve(wt.path).toLowerCase() === targetPath.toLowerCase(),
  );

  if (matched) {
    // Worktree is already active, return existing
    return {
      path: matched.path,
      branch: matched.branch || branch,
    };
  }

  // Ensure parent directory of worktree exists
  const parentDir = path.dirname(targetPath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  // Check if branch already exists in repository
  let branchExists = false;
  try {
    await execGit(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repoRoot);
    branchExists = true;
  } catch (error) {
    if (!(error instanceof WorkerError) || !(error.cause instanceof Error) ||
        !("code" in error.cause) || error.cause.code !== 1) throw error;
  }

  if (branchExists) {
    // If branch exists, check out existing branch in new worktree
    await execGit(["worktree", "add", targetPath, branch], repoRoot);
  } else {
    // Create new branch at baseRef
    await execGit(["worktree", "add", "-b", branch, targetPath, baseRef], repoRoot);
  }

  return {
    path: targetPath,
    branch,
  };
}
