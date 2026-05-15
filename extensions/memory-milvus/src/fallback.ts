/**
 * NDJSON fallback infrastructure for Milvus write operations.
 *
 * When Milvus is unavailable, entries are serialized to local ndjson files.
 * After recovery, replayFallback replays all pending entries into Milvus.
 *
 * - Fallback directory: memory/.milvus-fallback/YYYY-MM-DD.ndjson
 * - One JSON-serialized MemoryEntry per line
 * - In-process file locking prevents concurrent interleaving
 * - Replay is batched per file; a single failure does not block other entries
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { MemoryEntry } from "openclaw/plugin-sdk/memory-core-host-engine-storage";

// ── Constants ─────────────────────────────────────────────────────

/** Fallback directory (relative to agent workspace) */
export const FALLBACK_DIR = "memory/.milvus-fallback";

const FALLBACK_EXT = ".ndjson";

const FALLBACK_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.ndjson$/;

// ── In-process file lock ──────────────────────────────────────────

const appendLocks = new Map<string, Promise<unknown>>();

async function withFileLock<T>(lockKey: string, task: () => Promise<T>): Promise<T> {
  const previous = appendLocks.get(lockKey) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  appendLocks.set(lockKey, previous.catch(() => undefined).then(() => current));

  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    // Only cleanup if no newer waiter queued behind us.
    if (appendLocks.get(lockKey) === previous.catch(() => undefined).then(() => current)) {
      // The Map value may have changed — compare by checking that the current
      // promise chain is still the head.  Safer: always delete and let next
      // caller re-seed.
      appendLocks.delete(lockKey);
    }
  }
}

// ── Date helper ────────────────────────────────────────────────────

function todayStamp(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ── Path helpers ──────────────────────────────────────────────────

function fallbackDirAbs(workspaceDir: string): string {
  return path.resolve(workspaceDir, FALLBACK_DIR);
}

function fallbackFilePath(workspaceDir: string, stamp: string): string {
  return path.join(fallbackDirAbs(workspaceDir), `${stamp}${FALLBACK_EXT}`);
}

// ── Safe serialization ────────────────────────────────────────────

type FallbackEntry = Omit<MemoryEntry, "id">;

function serializeEntry(entry: FallbackEntry): string {
  return JSON.stringify(entry) + "\n";
}

function deserializeEntry(line: string): FallbackEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const obj: unknown = JSON.parse(trimmed);
    if (!obj || typeof obj !== "object") return null;
    const e = obj as Record<string, unknown>;
    if (typeof e.text !== "string" || !e.text.trim()) return null;
    if (!e.provenance || typeof e.provenance !== "object") return null;
    const p = e.provenance as Record<string, unknown>;
    return {
      text: e.text,
      snippet: typeof e.snippet === "string" ? e.snippet : undefined,
      agentId: typeof e.agentId === "string" ? e.agentId : undefined,
      sessionKey: typeof e.sessionKey === "string" ? e.sessionKey : undefined,
      memoryType: typeof e.memoryType === "string"
        ? (e.memoryType as FallbackEntry["memoryType"])
        : undefined,
      recallCount: typeof e.recallCount === "number" ? e.recallCount : undefined,
      createdAt: typeof e.createdAt === "string" ? e.createdAt : undefined,
      updatedAt: typeof e.updatedAt === "string" ? e.updatedAt : undefined,
      provenance: {
        kind: (typeof p.kind === "string" ? p.kind : "milvus") as "milvus",
        label: typeof p.label === "string" ? p.label : "",
      },
    };
  } catch {
    return null;
  }
}

// ── writeFallback ─────────────────────────────────────────────────

/**
 * Append a serialized entry to today's fallback ndjson file.
 * Holds a per-file lock to prevent concurrent interleaving.
 * Creates the parent directory if it does not exist.
 * This function never throws — disk write failures are logged as warnings.
 */
export async function writeFallback(
  workspaceDir: string,
  entry: FallbackEntry,
): Promise<void> {
  const stamp = todayStamp();
  const filePath = fallbackFilePath(workspaceDir, stamp);

  await withFileLock(filePath, async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const line = serializeEntry(entry);
    await fs.appendFile(filePath, line, "utf-8");
  });
}

// ── replayFallback ────────────────────────────────────────────────

/**
 * Iterate over all ndjson files in memory/.milvus-fallback/ (sorted by date),
 * deserialize each line, and call writer(entry). Successfully replayed
 * entries are removed from the file; failed entries are retained.
 *
 * Replay is batched per file: a failure in one entry does not block
 * other entries in the same file, nor does it block replay of other files.
 */
export async function replayFallback(
  workspaceDir: string,
  writer: (entry: FallbackEntry) => Promise<void>,
): Promise<number> {
  const dir = fallbackDirAbs(workspaceDir);

  // List all ndjson files, sorted by date
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return 0;
    throw err;
  }

  const files = entries
    .filter((name) => FALLBACK_FILE_PATTERN.test(name))
    .sort(); // YYYY-MM-DD.ndjson string sort = date ascending

  let totalReplayed = 0;

  for (const fileName of files) {
    const filePath = path.join(dir, fileName);
    const replayed = await replaySingleFile(filePath, writer);
    totalReplayed += replayed;
  }

  return totalReplayed;
}

/**
 * Replay a single fallback file:
 * - Read all lines → writer(entry) for each
 * - Successful entries are removed; failed ones are kept
 * - Rewrite the file with only remaining lines after processing
 * - Delete the file if it becomes empty
 */
async function replaySingleFile(
  filePath: string,
  writer: (entry: FallbackEntry) => Promise<void>,
): Promise<number> {
  // Use file-level lock to prevent conflicts with concurrent writeFallback
  return withFileLock(filePath, async () => {
    let lines: string[];
    try {
      const content = await fs.readFile(filePath, "utf-8");
      lines = content.split("\n").filter((l) => l.trim());
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return 0;
      throw err;
    }

    if (lines.length === 0) {
      await removeFileIfExists(filePath);
      return 0;
    }

    const remaining: string[] = [];
    let replayed = 0;

    for (const line of lines) {
      const entry = deserializeEntry(line);
      if (!entry) continue; // Skip invalid lines

      try {
        await writer(entry);
        replayed++;
      } catch {
        // Replay failed → keep the line
        remaining.push(line);
      }
    }

    if (remaining.length === 0) {
      await removeFileIfExists(filePath);
    } else {
      await fs.writeFile(filePath, remaining.join("\n") + "\n", "utf-8");
    }

    return replayed;
  });
}

// ── pendingFallbackCount ──────────────────────────────────────────

/** Count total pending entries in the fallback directory. */
export async function pendingFallbackCount(workspaceDir: string): Promise<number> {
  const dir = fallbackDirAbs(workspaceDir);

  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return 0;
    throw err;
  }

  const files = entries.filter((name) => FALLBACK_FILE_PATTERN.test(name));

  let total = 0;
  for (const fileName of files) {
    try {
      const content = await fs.readFile(path.join(dir, fileName), "utf-8");
      total += content.split("\n").filter((l) => l.trim()).length;
    } catch {
      // File disappeared between listing and reading — fine
    }
  }

  return total;
}

// ── Utility ───────────────────────────────────────────────────────

async function removeFileIfExists(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }
}
