import { promises as fs } from "node:fs";
import path from "node:path";

import { formatDateStampInTimezone } from "../flush-plan.js";

/**
 * Public primitive for safely appending text to daily memory files
 * (`memory/YYYY-MM-DD.md`). Shared by `MemoryIndexManager.write()` (and any
 * future backend-level writer) so that path whitelisting, reserved-file
 * protection, append-only semantics, per-file locking, and line-range
 * reporting stay consistent with the existing flush-turn wrapper
 * (`wrapToolMemoryFlushAppendOnlyWrite` in src/agents/pi-tools.read.ts).
 */

const MEMORY_DAILY_PATH_PATTERN = /^memory\/\d{4}-\d{2}-\d{2}\.md$/;

/**
 * Workspace-root markdown files that must never be overwritten by automated
 * memory writers. Mirrors the read-only hint list published to AI flush turns
 * via flush-plan.ts::MEMORY_FLUSH_READ_ONLY_HINT.
 */
export const RESERVED_MEMORY_FILES: ReadonlySet<string> = new Set([
  "MEMORY.md",
  "AGENTS.md",
  "DREAMS.md",
  "SOUL.md",
  "TOOLS.md",
]);

export interface AppendMemoryFileSafeParams {
  /** Absolute workspace directory; used as the jail root for path resolution. */
  workspaceDir: string;
  /** POSIX-style path relative to workspaceDir, e.g. "memory/2026-05-12.md". */
  relativePath: string;
  /** Raw text to append. Must be non-empty after trimming. */
  text: string;
}

export interface AppendMemoryFileSafeResult {
  relativePath: string;
  /** 1-based line number of the first appended line. */
  startLine: number;
  /** 1-based inclusive line number of the last appended line. */
  endLine: number;
}

export interface ResolveDailyMemoryRelativePathParams {
  nowMs?: number;
  /**
   * IANA timezone identifier (e.g. "Asia/Shanghai"). Defaults to the host
   * Intl resolver when omitted.
   */
  timezone?: string;
}

/**
 * Build the canonical `memory/YYYY-MM-DD.md` relative path. Shares its date
 * formatter with `flush-plan.ts::buildMemoryFlushPlan` so the backend writer
 * and the AI flush-turn prompt always agree on the target file.
 */
export function resolveDailyMemoryRelativePath(
  params: ResolveDailyMemoryRelativePathParams = {},
): string {
  const nowMs = Number.isFinite(params.nowMs) ? (params.nowMs as number) : Date.now();
  const timezone =
    params.timezone && params.timezone.trim()
      ? params.timezone
      : Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const dateStamp = formatDateStampInTimezone(nowMs, timezone);
  return `memory/${dateStamp}.md`;
}

const inProcessAppendLocks = new Map<string, Promise<unknown>>();

async function withAppendLock<T>(lockKey: string, task: () => Promise<T>): Promise<T> {
  const previous = inProcessAppendLocks.get(lockKey) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const queued = previous.catch(() => undefined).then(() => current);
  inProcessAppendLocks.set(lockKey, queued);

  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    releaseCurrent();
    if (inProcessAppendLocks.get(lockKey) === queued) {
      inProcessAppendLocks.delete(lockKey);
    }
  }
}

function normalizeRelativePath(input: string): string {
  return input.replace(/\\/g, "/").replace(/^\.\//, "");
}

function assertRelativePathAllowed(relativePath: string): void {
  const normalized = normalizeRelativePath(relativePath);
  if (normalized !== relativePath) {
    throw new Error(
      `memory write rejected: relative path must use POSIX separators (got "${relativePath}")`,
    );
  }
  if (path.posix.isAbsolute(normalized) || normalized.includes("..")) {
    throw new Error(`memory write rejected: path escape attempt (got "${relativePath}")`);
  }
  const basename = path.posix.basename(normalized);
  if (RESERVED_MEMORY_FILES.has(basename)) {
    throw new Error(
      `memory write rejected: "${basename}" is a reserved workspace file and cannot be appended to automatically`,
    );
  }
  if (!MEMORY_DAILY_PATH_PATTERN.test(normalized)) {
    throw new Error(
      `memory write rejected: path "${relativePath}" does not match the canonical memory/YYYY-MM-DD.md pattern`,
    );
  }
}

async function readExistingContent(absolutePath: string): Promise<string> {
  try {
    return await fs.readFile(absolutePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

function countLogicalLines(text: string): number {
  if (text === "") return 0;
  const newlineCount = (text.match(/\n/g) ?? []).length;
  return text.endsWith("\n") ? newlineCount : newlineCount + 1;
}

/**
 * Append `text` to `workspaceDir/relativePath` with the following guarantees:
 *
 * - Path must match `memory/YYYY-MM-DD.md` and cannot target a reserved file.
 * - Existing file contents are preserved (append-only); never overwritten.
 * - Concurrent calls against the same absolute path are serialized
 *   in-process (no TOCTOU on line-range computation).
 * - Parent directories are created on demand.
 * - Returns the 1-based inclusive `[startLine, endLine]` range covering the
 *   appended content, suitable for encoding into a `MemoryReference.id` of
 *   the form `file:<relativePath>:<startLine>:<endLine>`.
 *
 * The function does not trigger index re-sync; callers that own a
 * `MemoryIndexManager` should mark the manager dirty (or rely on the
 * filesystem watcher) after a successful append.
 */
export async function appendMemoryFileSafe(
  params: AppendMemoryFileSafeParams,
): Promise<AppendMemoryFileSafeResult> {
  if (!params.workspaceDir || !path.isAbsolute(params.workspaceDir)) {
    throw new Error(
      `memory write rejected: workspaceDir must be an absolute path (got "${params.workspaceDir}")`,
    );
  }
  if (typeof params.text !== "string" || params.text.trim() === "") {
    throw new Error("memory write rejected: text must be a non-empty string");
  }

  const relativePath = normalizeRelativePath(params.relativePath);
  assertRelativePathAllowed(relativePath);

  const absolutePath = path.resolve(params.workspaceDir, relativePath);
  // Defence-in-depth: ensure the resolved path still sits under workspaceDir.
  const workspaceAbs = path.resolve(params.workspaceDir);
  if (
    !absolutePath.startsWith(workspaceAbs + path.sep) &&
    absolutePath !== workspaceAbs
  ) {
    throw new Error(`memory write rejected: resolved path escapes workspace (${absolutePath})`);
  }

  return withAppendLock(absolutePath, async () => {
    const existing = await readExistingContent(absolutePath);
    const existingLines = countLogicalLines(existing);

    const needsSeparator = existing.length > 0 && !existing.endsWith("\n");
    const separator = needsSeparator ? "\n" : "";

    const newContent = `${existing}${separator}${params.text}`;
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, newContent, "utf-8");

    const startLine = existingLines + 1;
    // Count logical lines contributed by params.text alone.
    const textTrimmedForCount = params.text.endsWith("\n")
      ? params.text.slice(0, -1)
      : params.text;
    const textLineCount = textTrimmedForCount === ""
      ? 1
      : (textTrimmedForCount.match(/\n/g) ?? []).length + 1;
    const endLine = startLine + textLineCount - 1;

    return { relativePath, startLine, endLine };
  });
}
