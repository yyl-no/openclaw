/**
 * Milvus hybrid search (ANN + scalar filter) implementation.
 *
 * - Vector search: client.search({ anns_field: "embedding" })
 * - Text search: client.query({ filter: 'text like "%keyword%"' }) + client-side TF-IDF
 * - Score fusion: score = w1 × vectorScore + w2 × textScore → MMR → temporal decay
 * - BM25 native hybrid search available when Milvus ≥ 2.4 has a BM25 Function
 */

import {
  MilvusClient,
  type NumberArrayId,
  type QueryReq,
  type RowData,
  type SearchSimpleReq,
} from "@zilliz/milvus2-sdk-node";
import type { MemoryEmbeddingProvider } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import type {
  MemoryEmbeddingProbeResult,
  MemoryEntry,
  MemoryProviderStatus,
  MemoryReadResult,
  MemoryReference,
  MemorySearchRuntimeDebug,
  PromotionCandidate,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { replayFallback, writeFallback } from "./fallback.js";
import {
  FIELD_AGENT_ID,
  FIELD_CONTENT_HASH,
  FIELD_CREATED_AT,
  FIELD_EMBEDDING,
  FIELD_ID,
  FIELD_LAST_RECALLED_AT,
  FIELD_MEMORY_TYPE,
  FIELD_PROVENANCE_KIND,
  FIELD_PROVENANCE_LABEL,
  FIELD_RECALL_COUNT,
  FIELD_SESSION_KEY,
  FIELD_SNIPPET,
  FIELD_SPARSE_BM25,
  FIELD_TEXT,
  FIELD_UPDATED_AT,
  OUTPUT_FIELDS,
  computeContentHash,
  entryToInsertData,
  rowToMemoryEntry,
  rowToMemoryReference,
} from "./schema.js";
import {
  assertValidMemoryType,
  assertValidSourceLabel,
  MEMORY_SOURCE_LABELS,
  MEMORY_TYPES,
} from "./types.js";
import { warnOnce } from "./warn-once.js";

// ── Config types ──────────────────────────────────────────────────

export interface MilvusSearchConfig {
  host: string;
  port: number;
  collectionName: string;
  embedding: {
    provider: string;
    model: string;
    dimensions?: number;
  };
  /** Search weight configuration (default: vectorWeight=0.7, textWeight=0.3) */
  search?: {
    vectorWeight?: number;
    textWeight?: number;
    /** Enable native BM25 hybrid search when Milvus ≥ 2.4 has BM25 Function (default: false) */
    useBM25?: boolean;
  };
}

// ── Defaults ──────────────────────────────────────────────────────

const DEFAULT_MAX_RESULTS = 10;
const DEFAULT_MIN_SCORE = 0;
const DEFAULT_VECTOR_WEIGHT = 0.7;
const DEFAULT_TEXT_WEIGHT = 0.3;
/** Vector search fetch multiplier (larger recall pool for fusion) */
const VECTOR_FETCH_MULTIPLIER = 3;

// ── Keyword extraction ────────────────────────────────────────────

/**
 * Extract keywords from query text for scalar filter / BM25 sparse vector.
 *
 * Uses simple Unicode tokenization: extract \\p{L}\\p{N}_ sequences,
 * deduplicate, and filter length < 2.
 * This produces an upper-bound keyword set — the client cannot do
 * language-aware tokenization (CJK segmentation, stemming, stopwords).
 * Under native BM25 the set is only used to build a query sparse vector;
 * the server-side BM25 Function handles actual tokenization and weighting.
 */
function extractKeywords(query: string): string[] {
  const tokens =
    query
      .toLowerCase()
      .match(/[\p{L}\p{N}_]+/gu)
      ?.map((t) => t.trim())
      .filter((t) => t.length >= 2) ?? [];
  return [...new Set(tokens)];
}

/**
 * Build a Milvus scalar filter expression ("text like" query).
 * OR-joins multiple keyword like clauses.
 */
function buildKeywordFilter(keywords: string[], agentId?: string): string {
  const parts: string[] = [];

  if (agentId) {
    parts.push(`${FIELD_AGENT_ID} == "${agentId.replace(/"/g, '\\"')}"`);
  }

  if (keywords.length > 0) {
    const likeClauses = keywords.map(
      (kw) =>
        `${FIELD_TEXT} like "%${kw.replace(/%/g, "\\%").replace(/_/g, "\\_").replace(/"/g, '\\"')}%"`,
    );
    parts.push(`(${likeClauses.join(" || ")})`);
  }

  return parts.join(" && ");
}

/**
 * Build a Milvus scalar filter expression from structured filter options.
 * Used for agentId / sessionKey / memoryType / createdAfter filtering.
 * When memoryType is not specified and excludeArchived is true (default),
 * archived entries are excluded from results.
 * Returns "" if no filters are specified.
 */
function buildScalarFilter(opts: {
  agentId?: string;
  sessionKey?: string;
  memoryType?: string;
  createdAfter?: string;
  excludeArchived?: boolean;
}): string {
  const parts: string[] = [];

  if (opts.agentId) {
    parts.push(`${FIELD_AGENT_ID} == "${opts.agentId.replace(/"/g, '\\"')}"`);
  }
  if (opts.sessionKey) {
    parts.push(`${FIELD_SESSION_KEY} == "${opts.sessionKey.replace(/"/g, '\\"')}"`);
  }
  if (opts.memoryType) {
    parts.push(`${FIELD_MEMORY_TYPE} == "${opts.memoryType.replace(/"/g, '\\"')}"`);
  } else if (opts.excludeArchived !== false) {
    // Default: exclude archived unless explicitly overridden
    parts.push(`${FIELD_MEMORY_TYPE} != "archived"`);
  }
  if (opts.createdAfter) {
    parts.push(`${FIELD_CREATED_AT} >= "${opts.createdAfter.replace(/"/g, '\\"')}"`);
  }

  return parts.join(" && ");
}

/**
 * Combine two Milvus filter expressions with AND.
 * Returns the non-empty filter if one is empty, or the AND combination.
 * Returns "" if both are empty.
 */
function combineFilters(a: string, b?: string): string {
  const aNorm = a.trim();
  const bNorm = b?.trim() ?? "";
  if (aNorm && bNorm) return `(${aNorm}) && (${bNorm})`;
  return aNorm || bNorm;
}

// ── TF-IDF ────────────────────────────────────────────────────────

/**
 * Client-side TF-IDF scoring on keyword search results.
 * Computes textScore for each doc returned by query().
 */
function computeTfIdfScores(
  docs: Array<{ id: string; text: string }>,
  queryKeywords: string[],
): Map<string, number> {
  const scores = new Map<string, number>();
  if (docs.length === 0 || queryKeywords.length === 0) return scores;

  const totalDocs = docs.length;
  const idf = new Map<string, number>();

  // Compute IDF: doc frequency for each keyword
  for (const kw of queryKeywords) {
    const docCount = docs.filter((d) => d.text.toLowerCase().includes(kw)).length;
    // IDF = log(1 + N / df)
    idf.set(kw, Math.log(1 + totalDocs / Math.max(1, docCount)));
  }

  // Compute TF-IDF score for each document
  for (const doc of docs) {
    const lowerText = doc.text.toLowerCase();
    let score = 0;
    for (const kw of queryKeywords) {
      const idfVal = idf.get(kw) ?? 0;
      if (idfVal <= 0) continue;
      // TF = keyword occurrence count
      const matches = lowerText.split(kw).length - 1;
      if (matches > 0) {
        // Sub-linear TF: 1 + log(tf)
        score += (1 + Math.log(matches)) * idfVal;
      }
    }
    scores.set(doc.id, score);
  }

  // Normalize to 0-1
  const maxScore = Math.max(1, ...scores.values());
  for (const [id, score] of scores) {
    scores.set(id, score / maxScore);
  }

  return scores;
}

// ── Vector score normalization ────────────────────────────────────

/**
 * Convert vector distance to similarity score (0-1).
 * Supports L2 and IP/COSINE metric types.
 */
function normalizeVectorScore(rawScore: number, metricType?: string): number {
  if (metricType === "L2") {
    // L2 distance: smaller is better, map to 0-1
    return 1 / (1 + rawScore);
  }
  // IP/COSINE: larger is better, clamp to 0-1
  return Math.max(0, Math.min(1, rawScore));
}

// ── Temporal decay ──────────────────────────────────────────────────

/**
 * Temporal decay factor.
 * Older memories receive lower scores.
 */
function temporalDecayFactor(createdAt: string, halfLifeDays = 30): number {
  if (!createdAt) return 1;
  const createdMs = Date.parse(createdAt);
  if (Number.isNaN(createdMs)) return 1;
  const ageDays = (Date.now() - createdMs) / (1000 * 60 * 60 * 24);
  if (ageDays <= 0) return 1;
  // Half-life decay: 2^(-age/halfLife)
  return Math.pow(2, -ageDays / halfLifeDays);
}

/**
 * Compute promotion score for deep dreaming candidate ranking.
 *
 * Score = normalizedRecall × recencyDecay
 * - normalizedRecall = min(recallCount / 10, 1.0)
 * - recencyDecay uses lastRecalledAt (fallback to createdAt) with half-life
 */
function computePromotionScore(params: {
  recallCount: number;
  createdAt: string;
  lastRecalledAt: string;
  recencyHalfLifeDays: number;
  nowMs: number;
}): number {
  const { recallCount, createdAt, lastRecalledAt, recencyHalfLifeDays, nowMs } = params;

  // Normalize recall count to 0-1 (10+ recalls = full score)
  const normalizedRecall = Math.min(recallCount / 10, 1.0);

  // Recency: prefer lastRecalledAt, fallback to createdAt
  const recencyRef = lastRecalledAt || createdAt;
  if (!recencyRef) return normalizedRecall;

  const refMs = Date.parse(recencyRef);
  if (Number.isNaN(refMs)) return normalizedRecall;

  const ageDays = (nowMs - refMs) / (1000 * 60 * 60 * 24);
  if (ageDays <= 0) return normalizedRecall;

  const decay = Math.pow(2, -ageDays / Math.max(1, recencyHalfLifeDays));
  return normalizedRecall * decay;
}

// ── MMR (Maximal Marginal Relevance) ──────────────────────────────

/**
 * MMR re-ranking: balance relevance and diversity.
 */
function applyMMR(results: MemoryReference[], lambda = 0.7, maxResults: number): MemoryReference[] {
  if (results.length <= 1) return results;

  const selected: MemoryReference[] = [];
  const candidates = [...results];

  // Sort candidates by descending score; first result is the highest
  candidates.sort((a, b) => b.score - a.score);
  selected.push(candidates.shift()!);

  while (selected.length < maxResults && candidates.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;

    for (let i = 0; i < candidates.length; i++) {
      const relevance = candidates[i].score;
      // Max text similarity to previously selected results (Jaccard approximation)
      let maxSimilarity = 0;
      const candTokens = new Set(candidates[i].snippet.toLowerCase().split(/\s+/));
      for (const sel of selected) {
        const selTokens = new Set(sel.snippet.toLowerCase().split(/\s+/));
        const intersection = [...candTokens].filter((t) => selTokens.has(t)).length;
        const union = new Set([...candTokens, ...selTokens]).size;
        const similarity = union > 0 ? intersection / union : 0;
        maxSimilarity = Math.max(maxSimilarity, similarity);
      }
      const mmrScore = lambda * relevance - (1 - lambda) * maxSimilarity;
      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIdx = i;
      }
    }

    selected.push(candidates.splice(bestIdx, 1)[0]);
  }

  return selected;
}

// ── MilvusSearchManager ───────────────────────────────────────────

export class MilvusSearchManager {
  private closed = false;

  /**
   * Whether the manager is operating in degraded mode (Milvus unreachable
   * during init).  In degraded mode writes go through the fallback path
   * and search/read operations may return empty results.
   */
  public readonly degraded: boolean;

  constructor(
    private readonly client: MilvusClient,
    private readonly collectionName: string,
    private readonly provider: MemoryEmbeddingProvider,
    private readonly agentId: string,
    private readonly cfg: MilvusSearchConfig,
    private readonly workspaceDir: string,
    opts?: { degraded?: boolean },
  ) {
    this.degraded = opts?.degraded ?? false;
  }

  // ── Main search ──────────────────────────────────────────────

  async search(
    query: string,
    opts?: {
      maxResults?: number;
      minScore?: number;
      sessionKey?: string;
      agentId?: string;
      /** Filter by memory_type (e.g. "short_term", "long_term", "archived") */
      memoryType?: string;
      /** Include archived entries in search results (default: false) */
      includeArchived?: boolean;
      /** Filter by created_at >= this ISO timestamp */
      createdAfter?: string;
      qmdSearchModeOverride?: "query" | "search" | "vsearch";
      onDebug?: (debug: MemorySearchRuntimeDebug) => void;
    },
  ): Promise<MemoryReference[]> {
    if (this.closed) return [];
    if (this.degraded) {
      warnOnce("degraded-search", "search skipped: manager is in degraded mode");
      return [];
    }
    const maxResults = opts?.maxResults ?? DEFAULT_MAX_RESULTS;
    const minScore = opts?.minScore ?? DEFAULT_MIN_SCORE;
    const effectiveAgentId = opts?.agentId ?? this.agentId;
    const fetchLimit = Math.max(maxResults * VECTOR_FETCH_MULTIPLIER, 20);

    // Build scalar filter for agent / memoryType / createdAfter
    const scalarFilter = buildScalarFilter({
      agentId: effectiveAgentId,
      sessionKey: opts?.sessionKey,
      memoryType: opts?.memoryType,
      createdAfter: opts?.createdAfter,
      excludeArchived: !opts?.includeArchived,
    });

    // Clean query text
    const cleaned = query.trim();

    // Empty query with scalar filters → pure query (no semantic search)
    if (!cleaned) {
      if (!scalarFilter) return [];
      const refs = await this.queryByFilter(scalarFilter, fetchLimit);
      return refs.filter((r) => r.score >= minScore).slice(0, maxResults);
    }

    // 1. Get query embedding
    let queryVec: number[] = [];
    try {
      queryVec = await this.provider.embedQuery(cleaned);
    } catch (err) {
      console.warn("[memory-milvus] embedding failed:", err);
    }
    const hasVector = queryVec.length > 0 && queryVec.some((v) => v !== 0);

    // 2. Try native BM25 hybrid search (useBM25=true and Milvus ≥ 2.4 with BM25 Function)
    const useBM25 = this.cfg.search?.useBM25 ?? false;
    let merged: MemoryReference[] | undefined;

    if (useBM25 && hasVector) {
      const bm25Results = await this.searchBM25(
        queryVec,
        cleaned,
        effectiveAgentId,
        fetchLimit,
        scalarFilter,
      );
      if (bm25Results !== null) {
        // Apply temporal decay (legacy path applies decay in mergeResults)
        merged = bm25Results.map((r) => ({
          ...r,
          score:
            r.score *
            temporalDecayFactor(
              ((r as Record<string, unknown>)[FIELD_CREATED_AT] as string) ?? "",
              30,
            ),
        }));
      }
      // null → fall back to legacy path
    }

    // 3. Legacy path: separate ANN + keyword search + score fusion (includes decay)
    if (!merged) {
      let vectorRefs: MemoryReference[] = [];
      if (hasVector) {
        try {
          vectorRefs = await this.searchVector(
            queryVec,
            effectiveAgentId,
            fetchLimit,
            scalarFilter,
          );
        } catch (err) {
          console.warn("[memory-milvus] vector search failed:", err);
        }
      }

      let keywordRefs: MemoryReference[] = [];
      const keywords = extractKeywords(cleaned);
      if (keywords.length > 0) {
        try {
          keywordRefs = await this.searchKeyword(
            keywords,
            effectiveAgentId,
            fetchLimit,
            scalarFilter,
          );
        } catch (err) {
          console.warn("[memory-milvus] keyword search failed:", err);
        }
      }

      const vw = this.cfg.search?.vectorWeight ?? DEFAULT_VECTOR_WEIGHT;
      const tw = this.cfg.search?.textWeight ?? DEFAULT_TEXT_WEIGHT;
      merged = this.mergeResults(vectorRefs, keywordRefs, vw, tw);
    }

    // 4. MMR re-ranking
    const mmrResults = applyMMR(merged, 0.7, maxResults * 2);

    // 5. Filter, sort, truncate
    return mmrResults.filter((r) => r.score >= minScore).slice(0, maxResults);
  }

  // ── Vector search ────────────────────────────────────────────

  private async searchVector(
    vector: number[],
    agentId: string,
    limit: number,
    additionalFilter?: string,
  ): Promise<MemoryReference[]> {
    const request: SearchSimpleReq = {
      collection_name: this.collectionName,
      vector,
      anns_field: FIELD_EMBEDDING,
      limit,
      output_fields: [...OUTPUT_FIELDS],
    };

    // When additionalFilter is provided, it already contains the agentId clause.
    // Otherwise, add agentId filter directly.
    const filter = additionalFilter
      ? additionalFilter
      : agentId
        ? `${FIELD_AGENT_ID} == "${agentId.replace(/"/g, '\\"')}"`
        : "";
    if (filter) {
      request.filter = filter;
    }

    const response = await this.client.search(request);

    if (!response.results || response.results.length === 0) {
      return [];
    }

    return response.results.map((r) => {
      const ref = rowToMemoryReference(r as unknown as Record<string, unknown>);
      ref.score = normalizeVectorScore(r.score, "COSINE");
      ref.vectorScore = ref.score;
      return ref;
    });
  }

  // ── Keyword search ──────────────────────────────────────────

  private async searchKeyword(
    keywords: string[],
    agentId: string,
    limit: number,
    additionalFilter?: string,
  ): Promise<MemoryReference[]> {
    // When additionalFilter is provided, it already contains the agentId clause.
    // Build keyword-only filter and combine with additionalFilter.
    const keywordFilter = buildKeywordFilter(keywords, additionalFilter ? undefined : agentId);
    const filter = combineFilters(keywordFilter, additionalFilter);

    const request: QueryReq = {
      collection_name: this.collectionName,
      filter,
      output_fields: [
        FIELD_ID,
        FIELD_TEXT,
        FIELD_SNIPPET,
        FIELD_CREATED_AT,
        ...OUTPUT_FIELDS.filter((f) => f !== FIELD_ID && f !== FIELD_TEXT && f !== FIELD_SNIPPET),
      ],
      limit,
    };

    const response = await this.client.query(request);

    if (!response.data || response.data.length === 0) {
      return [];
    }

    // Client-side TF-IDF computes textScore
    const docs = response.data.map((row: Record<string, unknown>) => ({
      id: String(row[FIELD_ID] ?? ""),
      text: String(row[FIELD_TEXT] ?? ""),
    }));
    const tfidfScores = computeTfIdfScores(docs, keywords);

    return response.data.map((row: Record<string, unknown>) => {
      const ref = rowToMemoryReference(row);
      ref.textScore = tfidfScores.get(ref.id) ?? 0;
      ref.score = ref.textScore;
      return ref;
    });
  }

  // ── BM25 native hybrid search (hybridSearch + WeightedRanker) ─

  /**
   * Try native BM25 hybrid search when Milvus ≥ 2.4 has a BM25 Function
   * mapping FIELD_TEXT → FIELD_SPARSE_BM25.
   *
   * Uses a single hybridSearch call with two ANN fields:
   *   - FIELD_EMBEDDING (dense vector, weighted by cfg.search.vectorWeight)
   *   - FIELD_SPARSE_BM25 (sparse BM25 vector, weighted by cfg.search.textWeight)
   * combined via WeightedRanker.
   *
   * Returns null if the BM25 Function is not available on the server,
   * signalling the caller to fall back to separate ANN + TF-IDF.
   */
  private async searchBM25(
    queryVec: number[],
    queryText: string,
    _agentId: string,
    limit: number,
    scalarFilter: string,
  ): Promise<MemoryReference[] | null> {
    try {
      // Build a sparse vector dict from query keywords for BM25. When the
      // server-side BM25 Function exists, Milvus applies the same tokenization
      // and weighting to the query.  Passing a dict with term→1.0 weight lets
      // the Function produce the final BM25-weighted sparse vector.
      const keywords = extractKeywords(queryText);
      const sparseVec: Record<string, number> = {};
      for (const kw of keywords) {
        sparseVec[kw] = 1.0;
      }

      const vw = this.cfg.search?.vectorWeight ?? DEFAULT_VECTOR_WEIGHT;
      const tw = this.cfg.search?.textWeight ?? DEFAULT_TEXT_WEIGHT;

      const grpcClient = this.client as unknown as {
        hybridSearch(
          req: Record<string, unknown>,
        ): Promise<{ results: Array<{ id: string; score: number; [key: string]: unknown }> }>;
      };

      const result = await grpcClient.hybridSearch({
        collection_name: this.collectionName,
        data: [
          {
            anns_field: FIELD_EMBEDDING,
            data: queryVec,
            expr: scalarFilter || undefined,
          },
          {
            anns_field: FIELD_SPARSE_BM25,
            data: sparseVec,
            expr: scalarFilter || undefined,
          },
        ],
        rerank: {
          strategy: "weighted",
          params: { weights: [vw, tw] },
        },
        output_fields: [...OUTPUT_FIELDS],
        limit,
      });

      if (!result.results || result.results.length === 0) {
        return [];
      }

      return result.results.map((r) => {
        const ref = rowToMemoryReference(r as unknown as Record<string, unknown>);
        ref.score = typeof r.score === "number" ? r.score : 0;
        return ref;
      });
    } catch {
      // BM25 Function not available or hybridSearch failed → fall back
      return null;
    }
  }

  // ── Scalar-only filter query (no semantic search) ──────────

  /**
   * Query by scalar filter only (no vector search).
   * Used for data collection phases (light/REM dreaming) where we
   * need to list all records matching a filter without a search query.
   */
  private async queryByFilter(filter: string, limit: number): Promise<MemoryReference[]> {
    const request: QueryReq = {
      collection_name: this.collectionName,
      filter,
      output_fields: [...OUTPUT_FIELDS],
      limit,
    };

    const response = await this.client.query(request);

    if (!response.data || response.data.length === 0) {
      return [];
    }

    return (response.data as Record<string, unknown>[]).map((row) => {
      const ref = rowToMemoryReference(row);
      ref.score = 1; // No semantic score — assign neutral score
      return ref;
    });
  }

  // ── Result fusion ────────────────────────────────────────────

  private mergeResults(
    vectorRefs: MemoryReference[],
    keywordRefs: MemoryReference[],
    vectorWeight: number,
    textWeight: number,
  ): MemoryReference[] {
    const byId = new Map<string, MemoryReference>();

    // Vector results
    for (const r of vectorRefs) {
      byId.set(r.id, {
        ...r,
        textScore: 0,
        score: vectorWeight * (r.vectorScore ?? r.score),
      });
    }

    // Keyword results
    for (const r of keywordRefs) {
      const existing = byId.get(r.id);
      if (existing) {
        existing.textScore = r.textScore ?? r.score;
        existing.score =
          vectorWeight * (existing.vectorScore ?? 0) + textWeight * (r.textScore ?? r.score);
        // Prefer the keyword-matched snippet (more relevant)
        if (r.snippet && r.snippet.length > (existing.snippet?.length ?? 0)) {
          existing.snippet = r.snippet;
        }
      } else {
        byId.set(r.id, {
          ...r,
          vectorScore: 0,
          score: textWeight * (r.textScore ?? r.score),
        });
      }
    }

    // Apply temporal decay
    const results: MemoryReference[] = [];
    for (const [, ref] of byId) {
      const decay = temporalDecayFactor(
        ((ref as Record<string, unknown>)[FIELD_CREATED_AT] as string) ?? "",
        30,
      );
      results.push({ ...ref, score: ref.score * decay });
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);
    return results;
  }

  // ── Read by ID ──────────────────────────────────────────────

  async readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<MemoryReadResult> {
    if (this.closed) throw new Error("MilvusSearchManager is closed");

    // In the milvus backend, relPath is interpreted as a memory id
    const id = params.relPath.trim();
    if (!id) throw new Error("Missing memory id");

    const response = await this.client.get({
      collection_name: this.collectionName,
      ids: [id],
      output_fields: [FIELD_ID, FIELD_TEXT, FIELD_SNIPPET],
    });

    if (!response.data || response.data.length === 0) {
      throw new Error(`Memory entry not found: ${id}`);
    }

    const entry = rowToMemoryEntry(response.data[0] as Record<string, unknown>);
    let text = entry.text;
    const from = params.from ?? 0;
    const lines = params.lines;

    if (lines !== undefined || from > 0) {
      const textLines = text.split("\n");
      const sliced = textLines.slice(from, lines !== undefined ? from + lines : undefined);
      text = sliced.join("\n");
    }

    return {
      text,
      path: `milvus:${id}`,
      truncated: false,
      from,
      lines,
      nextFrom: lines !== undefined ? from + lines : undefined,
    };
  }

  // ── get(id) — MemoryDataBackend.get ─────────────────────────

  /**
   * Look up a memory entry by PK id.
   * Returns all 13 fields.
   * Does not trigger recordRecall (direct PK lookup is not a search).
   */
  async get(id: string): Promise<MemoryEntry> {
    if (this.closed) throw new Error("MilvusSearchManager is closed");
    if (this.degraded) throw new Error("MilvusSearchManager is in degraded mode");

    const rawId = id.trim();
    if (!rawId) throw new Error("Missing memory id");

    const response = await this.client.get({
      collection_name: this.collectionName,
      ids: [rawId],
      output_fields: [
        FIELD_ID,
        FIELD_TEXT,
        FIELD_SNIPPET,
        FIELD_AGENT_ID,
        FIELD_SESSION_KEY,
        FIELD_MEMORY_TYPE,
        FIELD_RECALL_COUNT,
        FIELD_PROVENANCE_KIND,
        FIELD_PROVENANCE_LABEL,
        FIELD_CONTENT_HASH,
        FIELD_CREATED_AT,
        FIELD_UPDATED_AT,
        FIELD_LAST_RECALLED_AT,
      ],
    });

    if (!response.data || response.data.length === 0) {
      throw new Error(`Memory entry not found: ${rawId}`);
    }

    return rowToMemoryEntry(response.data[0] as Record<string, unknown>);
  }

  // ── update(id, patch) — MemoryDataBackend.update ────────────

  /**
   * Update a memory entry: query → merge patch → re-embed if text changed → upsert.
   *
   * Failure semantics: not-found / closed / degraded → throw.
   * Update failures are fatal — they do not fall back to ndjson.
   */
  async update(
    id: string,
    patch: {
      text?: string;
      snippet?: string;
      memoryType?: string;
      sessionKey?: string;
      provenanceLabel?: string;
    },
  ): Promise<MemoryEntry> {
    if (this.closed) throw new Error("MilvusSearchManager is closed");
    if (this.degraded) throw new Error("MilvusSearchManager is in degraded mode");

    const rawId = id.trim();
    if (!rawId) throw new Error("Missing memory id");
    if (!patch || Object.keys(patch).length === 0) {
      throw new Error("Update patch must contain at least one field");
    }

    // Step 1: query existing
    const existing = await this.get(rawId);

    // Step 2: merge
    const now = new Date().toISOString();
    const merged: Omit<MemoryEntry, "id"> = {
      text: patch.text ?? existing.text,
      snippet: patch.snippet ?? existing.snippet,
      agentId: existing.agentId,
      sessionKey: patch.sessionKey !== undefined ? patch.sessionKey : existing.sessionKey,
      memoryType: (patch.memoryType as MemoryEntry["memoryType"]) ?? existing.memoryType,
      recallCount: existing.recallCount,
      createdAt: existing.createdAt,
      updatedAt: now,
      provenance: {
        kind: existing.provenance.kind,
        label: patch.provenanceLabel ?? existing.provenance.label,
      },
    };

    // Step 3: re-embed if text changed, else reuse existing embedding
    const textChanged = patch.text !== undefined && patch.text !== existing.text;
    const needsReembed =
      textChanged ||
      (patch.provenanceLabel !== undefined && patch.provenanceLabel !== existing.provenance.label);

    let vector: number[];
    let contentHash: string;

    if (needsReembed) {
      vector = await this.provider.embedQuery(merged.text);
      if (!vector || vector.every((v) => v === 0)) {
        throw new Error("Embedding returned empty vector during update");
      }
      contentHash = computeContentHash(merged.text, merged.provenance?.label);
    } else {
      // Reuse existing embedding — query it
      const embResponse = await this.client.query({
        collection_name: this.collectionName,
        filter: `${FIELD_ID} == ${rawId}`,
        output_fields: [FIELD_EMBEDDING, FIELD_CONTENT_HASH],
        limit: 1,
      });
      const embRow = embResponse.data?.[0] as Record<string, unknown>;
      vector = (embRow?.[FIELD_EMBEDDING] as number[]) ?? [];
      contentHash = String(embRow?.[FIELD_CONTENT_HASH] ?? "");
    }

    // Step 4: upsert
    const data = entryToInsertData(merged);
    data[FIELD_ID] = Number(rawId);
    data[FIELD_EMBEDDING] = vector;
    data[FIELD_CONTENT_HASH] = contentHash;

    await this.client.upsert({
      collection_name: this.collectionName,
      data: [data as unknown as RowData],
    });

    // Return updated entry
    return {
      id: rawId,
      ...merged,
    };
  }

  // ── archive(id) — Soft delete ─────────────────────────────

  /**
   * Soft-delete a memory entry: set memory_type = "archived".
   * Search excludes archived by default; includeArchived: true overrides.
   * Failure throws directly, no fallback.
   */
  async archive(id: string): Promise<void> {
    if (this.closed) throw new Error("MilvusSearchManager is closed");
    if (this.degraded) throw new Error("MilvusSearchManager is in degraded mode");

    const rawId = id.trim();
    if (!rawId) throw new Error("Missing memory id");

    // Query existing row to preserve all fields (Milvus upsert writes full rows)
    const existing = await this.get(rawId);

    // Query embedding vector (excluded from get() output fields)
    const embResponse = await this.client.query({
      collection_name: this.collectionName,
      filter: `${FIELD_ID} == ${rawId}`,
      output_fields: [FIELD_EMBEDDING, FIELD_CONTENT_HASH],
      limit: 1,
    });
    const embRow = embResponse.data?.[0] as Record<string, unknown> | undefined;

    const now = new Date().toISOString();
    const data = entryToInsertData({
      text: existing.text,
      snippet: existing.snippet,
      agentId: existing.agentId,
      sessionKey: existing.sessionKey,
      memoryType: MEMORY_TYPES.ARCHIVED,
      recallCount: existing.recallCount,
      createdAt: existing.createdAt,
      updatedAt: now,
      provenance: existing.provenance,
    });
    data[FIELD_ID] = Number(rawId);
    data[FIELD_EMBEDDING] = (embRow?.[FIELD_EMBEDDING] as number[]) ?? [];
    data[FIELD_CONTENT_HASH] = String(embRow?.[FIELD_CONTENT_HASH] ?? "");

    await this.client.upsert({
      collection_name: this.collectionName,
      data: [data as unknown as RowData],
    });
  }

  // ── Write (MemoryDataBackend.write) ─────────────────────────

  /**
   * Write a memory entry to Milvus.
   *
   * Flow:
   * 1. Validate metadata (sourceLabel / memoryType)
   * 2. If degraded or health check fails → ndjson fallback
   * 3. Otherwise, replay pending fallback entries, then embed + insert
   * 4. If insert fails → fallback, return placeholder MemoryReference
   */
  async write(entry: Omit<MemoryEntry, "id">): Promise<MemoryReference> {
    if (this.closed) throw new Error("MilvusSearchManager is closed");

    // Assemble metadata
    const label = (entry.provenance?.label as string) ?? MEMORY_SOURCE_LABELS.CHAT_EXTRACT;
    assertValidSourceLabel(label);
    const memoryType = entry.memoryType ?? MEMORY_TYPES.SHORT_TERM;
    assertValidMemoryType(memoryType);

    const fullEntry: Omit<MemoryEntry, "id"> = {
      text: entry.text,
      snippet: entry.snippet ?? entry.text.slice(0, 200),
      agentId: entry.agentId ?? this.agentId,
      sessionKey: entry.sessionKey,
      memoryType,
      recallCount: entry.recallCount ?? 0,
      createdAt: entry.createdAt ?? new Date().toISOString(),
      updatedAt: entry.updatedAt ?? new Date().toISOString(),
      provenance: { kind: entry.provenance?.kind ?? "milvus", label },
    };

    // Degraded or health check failed → fallback
    if (this.degraded || !(await this.healthCheck())) {
      return this.fallbackWrite(fullEntry);
    }

    // Healthy path: replay pending fallback first
    try {
      await replayFallback(this.workspaceDir, async (fb) => {
        await this.insertEntry(fb);
      });
    } catch (err) {
      console.warn(
        "[memory-milvus] Fallback replay error (continuing):",
        (err as Error).message ?? err,
      );
    }

    // Write new entry
    try {
      const ref = await this.insertEntry(fullEntry);
      return ref;
    } catch (err) {
      console.warn(
        "[memory-milvus] Insert failed, writing to fallback:",
        (err as Error).message ?? err,
      );
      return this.fallbackWrite(fullEntry);
    }
  }

  /**
   * Embed + insert a single MemoryEntry into Milvus.
   * Returns a MemoryReference (id is the Milvus auto-increment PK).
   *
   * Checks content_hash for dedup before insertion — if a matching
   * entry already exists, returns it without re-embedding/inserting.
   */
  private async insertEntry(entry: Omit<MemoryEntry, "id">): Promise<MemoryReference> {
    // Dedup: check content_hash before insert
    const contentHash = computeContentHash(entry.text, entry.provenance?.label);
    const existingRef = await this.findByContentHash(contentHash);
    if (existingRef) return existingRef;

    const vector = await this.provider.embedQuery(entry.text);
    if (!vector || vector.every((v) => v === 0)) {
      throw new Error("Embedding returned empty vector");
    }

    const data = entryToInsertData(entry);
    data[FIELD_EMBEDDING] = vector;
    data[FIELD_CONTENT_HASH] = contentHash;

    const result = await this.client.insert({
      collection_name: this.collectionName,
      data: [data as unknown as RowData],
    });

    // Extract Milvus auto-increment PK
    const pk = (result.IDs as NumberArrayId)?.int_id?.data?.[0];
    const idStr = pk != null ? String(pk) : `milvus:${Date.now()}`;

    return {
      id: idStr,
      snippet: entry.snippet ?? entry.text.slice(0, 200),
      score: 0,
      provenance: {
        kind: entry.provenance?.kind ?? "milvus",
        label: (entry.provenance?.label as string) ?? MEMORY_SOURCE_LABELS.CHAT_EXTRACT,
      },
    };
  }

  /**
   * Check if a duplicate record exists by content_hash.
   * Returns the existing MemoryReference or null.
   */
  private async findByContentHash(hash: string): Promise<MemoryReference | null> {
    if (!hash) return null;
    try {
      const response = await this.client.query({
        collection_name: this.collectionName,
        filter: `${FIELD_CONTENT_HASH} == "${hash.replace(/"/g, '\\"')}"`,
        output_fields: [FIELD_ID, FIELD_SNIPPET, FIELD_PROVENANCE_KIND, FIELD_PROVENANCE_LABEL],
        limit: 1,
      });
      if (response.data?.length) {
        return rowToMemoryReference(response.data[0] as Record<string, unknown>);
      }
    } catch {
      // Dedup check failure should not block writes
    }
    return null;
  }

  // ── Health probe ────────────────────────────────────────────────

  /** Lightweight Milvus health probe (describe_collection). */
  private async healthCheck(): Promise<boolean> {
    try {
      await this.client.describeCollection({
        collection_name: this.collectionName,
      });
      return true;
    } catch {
      return false;
    }
  }

  // ── Write fallback ──────────────────────────────────────────────

  /** Write to NDJSON fallback; return placeholder MemoryReference. */
  private async fallbackWrite(entry: Omit<MemoryEntry, "id">): Promise<MemoryReference> {
    await writeFallback(this.workspaceDir, entry).catch((err) => {
      console.warn("[memory-milvus] writeFallback also failed:", (err as Error).message);
    });

    return {
      id: `fallback:${Date.now()}`,
      snippet: entry.snippet ?? entry.text.slice(0, 200),
      score: 0,
      provenance: {
        kind: entry.provenance?.kind ?? "milvus",
        label: (entry.provenance?.label as string) ?? MEMORY_SOURCE_LABELS.CHAT_EXTRACT,
      },
    };
  }

  // ── recordRecall ─────────────────────────────────────────

  /**
   * Batch update recall counts: query current fields → increment
   * recall_count + set last_recalled_at → upsert back to Milvus.
   *
   * Failure policy: warns once and discards (recall tracking is best-effort).
   */
  async recordRecall(
    refs: MemoryReference[],
    _context?: { query: string; timezone?: string },
  ): Promise<void> {
    if (!refs.length) return;

    if (this.closed) throw new Error("MilvusSearchManager is closed");
    if (this.degraded) {
      warnOnce(
        "milvus:recordRecall:degraded",
        "[memory-milvus] recordRecall skipped: manager is in degraded mode",
      );
      return;
    }

    const ids = refs.map((r) => r.id).filter(Boolean);
    if (!ids.length) return;

    try {
      // Step 1: query current fields (agent isolation)
      const queryResponse = await this.client.query({
        collection_name: this.collectionName,
        filter: `id in [${ids.join(",")}] && ${FIELD_AGENT_ID} == "${this.agentId.replace(/"/g, '\\"')}"`,
        output_fields: [
          FIELD_ID,
          FIELD_RECALL_COUNT,
          FIELD_TEXT,
          FIELD_SNIPPET,
          FIELD_AGENT_ID,
          FIELD_SESSION_KEY,
          FIELD_MEMORY_TYPE,
          FIELD_PROVENANCE_KIND,
          FIELD_PROVENANCE_LABEL,
          FIELD_CONTENT_HASH,
          FIELD_CREATED_AT,
          FIELD_UPDATED_AT,
          FIELD_LAST_RECALLED_AT,
        ],
        limit: ids.length,
      });

      const existingMap = new Map<string, Record<string, unknown>>();
      for (const row of (queryResponse.data ?? []) as Record<string, unknown>[]) {
        existingMap.set(String(row[FIELD_ID] ?? ""), row);
      }

      const now = new Date().toISOString();

      // Step 2: increment recall_count + set last_recalled_at
      const upsertRows: Record<string, unknown>[] = [];
      for (const id of ids) {
        const existing = existingMap.get(id);
        const prevCount =
          existing?.[FIELD_RECALL_COUNT] != null ? Number(existing[FIELD_RECALL_COUNT]) : 0;

        const row: Record<string, unknown> = {
          [FIELD_ID]: id,
          [FIELD_RECALL_COUNT]: prevCount + 1,
          [FIELD_LAST_RECALLED_AT]: now,
          [FIELD_UPDATED_AT]: now,
        };

        // Preserve existing field values (upsert requires full rows to avoid clearing fields)
        if (existing) {
          row[FIELD_TEXT] = existing[FIELD_TEXT];
          row[FIELD_SNIPPET] = existing[FIELD_SNIPPET];
          row[FIELD_AGENT_ID] = existing[FIELD_AGENT_ID];
          row[FIELD_SESSION_KEY] = existing[FIELD_SESSION_KEY];
          row[FIELD_MEMORY_TYPE] = existing[FIELD_MEMORY_TYPE];
          row[FIELD_PROVENANCE_KIND] = existing[FIELD_PROVENANCE_KIND];
          row[FIELD_PROVENANCE_LABEL] = existing[FIELD_PROVENANCE_LABEL];
          row[FIELD_CONTENT_HASH] = existing[FIELD_CONTENT_HASH];
          row[FIELD_CREATED_AT] = existing[FIELD_CREATED_AT];
        }

        upsertRows.push(row);
      }

      // Step 3: single upsert
      await this.client.upsert({
        collection_name: this.collectionName,
        data: upsertRows as unknown as RowData[],
      });
    } catch (err) {
      warnOnce(
        "milvus:recordRecall:upsert-failed",
        `[memory-milvus] recordRecall upsert failed: ${(err as Error).message}`,
      );
    }
  }

  // ── Promotion (Deep Dreaming) ────────────────────────────

  /**
   * Apply promotions: write new long_term entries for each candidate,
   * then archive (upsert) the original short_term records.
   *
   * Per-candidate failure is non-fatal: failed candidates are skipped
   * with a warning and the loop continues.
   */
  async applyPromotions(opts: {
    candidates: PromotionCandidate[];
    limit?: number;
    minScore?: number;
    minRecallCount?: number;
    minUniqueQueries?: number;
    maxAgeDays?: number;
    timezone?: string;
    nowMs?: number;
  }): Promise<{ applied: number; appliedCandidates: PromotionCandidate[] }> {
    if (this.closed) throw new Error("MilvusSearchManager is closed");
    if (this.degraded) {
      warnOnce(
        "milvus:applyPromotions:degraded",
        "[memory-milvus] applyPromotions skipped: manager is in degraded mode",
      );
      return { applied: 0, appliedCandidates: [] };
    }

    let filtered = opts.candidates;
    if (opts.minScore != null) {
      filtered = filtered.filter((c) => c.score >= opts.minScore!);
    }
    if (opts.minRecallCount != null) {
      filtered = filtered.filter((c) => c.recallCount >= opts.minRecallCount!);
    }
    if (opts.limit != null && opts.limit > 0) {
      filtered = filtered.slice(0, opts.limit);
    }

    if (!filtered.length) return { applied: 0, appliedCandidates: [] };

    const appliedCandidates: PromotionCandidate[] = [];

    for (const candidate of filtered) {
      try {
        // 1. Read full original entry
        const entry = await this.get(candidate.id);

        // 2. Write new long_term entry (re-embed, provenance points to source)
        await this.insertEntry({
          text: entry.text,
          snippet: entry.snippet,
          agentId: entry.agentId,
          sessionKey: entry.sessionKey,
          memoryType: MEMORY_TYPES.LONG_TERM,
          recallCount: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          provenance: {
            kind: "milvus",
            label: MEMORY_SOURCE_LABELS.RECALL_PROMOTION,
          },
        });

        // 3. Archive original short_term — query embedding, then upsert full row
        const now = new Date().toISOString();
        const embResponse = await this.client.query({
          collection_name: this.collectionName,
          filter: `${FIELD_ID} == ${candidate.id}`,
          output_fields: [FIELD_EMBEDDING, FIELD_CONTENT_HASH],
          limit: 1,
        });
        const embRow = embResponse.data?.[0] as Record<string, unknown> | undefined;
        const archiveData = entryToInsertData({
          text: entry.text,
          snippet: entry.snippet,
          agentId: entry.agentId,
          sessionKey: entry.sessionKey,
          memoryType: MEMORY_TYPES.ARCHIVED,
          recallCount: entry.recallCount,
          createdAt: entry.createdAt,
          updatedAt: now,
          provenance: entry.provenance,
        });
        archiveData[FIELD_ID] = candidate.id;
        archiveData[FIELD_EMBEDDING] = (embRow?.[FIELD_EMBEDDING] as number[]) ?? [];
        archiveData[FIELD_CONTENT_HASH] = String(embRow?.[FIELD_CONTENT_HASH] ?? "");

        await this.client.upsert({
          collection_name: this.collectionName,
          data: [archiveData as unknown as RowData],
        });

        appliedCandidates.push(candidate);
      } catch (err) {
        warnOnce(
          `milvus:applyPromotions:candidate-${candidate.id}`,
          `[memory-milvus] applyPromotions failed for candidate ${candidate.id}: ${(err as Error).message}`,
        );
      }
    }

    return { applied: appliedCandidates.length, appliedCandidates };
  }

  /**
   * Rank short_term records as promotion candidates for deep dreaming.
   *
   * Scores records by recency-weighted recall frequency.
   * Only considers short_term records that have been recalled at least once.
   * `uniqueQueries` uses `recallCount` as a proxy until Task 16's 9-dim signals.
   */
  async rankPromotionCandidates(opts: {
    limit?: number;
    minScore?: number;
    minRecallCount?: number;
    minUniqueQueries?: number;
    maxAgeDays?: number;
    recencyHalfLifeDays?: number;
    nowMs?: number;
  }): Promise<PromotionCandidate[]> {
    if (this.closed) throw new Error("MilvusSearchManager is closed");
    if (this.degraded) {
      warnOnce(
        "milvus:rankPromotion:degraded",
        "[memory-milvus] rankPromotionCandidates skipped: manager is in degraded mode",
      );
      return [];
    }

    const limit = opts.limit ?? 20;
    const minScore = opts.minScore ?? 0;
    const minRecallCount = opts.minRecallCount ?? 1;
    const maxAgeDays = opts.maxAgeDays;
    const recencyHalfLifeDays = opts.recencyHalfLifeDays ?? 30;
    const nowMs = opts.nowMs ?? Date.now();

    // Query short_term records for this agent
    const filter = buildScalarFilter({
      agentId: this.agentId,
      memoryType: MEMORY_TYPES.SHORT_TERM,
    });

    let rows: Record<string, unknown>[] = [];
    try {
      const response = await this.client.query({
        collection_name: this.collectionName,
        filter,
        output_fields: [
          FIELD_ID,
          FIELD_SNIPPET,
          FIELD_RECALL_COUNT,
          FIELD_CREATED_AT,
          FIELD_LAST_RECALLED_AT,
        ],
        limit: 1000,
      });
      rows = (response.data ?? []) as Record<string, unknown>[];
    } catch (err) {
      warnOnce(
        "milvus:rankPromotion:query-failed",
        `[memory-milvus] rankPromotionCandidates query failed: ${(err as Error).message}`,
      );
      return [];
    }

    if (!rows.length) return [];

    const candidates: PromotionCandidate[] = [];
    for (const row of rows) {
      const recallCount = Number(row[FIELD_RECALL_COUNT] ?? 0);
      if (recallCount < minRecallCount) continue;

      const createdAt = String(row[FIELD_CREATED_AT] ?? "");
      const lastRecalledAt = String(row[FIELD_LAST_RECALLED_AT] ?? "");

      // Age filter
      if (maxAgeDays != null) {
        const createdMs = Date.parse(createdAt);
        if (!Number.isNaN(createdMs)) {
          const ageDays = (nowMs - createdMs) / (1000 * 60 * 60 * 24);
          if (ageDays > maxAgeDays) continue;
        }
      }

      // Score: recall_count weighted by recency
      const score = computePromotionScore({
        recallCount,
        createdAt,
        lastRecalledAt,
        recencyHalfLifeDays,
        nowMs,
      });

      if (score < minScore) continue;

      candidates.push({
        id: String(row[FIELD_ID] ?? ""),
        snippet: String(row[FIELD_SNIPPET] ?? ""),
        score,
        recallCount,
        uniqueQueries: recallCount, // proxy: Task 16 replaces with real unique query count
      });
    }

    // Sort by score desc, apply limit
    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, limit);
  }

  // ── Status ────────────────────────────────────────────────────

  status(): MemoryProviderStatus {
    return {
      backend: "qmd",
      provider: this.cfg.embedding.provider,
      model: this.cfg.embedding.model,
      requestedProvider: this.cfg.embedding.provider,
      sources: ["memory"],
      custom: {
        milvusHost: this.cfg.host,
        milvusPort: this.cfg.port,
        collectionName: this.collectionName,
        collectionClosed: this.closed,
        degraded: this.degraded,
      },
    };
  }

  // ── Probes ────────────────────────────────────────────────────

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    try {
      const vec = await this.provider.embedQuery("ping");
      if (vec.length > 0) {
        return { ok: true, checked: true, checkedAtMs: Date.now() };
      }
      return { ok: false, error: "Empty embedding vector", checked: true, checkedAtMs: Date.now() };
    } catch (err) {
      return {
        ok: false,
        error: `Embedding probe failed: ${String(err)}`,
        checked: true,
        checkedAtMs: Date.now(),
      };
    }
  }

  async probeVectorAvailability(): Promise<boolean> {
    try {
      const result = await this.probeEmbeddingAvailability();
      return result.ok && !this.closed;
    } catch {
      return false;
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
  }
}

// ── Factory ────────────────────────────────────────────────────────

/** Create a MilvusClient instance. */
export function createMilvusClient(host: string, port: number): MilvusClient {
  const address = host.includes(":") ? host : `${host}:${port}`;
  return new MilvusClient(address);
}
