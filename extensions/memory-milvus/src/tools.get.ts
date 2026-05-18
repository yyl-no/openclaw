/** `memory_get` tool for the Milvus backend — retrieves a full entry by PK id. */

import type { MemoryEntry } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { jsonResult } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";

// ── Schema ────────────────────────────────────────────────────────

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

// ── Description ───────────────────────────────────────────────────

const MEMORY_GET_DESCRIPTION =
  "Retrieve a specific memory entry by its id. " +
  "Returns the full entry text and metadata. " +
  "Only the 'id' parameter is used by the milvus backend.";

// ── Deps ──────────────────────────────────────────────────────────

type MemoryGetManager = {
  get(id: string): Promise<MemoryEntry>;
};

export interface MemoryGetToolDeps {
  /**
   * Resolve the active MilvusSearchManager.
   * May return synchronously (tests) or asynchronously (runtime: lazy pool lookup).
   */
  getManager: () => MemoryGetManager | Promise<MemoryGetManager | null> | null;
}

// ── Factory ───────────────────────────────────────────────────────

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

      let manager: MemoryGetManager | null;
      try {
        manager = await Promise.resolve(deps.getManager());
      } catch (err) {
        return jsonResult({
          error: err instanceof Error ? err.message : String(err),
        });
      }

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
