import { describe, expect, it } from "vitest";

import {
  assertValidMemoryType,
  assertValidSourceLabel,
  MEMORY_SOURCE_LABELS,
  MEMORY_TYPES,
  type MilvusMemoryEntryMetadata,
  type MemorySourceLabel,
  type MemoryType,
} from "./types.js";

// ── MEMORY_SOURCE_LABELS constant value check ─────────────────────

describe("MEMORY_SOURCE_LABELS", () => {
  it("contains exactly four entries", () => {
    const values = Object.values(MEMORY_SOURCE_LABELS);
    expect(values).toHaveLength(4);
  });

  it("has CHAT_EXTRACT = 'chat_extract'", () => {
    expect(MEMORY_SOURCE_LABELS.CHAT_EXTRACT).toBe("chat_extract");
  });

  it("has USER_MANUAL = 'user_manual'", () => {
    expect(MEMORY_SOURCE_LABELS.USER_MANUAL).toBe("user_manual");
  });

  it("has RECALL_PROMOTION = 'recall_promotion'", () => {
    expect(MEMORY_SOURCE_LABELS.RECALL_PROMOTION).toBe("recall_promotion");
  });

  it("has IMPORT = 'import'", () => {
    expect(MEMORY_SOURCE_LABELS.IMPORT).toBe("import");
  });

  it("all values are unique", () => {
    const values = Object.values(MEMORY_SOURCE_LABELS);
    expect(new Set(values).size).toBe(values.length);
  });
});

// ── MEMORY_TYPES constant value check ────────────────────────────

describe("MEMORY_TYPES", () => {
  it("contains exactly three entries", () => {
    const values = Object.values(MEMORY_TYPES);
    expect(values).toHaveLength(3);
  });

  it("has SHORT_TERM = 'short_term'", () => {
    expect(MEMORY_TYPES.SHORT_TERM).toBe("short_term");
  });

  it("has LONG_TERM = 'long_term'", () => {
    expect(MEMORY_TYPES.LONG_TERM).toBe("long_term");
  });

  it("has ARCHIVED = 'archived'", () => {
    expect(MEMORY_TYPES.ARCHIVED).toBe("archived");
  });

  it("all values are unique", () => {
    const values = Object.values(MEMORY_TYPES);
    expect(new Set(values).size).toBe(values.length);
  });
});

// ── assertValidSourceLabel ───────────────────────────────────────

describe("assertValidSourceLabel", () => {
  it("passes for all known labels", () => {
    const labels = Object.values(MEMORY_SOURCE_LABELS);
    for (const label of labels) {
      expect(() => assertValidSourceLabel(label)).not.toThrow();
    }
  });

  it("narrows the type after passing", () => {
    const label: string = "chat_extract";
    assertValidSourceLabel(label);
    // Type-level: label is now MemorySourceLabel
    const typed: MemorySourceLabel = label;
    expect(typed).toBe("chat_extract");
  });

  it("throws for an unknown label", () => {
    expect(() => assertValidSourceLabel("garbage")).toThrow(
      'Invalid memory source label: "garbage"',
    );
  });

  it("throws for empty string", () => {
    expect(() => assertValidSourceLabel("")).toThrow(
      'Invalid memory source label: ""',
    );
  });

  it("throws for near-miss value", () => {
    expect(() => assertValidSourceLabel("Chat_extract")).toThrow(
      'Invalid memory source label: "Chat_extract"',
    );
  });

  it("error message lists all valid labels", () => {
    try {
      assertValidSourceLabel("bad");
    } catch (err) {
      const msg = String(err);
      expect(msg).toContain("chat_extract");
      expect(msg).toContain("user_manual");
      expect(msg).toContain("recall_promotion");
      expect(msg).toContain("import");
    }
  });
});

// ── assertValidMemoryType ────────────────────────────────────────

describe("assertValidMemoryType", () => {
  it("passes for all known types", () => {
    const types = Object.values(MEMORY_TYPES);
    for (const t of types) {
      expect(() => assertValidMemoryType(t)).not.toThrow();
    }
  });

  it("narrows the type after passing", () => {
    const t: string = "short_term";
    assertValidMemoryType(t);
    const typed: MemoryType = t;
    expect(typed).toBe("short_term");
  });

  it("throws for an unknown type", () => {
    expect(() => assertValidMemoryType("ephemeral")).toThrow(
      'Invalid memory type: "ephemeral"',
    );
  });

  it("throws for empty string", () => {
    expect(() => assertValidMemoryType("")).toThrow(
      'Invalid memory type: ""',
    );
  });

  it("throws for near-miss value", () => {
    expect(() => assertValidMemoryType("SHORT_TERM")).toThrow(
      'Invalid memory type: "SHORT_TERM"',
    );
  });

  it("error message lists all valid types", () => {
    try {
      assertValidMemoryType("bad");
    } catch (err) {
      const msg = String(err);
      expect(msg).toContain("short_term");
      expect(msg).toContain("long_term");
      expect(msg).toContain("archived");
    }
  });
});

// ── MilvusMemoryEntryMetadata type compatibility ─────────────────

describe("MilvusMemoryEntryMetadata", () => {
  it("accepts a minimal valid metadata object", () => {
    const meta: MilvusMemoryEntryMetadata = {
      agentId: "agent-1",
      memoryType: "short_term",
      createdAt: 1715568000000,
      provenance: { label: "chat_extract" },
    };
    expect(meta.agentId).toBe("agent-1");
    expect(meta.sessionKey).toBeUndefined();
  });

  it("accepts a full metadata object with optional fields", () => {
    const meta: MilvusMemoryEntryMetadata = {
      agentId: "agent-2",
      sessionKey: "session-abc",
      memoryType: "long_term",
      createdAt: 1715568000000,
      provenance: { label: "recall_promotion" },
    };
    expect(meta.sessionKey).toBe("session-abc");
    expect(meta.provenance.label).toBe("recall_promotion");
  });

  it("createdAt is a number (UTC milliseconds)", () => {
    const meta: MilvusMemoryEntryMetadata = {
      agentId: "agent-3",
      memoryType: "short_term",
      createdAt: Date.now(),
      provenance: { label: "user_manual" },
    };
    expect(typeof meta.createdAt).toBe("number");
    expect(meta.createdAt).toBeGreaterThan(1_700_000_000_000);
  });

  it("memoryType accepts all MEMORY_TYPES values", () => {
    const types = Object.values(MEMORY_TYPES);
    for (const t of types) {
      const meta: MilvusMemoryEntryMetadata = {
        agentId: "a",
        memoryType: t as MemoryType,
        createdAt: 0,
        provenance: { label: "import" },
      };
      expect(meta.memoryType).toBe(t);
    }
  });

  it("provenance.label accepts all MEMORY_SOURCE_LABELS values", () => {
    const labels = Object.values(MEMORY_SOURCE_LABELS);
    for (const label of labels) {
      const meta: MilvusMemoryEntryMetadata = {
        agentId: "a",
        memoryType: "short_term",
        createdAt: 0,
        provenance: { label: label as MemorySourceLabel },
      };
      expect(meta.provenance.label).toBe(label);
    }
  });
});
