import { isAbsolute, join } from "node:path";
import { pathExists } from "./files.js";
import { ProcessError, runProcess } from "./process.js";

export interface GitOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly allowFailure?: boolean;
}

export type RemoteState = "empty" | "populated";

export async function git(
  args: readonly string[],
  options: GitOptions,
): Promise<string> {
  const result = await runProcess("git", args, {
    cwd: options.cwd,
    env: options.env,
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? 120_000,
    allowFailure: options.allowFailure,
  });
  return result.stdout.trim();
}

export async function cloneRepository(
  remote: string,
  target: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<void> {
  validateRemote(remote);
  await runProcess("git", ["clone", "--", remote, target], {
    env,
    signal,
    timeoutMs: 180_000,
  });
}

export async function probeRemote(
  remote: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<RemoteState> {
  validateRemote(remote);
  const result = await runProcess("git", ["ls-remote", "--", remote], {
    env,
    signal,
    timeoutMs: 120_000,
  });
  return result.stdout.trim() ? "populated" : "empty";
}

export async function initializeRepository(
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<void> {
  await git(["init", "-b", "main"], { cwd, env, signal });
}

export async function isGitRepository(options: GitOptions): Promise<boolean> {
  try {
    return (await git(["rev-parse", "--is-inside-work-tree"], options)) === "true";
  } catch {
    return false;
  }
}

export async function hasOrigin(options: GitOptions): Promise<boolean> {
  return (await originUrl(options)) !== undefined;
}

export async function originUrl(
  options: GitOptions,
): Promise<string | undefined> {
  try {
    return await git(["remote", "get-url", "origin"], options);
  } catch {
    return undefined;
  }
}

export async function addOrigin(
  remote: string,
  options: GitOptions,
): Promise<void> {
  validateRemote(remote);
  await git(["remote", "add", "origin", remote], options);
}

export async function setOrigin(
  remote: string,
  options: GitOptions,
): Promise<void> {
  validateRemote(remote);
  await git(["remote", "set-url", "origin", remote], options);
}

export async function currentBranch(
  options: GitOptions,
): Promise<string | undefined> {
  const value = await git(["branch", "--show-current"], options);
  return value || undefined;
}

export async function workingChanges(options: GitOptions): Promise<string[]> {
  const value = await git(["status", "--porcelain"], options);
  return value ? value.split("\n") : [];
}

export async function conflictedFiles(options: GitOptions): Promise<string[]> {
  const value = await git(["diff", "--name-only", "--diff-filter=U"], options);
  return value ? value.split("\n") : [];
}

export async function operationInProgress(
  options: GitOptions,
): Promise<boolean> {
  for (const marker of ["rebase-merge", "rebase-apply", "MERGE_HEAD"]) {
    const relative = await git(["rev-parse", "--git-path", marker], options);
    const markerPath = isAbsolute(relative)
      ? relative
      : join(options.cwd, relative);
    if (await pathExists(markerPath)) return true;
  }
  return false;
}

export async function fetchOrigin(options: GitOptions): Promise<void> {
  await git(["fetch", "--prune", "origin"], {
    ...options,
    timeoutMs: 180_000,
  });
}

export async function upstreamReference(
  options: GitOptions,
): Promise<string | undefined> {
  try {
    await git(["rev-parse", "--verify", "@{upstream}"], options);
    return "@{upstream}";
  } catch {
    const branch = await currentBranch(options);
    if (!branch) return undefined;
    try {
      await git(["rev-parse", "--verify", `origin/${branch}`], options);
      return `origin/${branch}`;
    } catch {
      return undefined;
    }
  }
}

export async function aheadBehind(
  reference: string,
  options: GitOptions,
): Promise<{ ahead: number; behind: number }> {
  const [ahead, behind] = await Promise.all([
    git(["rev-list", "--count", `${reference}..HEAD`], options),
    git(["rev-list", "--count", `HEAD..${reference}`], options),
  ]);
  return {
    ahead: Number.parseInt(ahead || "0", 10),
    behind: Number.parseInt(behind || "0", 10),
  };
}

export async function mergeBase(
  reference: string,
  options: GitOptions,
): Promise<string> {
  return await git(["merge-base", "HEAD", reference], options);
}

export async function readFileAtReference(
  reference: string,
  path: string,
  options: GitOptions,
): Promise<string | undefined> {
  try {
    const result = await runProcess(
      "git",
      ["show", `${reference}:${path}`],
      {
        cwd: options.cwd,
        env: options.env,
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? 120_000,
      },
    );
    return result.stdout;
  } catch (error) {
    if (error instanceof ProcessError && error.result.exitCode !== 0) {
      return undefined;
    }
    throw error;
  }
}

export async function stageAll(options: GitOptions): Promise<void> {
  await git(["add", "-A"], options);
}

export async function unstagePath(
  path: string,
  options: GitOptions,
): Promise<void> {
  await git(["reset", "--", path], { ...options, allowFailure: true });
}

export async function stagedFiles(options: GitOptions): Promise<string[]> {
  const value = await git(["diff", "--cached", "--name-only"], options);
  return value ? value.split("\n") : [];
}

export async function commit(
  message: string,
  options: GitOptions,
): Promise<boolean> {
  if ((await stagedFiles(options)).length === 0) return false;
  await git(["commit", "-m", message], options);
  return true;
}

export async function rebaseOnto(
  reference: string,
  options: GitOptions,
): Promise<void> {
  try {
    await git(["rebase", reference], { ...options, timeoutMs: 180_000 });
  } catch (error) {
    if (await operationInProgress(options)) {
      await git(["rebase", "--abort"], { ...options, allowFailure: true });
    }
    throw error;
  }
}

export async function push(options: GitOptions): Promise<void> {
  const branch = await currentBranch(options);
  if (!branch) throw new Error("Git is not on a named branch.");
  let hasUpstream = true;
  try {
    await git(["rev-parse", "--abbrev-ref", "@{upstream}"], options);
  } catch {
    hasUpstream = false;
  }
  if (!hasUpstream) {
    await git(["push", "-u", "origin", branch], {
      ...options,
      timeoutMs: 180_000,
    });
    return;
  }
  await git(["push"], { ...options, timeoutMs: 180_000 });
}

export function commitMessage(paths: readonly string[]): string {
  const onlySkills =
    paths.length > 0 && paths.every((path) => path.startsWith("skills/"));
  const onlyCodex =
    paths.length > 0 && paths.every((path) => path.startsWith("codex/"));
  if (onlySkills) return "chore: sync skills";
  if (onlyCodex) return "chore: sync Codex config";
  return "chore: sync CodexKeep";
}

function validateRemote(remote: string): void {
  if (!remote.trim() || remote.startsWith("-") || /[\r\n\0]/u.test(remote)) {
    throw new Error("The Git remote is invalid.");
  }
}
