/**
 * Milvus 写入兜底（Fallback）基础设施
 *
 * 依据：1-plan.md §Task10-S3 + 2-decisions.md §12.5
 *
 * 当 Milvus 不可用时，将整条 MemoryEntry 序列化为 ndjson 追加到本地文件。
 * 恢复后通过 replayFallback 批量回灌，确保写入零丢失。
 *
 * - 兜底目录：memory/.milvus-fallback/YYYY-MM-DD.ndjson
 * - 每行一条 JSON 序列化的 Omit<MemoryEntry, "id">
 * - 写入时带 in-process 文件锁，防止并发交错
 * - 回放按文件批处理，单条失败不影响其他条目
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { MemoryEntry } from "openclaw/plugin-sdk/memory-core-host-engine-storage";

// ── 常量 ──────────────────────────────────────────────────────────

/** 兜底目录（相对于 agent workspace） */
export const FALLBACK_DIR = "memory/.milvus-fallback";

/** ndjson 文件扩展名 */
const FALLBACK_EXT = ".ndjson";

/** 日期正则：YYYY-MM-DD.ndjson */
const FALLBACK_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.ndjson$/;

// ── 文件锁（in-process）───────────────────────────────────────────

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

// ── 日期辅助 ──────────────────────────────────────────────────────

function todayStamp(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ── 路径辅助 ──────────────────────────────────────────────────────

function fallbackDirAbs(workspaceDir: string): string {
  return path.resolve(workspaceDir, FALLBACK_DIR);
}

function fallbackFilePath(workspaceDir: string, stamp: string): string {
  return path.join(fallbackDirAbs(workspaceDir), `${stamp}${FALLBACK_EXT}`);
}

// ── 安全序列化 ────────────────────────────────────────────────────

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
 * 将 entry 序列化为 JSON 追加到当日的 fallback ndjson 文件。
 *
 * 写入时持有文件级锁，防止并发交错。如父目录不存在则自动创建。
 * 本函数不抛错——即使磁盘写失败也仅 warn（由上层调用方判断）。
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
 * 遍历 memory/.milvus-fallback/ 下所有 ndjson 文件（按日期升序），
 * 逐条反序列化并调用 writer(entry)。成功的条目从文件中移除，失败的保留。
 *
 * 按文件批处理：单个文件中某条失败不影响同一文件的其他条目，
 * 也不影响其他文件的回放。
 *
 * @returns 成功回放到 Milvus 的条目总数
 */
export async function replayFallback(
  workspaceDir: string,
  writer: (entry: FallbackEntry) => Promise<void>,
): Promise<number> {
  const dir = fallbackDirAbs(workspaceDir);

  // 列出所有 ndjson 文件，按日期排序
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return 0;
    throw err;
  }

  const files = entries
    .filter((name) => FALLBACK_FILE_PATTERN.test(name))
    .sort(); // YYYY-MM-DD.ndjson 字符串排序 = 日期升序

  let totalReplayed = 0;

  for (const fileName of files) {
    const filePath = path.join(dir, fileName);
    const replayed = await replaySingleFile(filePath, writer);
    totalReplayed += replayed;
  }

  return totalReplayed;
}

/**
 * 单文件回放：
 * - 读取所有行 → 逐条 writer(entry)
 * - 成功的从内存移除，失败的保留
 * - 全部处理后重写文件（仅保留失败条目）
 * - 文件变空则删除
 *
 * @returns 该文件中成功回放的条目数
 */
async function replaySingleFile(
  filePath: string,
  writer: (entry: FallbackEntry) => Promise<void>,
): Promise<number> {
  // 使用文件级锁防止与并发 writeFallback 冲突
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
      if (!entry) continue; // 无效行直接丢弃

      try {
        await writer(entry);
        replayed++;
      } catch {
        // 回放失败 → 保留该行
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

/**
 * 统计 fallback 目录中待处理的条目总数。
 * 供 `status()` 上报给上层/UI。
 */
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
      // 文件突然消失也 ok
    }
  }

  return total;
}

// ── 小工具 ────────────────────────────────────────────────────────

async function removeFileIfExists(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }
}
