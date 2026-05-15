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

/** Create a temporary workspace directory */
async function tempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "milvus-fallback-"));
  return dir;
}

/** Read all ndjson lines from the fallback directory */
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

// ── Scenario 1: Write → replay success → file cleared ────────────

describe("writeFallback + replayFallback: success path", () => {
  it("writes 3 entries → all replayed successfully → file cleared → count 0", async () => {
    const ws = await tempWorkspace();

    const e1 = makeEntry({ text: "memory A" });
    const e2 = makeEntry({ text: "memory B" });
    const e3 = makeEntry({ text: "memory C" });

    // Write 3 entries
    await writeFallback(ws, e1);
    await writeFallback(ws, e2);
    await writeFallback(ws, e3);

    // Confirm 3 entries are in fallback
    expect(await pendingFallbackCount(ws)).toBe(3);

    // Replay: all succeed
    const replayed: TestEntry[] = [];
    const count = await replayFallback(ws, async (entry) => {
      replayed.push(entry);
    });

    expect(count).toBe(3);
    expect(replayed).toHaveLength(3);
    expect(replayed[0]!.text).toBe("memory A");
    expect(replayed[1]!.text).toBe("memory B");
    expect(replayed[2]!.text).toBe("memory C");

    // File should be deleted (empty file cleanup)
    expect(await pendingFallbackCount(ws)).toBe(0);
    expect(await readAllFallbackLines(ws)).toHaveLength(0);

    // Cleanup
    await fs.rm(ws, { recursive: true, force: true });
  });
});

// ── Scenario 2: Write → replay partial failure → failed entries kept ──

describe("writeFallback + replayFallback: partial failure", () => {
  it("writes 4 entries → 2nd replay fails → only 2nd retained in file", async () => {
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

    // 3 succeeded, 1 failed
    expect(count).toBe(3);
    expect(callCount).toBe(4);
    expect(replayed).toHaveLength(3);

    // Failed entry retained
    expect(await pendingFallbackCount(ws)).toBe(1);
    const remaining = await readAllFallbackLines(ws);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toContain("memory B - will fail");

    // Second round: all succeed this time
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

// ── Scenario 3: Empty directory does not throw ────────────────────

describe("fallback: empty directory", () => {
  it("replayFallback returns 0 when no fallback files exist", async () => {
    const ws = await tempWorkspace();
    const count = await replayFallback(ws, async () => {
      throw new Error("should not be called");
    });
    expect(count).toBe(0);
    await fs.rm(ws, { recursive: true, force: true });
  });

  it("pendingFallbackCount returns 0 when no fallback files exist", async () => {
    const ws = await tempWorkspace();
    expect(await pendingFallbackCount(ws)).toBe(0);
    await fs.rm(ws, { recursive: true, force: true });
  });
});

// ── Scenario 4: Concurrent writes do not interleave ──────────────

describe("writeFallback: concurrency safety", () => {
  it("10 concurrent writes, all entries readable correctly", async () => {
    const ws = await tempWorkspace();

    const entries = Array.from({ length: 10 }, (_, i) =>
      makeEntry({ text: `concurrent entry ${i}` }),
    );

    await Promise.all(entries.map((e) => writeFallback(ws, e)));

    expect(await pendingFallbackCount(ws)).toBe(10);

    // Replay all
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

// ── Scenario 5: Invalid JSON lines skipped ───────────────────────

describe("replayFallback: dirty data tolerance", () => {
  it("invalid JSON lines discarded during replay, not retained", async () => {
    const ws = await tempWorkspace();
    const dir = path.join(ws, FALLBACK_DIR);
    await fs.mkdir(dir, { recursive: true });

    // Manually write a file containing invalid lines
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

    // Only 2 valid
    expect(count).toBe(2);
    expect(replayed).toEqual(["valid A", "valid B"]);

    // Invalid lines discarded, file deleted because all processed successfully
    expect(await pendingFallbackCount(ws)).toBe(0);

    await fs.rm(ws, { recursive: true, force: true });
  });
});

// ── Scenario 6: Metadata field fidelity ──────────────────────────

describe("writeFallback + replayFallback: metadata fidelity", () => {
  it("all entry fields identical after write → replay roundtrip", async () => {
    const ws = await tempWorkspace();

    const original = makeEntry({
      text: "Detailed memory content\nsecond line",
      snippet: "Detailed memory...",
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
