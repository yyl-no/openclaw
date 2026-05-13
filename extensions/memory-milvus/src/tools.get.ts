/**
 * memory-milvus memory_get 工具
 *
 * 依据：1-plan.md §Task 11 Step 2 + 2-decisions.md §14
 *
 * - Schema 与 memory-core MemoryGetSchema 一对一
 * - 实际仅用 id 参数，path/from/lines/corpus 占位忽略
 * - 调 manager.get(id) 返回 MemoryEntry
 * - 不触发 recordRecall
 */

import { jsonResult } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { MemoryEntry } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";

// ── Schema ──────────────────────────────────────────────────────

const MEMORY_GET_SCHEMA = {
  type: "object" as const,
  properties: {
    path: {
      type: "string" as const,
      description: "Deprecated for milvus backend: use id instead.",
    },
    from: {
      type: "number" as const,
      description: "Deprecated for milvus backend: use id instead.",
    },
    lines: {
      type: "number" as const,
      description: "Deprecated for milvus backend: use id instead.",
    },
    corpus: {
      type: "string" as const,
      enum: ["memory", "wiki", "all"] as readonly string[],
      description: "Memory corpus (ignored for milvus backend; only id is used).",
    },
    id: {
      type: "string" as const,
      description: "The memory entry id to retrieve.",
    },
  },
};

// ── Description ─────────────────────────────────────────────────

const MEMORY_GET_DESCRIPTION =
  "Retrieve a specific memory entry by its id. " +
  "Returns the full entry text and metadata. " +
  "Only the 'id' parameter is used by the milvus backend.";

// ── Deps ────────────────────────────────────────────────────────

export interface MemoryGetToolDeps {
  getManager: () => {
    get(id: string): Promise<MemoryEntry>;
  } | null;
}

// ── Factory ─────────────────────────────────────────────────────

export function createMemoryGetTool(deps: MemoryGetToolDeps): AnyAgentTool {
  return {
    name: "memory_get",
    label: "memory_get",
    description: MEMORY_GET_DESCRIPTION,
    parameters: MEMORY_GET_SCHEMA,
    async execute(_toolCallId, rawParams) {
      const params = rawParams as Record<string, unknown>;
      const id = typeof params.id === "string" ? params.id.trim() : "";

      if (!id) {
        return jsonResult({ error: "id is required for milvus backend memory retrieval" });
      }

      const manager = deps.getManager();
      if (!manager) {
        return jsonResult({
          error:
            "Milvus search manager is not initialized. Ensure the memory-milvus plugin is configured and the Milvus server is reachable.",
        });
      }

      try {
        const entry = await manager.get(id);
        return jsonResult(entry);
      } catch (err) {
        return jsonResult({ error: (err as Error).message });
      }
    },
  };
}
