/**
 * memory-milvus memory_search 工具
 *
 * 依据：1-plan.md §Task 11 Step 2 + 2-decisions.md §13/§16/§17/§18
 *
 * - Schema 与 memory-core MemorySearchSchema 一对一
 * - corpus=memory/undefined → manager.search()
 * - corpus=sessions/wiki/all → warnOnce + 返回空
 * - 命中后自动 recordRecall hook
 * - 会话可见性过滤：当前 milvus 结果无 session source，filter 为 no-op；
 *   corpus=sessions 真正支持时接入 filterMemorySearchHitsBySessionVisibility（Task 16）
 * - 不装饰 citation（MemoryReference 原样透传）
 */

import { jsonResult, parseAgentSessionKey, type MemoryCitationsMode, type OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { MemoryReference } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { warnOnce } from "./warn-once.js";

// ── Citation 装饰（复刻 memory-core tools.citations.ts）──────────

function resolveMemoryCitationsMode(cfg: OpenClawConfig): MemoryCitationsMode {
  const mode = cfg.memory?.citations;
  if (mode === "on" || mode === "off" || mode === "auto") return mode;
  return "auto";
}

function shouldIncludeCitations(mode: MemoryCitationsMode, sessionKey?: string): boolean {
  if (mode === "on") return true;
  if (mode === "off") return false;
  // auto mode: only decorate in direct chats
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed?.rest) return true;
  const tokens = new Set(parsed.rest.toLowerCase().split(":").filter(Boolean));
  return !tokens.has("group") && !tokens.has("channel");
}

function formatCitation(ref: MemoryReference): string {
  if (ref.provenance?.label) return ref.provenance.label;
  return "";
}

function decorateCitations(
  results: MemoryReference[],
  include: boolean,
): MemoryReference[] {
  if (!include) return results;
  return results.map((r) => ({
    ...r,
    snippet: `${(r.snippet ?? "").trim()}\n\nSource: ${formatCitation(r)}`,
  }));
}

// ── Schema ──────────────────────────────────────────────────────

const MEMORY_SEARCH_SCHEMA = {
  type: "object" as const,
  properties: {
    query: {
      type: "string" as const,
      description: "The search query text to find relevant memories.",
    },
    maxResults: {
      type: "number" as const,
      description: "Maximum number of results to return (default 10).",
    },
    minScore: {
      type: "number" as const,
      description: "Minimum relevance score threshold (0-1, default 0).",
    },
    corpus: {
      type: "string" as const,
      enum: ["memory", "wiki", "all", "sessions"] as readonly string[],
      description:
        "Memory corpus to search. 'memory' searches the main memory store. " +
        "'sessions', 'wiki', and 'all' are not yet supported in the milvus backend.",
    },
  },
  required: ["query"],
};

// ── Description ─────────────────────────────────────────────────

const MEMORY_SEARCH_DESCRIPTION =
  "Search memory entries using hybrid vector + keyword search. " +
  "Returns a ranked list of memory references with id, snippet, score, and provenance.";

// ── Deps ────────────────────────────────────────────────────────

export interface MemorySearchToolDeps {
  getManager: () => {
    search(
      query: string,
      opts?: {
        maxResults?: number;
        minScore?: number;
        sessionKey?: string;
        agentId?: string;
      },
    ): Promise<MemoryReference[]>;
    recordRecall?(
      refs: MemoryReference[],
      context?: { query: string; timezone?: string },
    ): Promise<void>;
  } | null;
  cfg?: OpenClawConfig;
  agentSessionKey?: string;
  sandboxed?: boolean;
}

// ── Factory ─────────────────────────────────────────────────────

export function createMemorySearchTool(deps: MemorySearchToolDeps): AnyAgentTool {
  return {
    name: "memory_search",
    label: "memory_search",
    description: MEMORY_SEARCH_DESCRIPTION,
    parameters: MEMORY_SEARCH_SCHEMA,
    async execute(_toolCallId, rawParams) {
      const params = rawParams as Record<string, unknown>;
      const query = typeof params.query === "string" ? params.query.trim() : "";
      if (!query) {
        return jsonResult({ error: "query is required and must be a non-empty string" });
      }

      const maxResults =
        typeof params.maxResults === "number" ? params.maxResults : undefined;
      const minScore =
        typeof params.minScore === "number" ? params.minScore : undefined;
      const corpus = typeof params.corpus === "string" ? params.corpus : "memory";

      // Corpus routing
      if (corpus === "sessions") {
        warnOnce(
          "corpus-sessions",
          "corpus=sessions not yet supported in milvus backend",
        );
        return jsonResult({ results: [], corpus: "sessions" });
      }
      if (corpus === "wiki") {
        warnOnce(
          "corpus-wiki",
          "wiki supplement integration deferred to Task 16",
        );
        return jsonResult({ results: [], corpus: "wiki" });
      }
      if (corpus === "all") {
        warnOnce(
          "corpus-all-deferred",
          "corpus=all: wiki part deferred to Task 16; searching memory only",
        );
      }

      const manager = deps.getManager();
      if (!manager) {
        return jsonResult({
          error:
            "Milvus search manager is not initialized. Ensure the memory-milvus plugin is configured and the Milvus server is reachable.",
        });
      }

      try {
        const rawResults = await manager.search(query, {
          maxResults,
          minScore,
          sessionKey: deps.agentSessionKey,
        });

        // Session visibility filtering (双层叠加)
        // TODO(T16-9): Wire filterMemorySearchHitsBySessionVisibility via runtime-api
        // barrel once corpus=sessions support is added. For pure milvus entries
        // (no source="sessions" hits) this is currently a no-op.
        const visibilityFilteredResults = rawResults;

        // Citation decoration (on visibility-filtered results)
        const cfg = deps.cfg;
        const citationMode = cfg ? resolveMemoryCitationsMode(cfg) : "auto";
        const includeCitations = shouldIncludeCitations(citationMode, deps.agentSessionKey);
        const decoratedResults = decorateCitations(visibilityFilteredResults, includeCitations);

        // Record recall hook
        if (rawResults.length > 0 && manager.recordRecall) {
          void manager.recordRecall(rawResults, { query }).catch(() => {});
        }

        return jsonResult({
          results: decoratedResults,
          corpus: corpus === "all" ? "memory" : corpus,
        });
      } catch (err) {
        return jsonResult({ error: (err as Error).message });
      }
    },
  };
}
