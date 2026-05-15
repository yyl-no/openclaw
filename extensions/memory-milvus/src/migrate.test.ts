/**
 * Unit tests for migrate.ts
 *
 * Strategy: 1-plan.md §Task14
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

// ── Helpers ──────────────────────────────────────────────────────

async function makeTempDir(files?: Record<string, string>): Promise<[string, () => Promise<void>]> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mm-migrate-"));
  if (files) {
    for (const [relPath, content] of Object.entries(files)) {
      const fullPath = path.join(dir, relPath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content, "utf-8");
    }
  }
  return [dir, async () => { await fs.rm(dir, { recursive: true, force: true }); }];
}

// ── Tests: scanMemoryFiles ────────────────────────────────────────

describe("scanMemoryFiles", () => {
  it("finds MEMORY.md and memory/*.md files", async () => {
    const [dir, cleanup] = await makeTempDir({
      "MEMORY.md": "# Memories\n\n- This is a sufficiently long item for memory migration\n",
      "memory/2026-05-01.md": "## 2026-05-01\n\n- This entry is long enough to be chunked\n",
      "memory/2026-05-02.md": "## 2026-05-02\n\n- Another entry that passes the min char threshold\n",
      "other/notes.md": "should be ignored",
    });
    try {
      const { migrateMarkdownToMilvus } = await import("./migrate.js");

      const mockClient = {
        query: vi.fn().mockResolvedValue({ data: [] }),
        insert: vi.fn().mockResolvedValue({ IDs: { int_id: { data: [1] } } }),
        describeCollection: vi.fn().mockResolvedValue({}),
      };
      const mockManager = {
        write: vi.fn().mockResolvedValue({ id: "1", snippet: "", score: 0, provenance: { kind: "milvus", label: "" } }),
        close: vi.fn().mockResolvedValue(undefined),
      };

      const result = await migrateMarkdownToMilvus(
        mockManager as any,
        mockClient as any,
        "test_collection",
        dir,
        { dryRun: true },
      );

      expect(result.files).toBe(3);
      expect(result.inserted).toBeGreaterThan(0);
      expect(mockManager.write).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  it("returns zero files for empty directory", async () => {
    const [dir, cleanup] = await makeTempDir({ "other.txt": "not md" });
    try {
      const { migrateMarkdownToMilvus } = await import("./migrate.js");
      const mockClient = { query: vi.fn().mockResolvedValue({ data: [] }) };
      const mockManager = { write: vi.fn(), close: vi.fn() };

      const result = await migrateMarkdownToMilvus(
        mockManager as any, mockClient as any, "test_collection", dir,
      );
      expect(result.files).toBe(0);
      expect(result.inserted).toBe(0);
    } finally {
      await cleanup();
    }
  });
});

// ── Tests: migrateMarkdownToMilvus ────────────────────────────────

describe("migrateMarkdownToMilvus", () => {
  let dir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    [dir, cleanup] = await makeTempDir({
      "MEMORY.md": [
        "# Memories", "",
        "## Preferences",
        "- Prefer dark mode",
        "- Use TypeScript", "",
        "## Decisions",
        "- Use Milvus for storage", "",
      ].join("\n"),
      "memory/2026-05-01.md": [
        "## 2026-05-01", "",
        "### Morning",
        "- Fixed login bug",
        "- Deployed v1.2.3", "",
      ].join("\n"),
    });
  });

  afterEach(async () => { await cleanup(); });

  it("dry-run counts but does not write", async () => {
    const { migrateMarkdownToMilvus } = await import("./migrate.js");
    const mockClient = { query: vi.fn().mockResolvedValue({ data: [] }) };
    const mockMgr = {
      write: vi.fn().mockResolvedValue({ id: "1", snippet: "", score: 0, provenance: { kind: "file", label: "" } }),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const result = await migrateMarkdownToMilvus(
      mockMgr as any, mockClient as any, "c", dir, { dryRun: true },
    );

    expect(result.files).toBe(2);
    expect(result.inserted).toBeGreaterThan(0);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(mockMgr.write).not.toHaveBeenCalled();
  });

  it("forward migration writes chunks to manager", async () => {
    const { migrateMarkdownToMilvus } = await import("./migrate.js");
    const mockClient = { query: vi.fn().mockResolvedValue({ data: [] }) };
    const mockMgr = {
      write: vi.fn().mockResolvedValue({ id: "1", snippet: "", score: 0, provenance: { kind: "file", label: "" } }),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const result = await migrateMarkdownToMilvus(
      mockMgr as any, mockClient as any, "c", dir,
    );

    expect(result.files).toBe(2);
    expect(result.inserted).toBeGreaterThan(0);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(mockMgr.write).toHaveBeenCalled();

    for (const call of mockMgr.write.mock.calls) {
      expect(call[0].provenance.kind).toBe("file");
      expect(call[0].memoryType).toBe("short_term");
    }
  });

  it("same content in different sections has unique provenance labels (no false dedup)", async () => {
    const [dupDir, dupCleanup] = await makeTempDir({
      "MEMORY.md": [
        "# Mem", "",
        "## Same Section", "- Same content here that is long enough", "",
        "## Same Section", "- Same content here that is long enough", "",
      ].join("\n"),
    });
    try {
      const { migrateMarkdownToMilvus } = await import("./migrate.js");
      const mockClient = { query: vi.fn().mockResolvedValue({ data: [] }) };
      const mockMgr = {
        write: vi.fn().mockResolvedValue({ id: "1", snippet: "", score: 0, provenance: { kind: "file", label: "" } }),
        close: vi.fn().mockResolvedValue(undefined),
      };

      const result = await migrateMarkdownToMilvus(
        mockMgr as any, mockClient as any, "c", dupDir,
      );
      // Same text but different line ranges = different provenance_labels = both get inserted
      expect(result.inserted).toBe(2);
      expect(result.skipped).toBe(0);
    } finally {
      await dupCleanup();
    }
  });

  it("cross-batch dedup queries Milvus for existing provenance_label", async () => {
    const { migrateMarkdownToMilvus } = await import("./migrate.js");
    const mockClient = {
      query: vi.fn().mockResolvedValue({ data: [{ id: "42" }] }),
    };
    const mockMgr = {
      write: vi.fn().mockResolvedValue({ id: "1", snippet: "", score: 0, provenance: { kind: "file", label: "" } }),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const result = await migrateMarkdownToMilvus(
      mockMgr as any, mockClient as any, "c", dir,
    );
    expect(result.skipped).toBeGreaterThan(0);
    expect(mockClient.query).toHaveBeenCalled();
  });

  it("handles write failure gracefully", async () => {
    const { migrateMarkdownToMilvus } = await import("./migrate.js");
    const mockClient = { query: vi.fn().mockResolvedValue({ data: [] }) };
    const mockMgr = {
      write: vi.fn().mockRejectedValue(new Error("write failed")),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const result = await migrateMarkdownToMilvus(
      mockMgr as any, mockClient as any, "c", dir,
    );
    expect(result.failed).toBeGreaterThan(0);
    expect(result.inserted).toBe(0);
  });
});

// ── Tests: migrateMilvusToMarkdown ────────────────────────────────

describe("migrateMilvusToMarkdown", () => {
  let outputDir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    [outputDir, cleanup] = await makeTempDir();
  });

  afterEach(async () => { await cleanup(); });

  it("exports entries grouped by date and memory_type", async () => {
    const { migrateMilvusToMarkdown } = await import("./migrate.js");
    const mockClient = {
      query: vi.fn()
        .mockResolvedValueOnce({
          data: [
            {
              id: "1", text: "Prefer dark mode", snippet: "s", agent_id: "a",
              memory_type: "long_term", provenance_kind: "milvus", provenance_label: "x",
              created_at: "2026-05-13T10:00:00.000Z", updated_at: "2026-05-13T10:00:00.000Z",
            },
            {
              id: "2", text: "Fixed login bug", snippet: "s", agent_id: "a",
              memory_type: "short_term", provenance_kind: "milvus", provenance_label: "x",
              created_at: "2026-05-13T10:00:00.000Z", updated_at: "2026-05-13T10:00:00.000Z",
            },
          ],
        })
        .mockResolvedValueOnce({ data: [] }),
    };

    const result = await migrateMilvusToMarkdown(
      mockClient as any, "test_collection", outputDir,
    );

    expect(result.inserted).toBe(2);
    expect(result.files).toBeGreaterThanOrEqual(1);

    const memFile = path.join(outputDir, "MEMORY.md");
    const memContent = await fs.readFile(memFile, "utf-8").catch(() => null);
    expect(memContent).toBeTruthy();
    expect(memContent).toContain("Prefer dark mode");

    const dailyFile = path.join(outputDir, "memory", "2026-05-13.md");
    const dailyContent = await fs.readFile(dailyFile, "utf-8").catch(() => null);
    expect(dailyContent).toBeTruthy();
    expect(dailyContent).toContain("Fixed login bug");
  });

  it("respects type filter", async () => {
    const { migrateMilvusToMarkdown } = await import("./migrate.js");
    const mockClient = {
      query: vi.fn()
        .mockResolvedValueOnce({
          data: [{
            id: "1", text: "Long-term memory", memory_type: "long_term",
            provenance_kind: "milvus", provenance_label: "", created_at: "2026-05-13T10:00:00.000Z",
          }],
        })
        .mockResolvedValueOnce({ data: [] }),
    };

    const result = await migrateMilvusToMarkdown(
      mockClient as any, "test_collection", outputDir, { type: "long_term" },
    );
    expect(result.inserted).toBe(1);
  });

  it("handles empty collection gracefully", async () => {
    const { migrateMilvusToMarkdown } = await import("./migrate.js");
    const mockClient = { query: vi.fn().mockResolvedValue({ data: [] }) };

    const result = await migrateMilvusToMarkdown(
      mockClient as any, "test_collection", outputDir,
    );
    expect(result.inserted).toBe(0);
    expect(result.files).toBe(0);
  });
});
