/**
 * memory-milvus memory_search 工具
 *
 * 依据：1-plan.md §Task 16-9 + 2-decisions.md §17
 *
 * - Schema 与 memory-core MemorySearchSchema 一对一
 * - corpus=memory/undefined → manager.search()
 * - corpus=sessions → manager.search() with sessionKey filter
 * - corpus=wiki → searchMemoryCorpusSupplements only
 * - corpus=all → milvus + supplements merged
 * - 命中后自动 recordRecall hook
 */

import {
  decorateCitations,
  filterMemorySearchHitsBySessionVisibility,
  jsonResult,
  listMemoryCorpusSupplements,
  resolveMemoryCitationsMode,
  shouldIncludeCitations,
  type MemoryCorpusSearchResult,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { MemoryReference } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";

// ── Supplement 搜索辅助 ──────────────────────────────────────────

/**
 * 搜索已注册的 wiki/外部 corpus supplements。
 * 对齐 memory-core tools.shared.ts searchMemoryCorpusSupplements。
 * 通过 SDK barrel 的 listMemoryCorpusSupplements 获取注册表。
 */
async function searchSupplements(params: {
  query: string;
  maxResults?: number;
  agentSessionKey?: string;
  corpus?: "memory" | "wiki" | "all" | "sessions";
}): Promise<MemoryCorpusSearchResult[]> {
  if (params.corpus === "memory" || params.corpus === "sessions") {
    return [];
  }
  const supplements = listMemoryCorpusSupplements();
  if (supplements.length === 0) {
    return [];
  }
  const results = (
    await Promise.all(
      supplements.map(async (registration) =>
        registration.supplement.search(params),
      ),
    )
  ).flat();
  return results
    .toSorted((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      return left.path.localeCompare(right.path);
    })
    .slice(0, Math.max(1, params.maxResults ?? 10));
}

/**
 * 将 supplement 命中转为与 milvus MemoryReference 兼容的结果格式。
 */
function supplementHitToResult(
  hit: MemoryCorpusSearchResult,
): Record<string, unknown> & { corpus: string; score: number; path: string } {
  return {
    corpus: hit.corpus || "wiki",
    score: hit.score,
    path: hit.path,
    id: hit.id,
    snippet: hit.snippet,
    title: hit.title,
    kind: hit.kind,
    startLine: hit.startLine,
    endLine: hit.endLine,
    source: hit.source,
    provenanceLabel: hit.provenanceLabel,
  };
}

// ── Merge ───────────────────────────────────────────────────────

/**
 * 多路融合排序：milvus + wiki supplement 命中按 score 排序后取 top-N。
 * 对齐 memory-core tools.ts mergeMemorySearchCorpusResults。
 */
function mergeMultiCorpusResults(params: {
  milvusResults: MemoryReference[];
  supplementResults: MemoryCorpusSearchResult[];
  maxResults: number;
}): Array<Record<string, unknown> & { corpus: string; score: number; path: string }> {
  const milvusMapped = params.milvusResults.map((r) => ({
    ...r,
    corpus: r.source === "sessions" ? ("sessions" as const) : ("memory" as const),
    path: r.provenance?.label ?? r.id ?? "",
  }));
  const supplementMapped = params.supplementResults.map(supplementHitToResult);
  return sortByScore([...milvusMapped, ...supplementMapped]).slice(0, params.maxResults);
}

function sortByScore<T extends { score: number; path: string }>(results: T[]): T[] {
  return results.toSorted((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.path.localeCompare(b.path);
  });
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
        "'sessions' searches session-annotated entries. " +
        "'wiki' searches registered wiki supplements. " +
        "'all' merges milvus + wiki supplement hits with unified scoring.",
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

      try {

      // Corpus routing (T16-9: 对齐 memory-core createMemorySearchTool)
      const shouldQueryMilvus = corpus !== "wiki";
      const shouldQuerySupplements = corpus === "wiki" || corpus === "all";

      const manager = deps.getManager();

      // Search milvus (when needed) and supplements in parallel
      let [milvusRaw, supplementResults] = await Promise.all([
        (async () => {
          if (!shouldQueryMilvus) return [] as MemoryReference[];
          if (!manager) {
            throw new Error(
              "Milvus search manager is not initialized. Ensure the memory-milvus plugin is configured and the Milvus server is reachable.",
            );
          }
          return await manager.search(query, {
            maxResults,
            minScore,
            sessionKey: deps.agentSessionKey,
          });
        })(),
        (async () => {
          if (!shouldQuerySupplements) return [] as MemoryCorpusSearchResult[];
          return await searchSupplements({
            query,
            maxResults,
            agentSessionKey: deps.agentSessionKey,
            corpus: corpus as "wiki" | "all" | undefined,
          });
        })(),
      ]);

      // Session visibility filtering on milvus hits (before building results)
      if (milvusRaw.length > 0 && deps.cfg) {
        milvusRaw = await filterMemorySearchHitsBySessionVisibility({
          cfg: deps.cfg,
          requesterSessionKey: deps.agentSessionKey,
          sandboxed: deps.sandboxed === true,
          hits: milvusRaw,
        });
      }

      // Build results
      const isMultiCorpus = shouldQueryMilvus && shouldQuerySupplements;
      let results: Array<Record<string, unknown> & { corpus: string; score: number; path: string }>;

      if (isMultiCorpus) {
        // corpus=all: merge milvus + wiki supplements with unified scoring
        results = mergeMultiCorpusResults({
          milvusResults: milvusRaw,
          supplementResults,
          maxResults: Math.max(1, maxResults ?? 10),
        });
      } else if (corpus === "wiki") {
        // corpus=wiki: supplements only
        results = supplementResults.map(supplementHitToResult);
      } else {
        // corpus=memory/sessions: milvus only
        results = milvusRaw.map((r) => ({
          ...r,
          corpus: (corpus === "sessions" ? "sessions" : "memory") as string,
          path: r.provenance?.label ?? r.id ?? "",
        }));
      }

      // Citation decoration on results (skip for wiki-only corpus)
      if (corpus !== "wiki") {
        const cfg = deps.cfg;
        const citationMode = cfg ? resolveMemoryCitationsMode(cfg) : "auto";
        const includeCitations = shouldIncludeCitations({
          mode: citationMode,
          sessionKey: deps.agentSessionKey,
        });
        results = decorateCitations(results, includeCitations);
      }

      // Record recall hook (milvus hits only)
      if (milvusRaw.length > 0 && manager?.recordRecall) {
        void manager.recordRecall(milvusRaw, { query }).catch(() => {});
      }

      // Determine output corpus label
      const outputCorpus =
        corpus === "all" ? "all" : corpus === "wiki" ? "wiki" : corpus || "memory";

      return jsonResult({
        results,
        corpus: outputCorpus,
        ...(supplementResults.length > 0 ? { supplementCount: supplementResults.length } : {}),
      });
    } catch (err) {
      return jsonResult({ error: (err as Error).message });
    }
    },
  };
}
