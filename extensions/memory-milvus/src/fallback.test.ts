import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { MemoryEntry } from "openclaw/plugin-sdk/memory-core-host-engine-storage";

import {
  FALLBACK_DIR,
  pendingFallbackCount,
  replayFallback,
  writeFallback,
} from "./fallback.js";

// ── Helpers ───────────────────────────────────────────────────────

type TestEntry = Omit<MemoryEntry, "id">;

function makeEntry(overrides: Partial<TestEntry> = {}): TestEntry {
  return {
    text: "Test memory content",
    snippet: "Test memory...",
    agentId: "agent-1",
    sessionKey: "session-abc",
    memoryType: "short_term",
    recallCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    provenance: { kind: "milvus", label: "chat_extract" },
    ...overrides,
  };
}

/** 创建临时 workspace 目录 */
async function tempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "milvus-fallback-"));
  return dir;
}

/** 读取 fallback 目录下的所有 ndjson 行 */
async function readAllFallbackLines(workspaceDir: string): Promise<string[]> {
  const dir = path.join(workspaceDir, FALLBACK_DIR);
  try {
    const files = await fs.readdir(dir);
    const ndjsonFiles = files.filter((f) => f.endsWith(".ndjson")).sort();
    const lines: string[] = [];
    for (const f of ndjsonFiles) {
      const content = await fs.readFile(path.join(dir, f), "utf-8");
      lines.push(...content.split("\n").filter((l) => l.trim()));
    }
    return lines;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw err;
  }
}

// ── 场景 1: 写入 → 回放成功 → 文件清空 ─────────────────────────────

describe("writeFallback + replayFallback: 成功路径", () => {
  it("写入 3 条 entry → 回放全部成功 → 文件清空 → count 归零", async () => {
    const ws = await tempWorkspace();

    const e1 = makeEntry({ text: "memory A" });
    const e2 = makeEntry({ text: "memory B" });
    const e3 = makeEntry({ text: "memory C" });

    // 写入 3 条
    await writeFallback(ws, e1);
    await writeFallback(ws, e2);
    await writeFallback(ws, e3);

    // 确认 3 条在 fallback 中
    expect(await pendingFallbackCount(ws)).toBe(3);

    // 回放：全部成功
    const replayed: TestEntry[] = [];
    const count = await replayFallback(ws, async (entry) => {
      replayed.push(entry);
    });

    expect(count).toBe(3);
    expect(replayed).toHaveLength(3);
    expect(replayed[0]!.text).toBe("memory A");
    expect(replayed[1]!.text).toBe("memory B");
    expect(replayed[2]!.text).toBe("memory C");

    // 文件应被删除（空文件清理）
    expect(await pendingFallbackCount(ws)).toBe(0);
    expect(await readAllFallbackLines(ws)).toHaveLength(0);

    // 清理
    await fs.rm(ws, { recursive: true, force: true });
  });
});

// ── 场景 2: 写入 → 回放部分失败 → 失败条目保留 ─────────────────────

describe("writeFallback + replayFallback: 部分失败", () => {
  it("写入 4 条 → 第 2 条回放失败 → 仅第 2 条保留在文件中", async () => {
    const ws = await tempWorkspace();

    const e1 = makeEntry({ text: "memory A" });
    const e2 = makeEntry({ text: "memory B - will fail" });
    const e3 = makeEntry({ text: "memory C" });
    const e4 = makeEntry({ text: "memory D" });

    await writeFallback(ws, e1);
    await writeFallback(ws, e2);
    await writeFallback(ws, e3);
    await writeFallback(ws, e4);

    expect(await pendingFallbackCount(ws)).toBe(4);

    let callCount = 0;
    const replayed: TestEntry[] = [];
    const count = await replayFallback(ws, async (entry) => {
      callCount++;
      if (entry.text === "memory B - will fail") {
        throw new Error("simulated insert failure");
      }
      replayed.push(entry);
    });

    // 3 条成功，1 条失败
    expect(count).toBe(3);
    expect(callCount).toBe(4);
    expect(replayed).toHaveLength(3);

    // 失败条目保留
    expect(await pendingFallbackCount(ws)).toBe(1);
    const remaining = await readAllFallbackLines(ws);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toContain("memory B - will fail");

    // 第二轮回放：这次全部成功
    const round2: TestEntry[] = [];
    const count2 = await replayFallback(ws, async (entry) => {
      round2.push(entry);
    });
    expect(count2).toBe(1);
    expect(round2[0]!.text).toBe("memory B - will fail");
    expect(await pendingFallbackCount(ws)).toBe(0);

    await fs.rm(ws, { recursive: true, force: true });
  });
});

// ── 场景 3: 空目录不抛错 ──────────────────────────────────────────

describe("fallback: 空目录", () => {
  it("无 fallback 文件时 replayFallback 返回 0", async () => {
    const ws = await tempWorkspace();
    const count = await replayFallback(ws, async () => {
      throw new Error("should not be called");
    });
    expect(count).toBe(0);
    await fs.rm(ws, { recursive: true, force: true });
  });

  it("无 fallback 文件时 pendingFallbackCount 返回 0", async () => {
    const ws = await tempWorkspace();
    expect(await pendingFallbackCount(ws)).toBe(0);
    await fs.rm(ws, { recursive: true, force: true });
  });
});

// ── 场景 4: 并发写入不交错 ─────────────────────────────────────────

describe("writeFallback: 并发安全", () => {
  it("10 条并发写入后所有条目均可正确读取", async () => {
    const ws = await tempWorkspace();

    const entries = Array.from({ length: 10 }, (_, i) =>
      makeEntry({ text: `concurrent entry ${i}` }),
    );

    await Promise.all(entries.map((e) => writeFallback(ws, e)));

    expect(await pendingFallbackCount(ws)).toBe(10);

    // 回放全部
    const replayed: string[] = [];
    await replayFallback(ws, async (entry) => {
      replayed.push(entry.text);
    });

    expect(replayed).toHaveLength(10);
    for (let i = 0; i < 10; i++) {
      expect(replayed).toContain(`concurrent entry ${i}`);
    }

    await fs.rm(ws, { recursive: true, force: true });
  });
});

// ── 场景 5: 无效 JSON 行被跳过 ──────────────────────────────────

describe("replayFallback: 脏数据容忍", () => {
  it("无效 JSON 行在回放时被丢弃不再保留", async () => {
    const ws = await tempWorkspace();
    const dir = path.join(ws, FALLBACK_DIR);
    await fs.mkdir(dir, { recursive: true });

    // 手动写入包含无效行的文件
    const filePath = path.join(dir, "2026-05-13.ndjson");
    await fs.writeFile(
      filePath,
      [
        JSON.stringify(makeEntry({ text: "valid A" })),
        "not valid json {{{",
        JSON.stringify(makeEntry({ text: "valid B" })),
        "",
      ].join("\n") + "\n",
      "utf-8",
    );

    const replayed: string[] = [];
    const count = await replayFallback(ws, async (entry) => {
      replayed.push(entry.text);
    });

    // 仅 2 条有效
    expect(count).toBe(2);
    expect(replayed).toEqual(["valid A", "valid B"]);

    // 无效行已丢弃，文件应因全部处理成功而被删除
    expect(await pendingFallbackCount(ws)).toBe(0);

    await fs.rm(ws, { recursive: true, force: true });
  });
});

// ── 场景 6: 元数据字段保真 ────────────────────────────────────

describe("writeFallback + replayFallback: 元数据保真", () => {
  it("entry 的所有字段在写入 → 回放循环后完全一致", async () => {
    const ws = await tempWorkspace();

    const original = makeEntry({
      text: "详细记忆内容\n第二行",
      snippet: "详细记忆...",
      agentId: "agent-xyz",
      sessionKey: "sess-123",
      memoryType: "long_term",
      recallCount: 42,
      provenance: { kind: "milvus", label: "recall_promotion" },
    });

    await writeFallback(ws, original);

    let recovered: TestEntry | null = null;
    await replayFallback(ws, async (entry) => {
      recovered = entry;
    });

    expect(recovered).not.toBeNull();
    expect(recovered!.text).toBe(original.text);
    expect(recovered!.snippet).toBe(original.snippet);
    expect(recovered!.agentId).toBe(original.agentId);
    expect(recovered!.sessionKey).toBe(original.sessionKey);
    expect(recovered!.memoryType).toBe(original.memoryType);
    expect(recovered!.recallCount).toBe(original.recallCount);
    expect(recovered!.provenance).toEqual(original.provenance);

    await fs.rm(ws, { recursive: true, force: true });
  });
});
