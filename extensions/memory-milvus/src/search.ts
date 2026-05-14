/**
 * Milvus 混合检索（ANN + scalar filter）实现
 *
 * 依据：1-plan.md §Task9 + 2-decisions.md §8.1
 *
 * - 向量搜索：milvusClient.search({ anns_field: "embedding" })
 * - 文本搜索：milvusClient.query({ filter: 'text like "%keyword%"' }) + 客户端 TF-IDF
 * - 评分融合：score = w1 × vectorScore + w2 × textScore → MMR → 时间衰减
 * - ⚠️ 后期升级：Milvus ≥ 2.4 BM25 Function 后切换为原生 BM25（见 decisions §8.1）
 */

import { MilvusClient, type NumberArrayId, type QueryReq, type RowData, type SearchSimpleReq } from "@zilliz/milvus2-sdk-node";
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
import { replayFallback, writeFallback } from "./fallback.js";
import { warnOnce } from "./warn-once.js";

// ── 配置类型 ──────────────────────────────────────────────────────

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

// ── 默认参数 ──────────────────────────────────────────────────────

const DEFAULT_MAX_RESULTS = 10;
const DEFAULT_MIN_SCORE = 0;
const DEFAULT_VECTOR_WEIGHT = 0.7;
const DEFAULT_TEXT_WEIGHT = 0.3;
/** 向量搜索拉取倍数（扩大召回池供融合筛选） */
const VECTOR_FETCH_MULTIPLIER = 3;

// ── 关键词抽取 ────────────────────────────────────────────────────

/**
 * 从查询文本中抽取关键词（用于 scalar filter / BM25 查询向量构建）。
 *
 * 算法为简单 Unicode 分词：提取 \\p{L}\\p{N}_ 连续序列，去重，过滤长度 < 2。
 * 这产生的是**偏上限**的关键词集合——客户端无法实现服务端 BM25 的
 * 语言感知分词（如中文分词、词干提取、停用词过滤），因此召回会偏多
 * 但不会漏。BM25 原生路径下此集合仅用于构建 query sparse vector，
 * 实际 BM25 计算由服务端 Function 负责。
 *
 * 返回去重后的关键词列表。
 */
function extractKeywords(query: string): string[] {
  const tokens = query
    .toLowerCase()
    .match(/[\p{L}\p{N}_]+/gu)
    ?.map((t) => t.trim())
    .filter((t) => t.length >= 2) ?? [];
  return [...new Set(tokens)];
}

/**
 * 构建 Milvus scalar filter 表达式（"text like" 查询）
 * 使用 OR 连接多个关键词的 like 条件。
 */
function buildKeywordFilter(keywords: string[], agentId?: string): string {
  const parts: string[] = [];

  if (agentId) {
    parts.push(`${FIELD_AGENT_ID} == "${agentId.replace(/"/g, '\\"')}"`);
  }

  if (keywords.length > 0) {
    const likeClauses = keywords.map(
      (kw) => `${FIELD_TEXT} like "%${kw.replace(/%/g, "\\%").replace(/_/g, "\\_").replace(/"/g, '\\"')}%"`,
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
 * 客户端 TF-IDF 评分
 * 对 query() 返回的关键词搜索结果计算 textScore。
 */
function computeTfIdfScores(
  docs: Array<{ id: string; text: string }>,
  queryKeywords: string[],
): Map<string, number> {
  const scores = new Map<string, number>();
  if (docs.length === 0 || queryKeywords.length === 0) return scores;

  const totalDocs = docs.length;
  const idf = new Map<string, number>();

  // 计算 IDF：关键词在多少文档中出现
  for (const kw of queryKeywords) {
    const docCount = docs.filter((d) =>
      d.text.toLowerCase().includes(kw),
    ).length;
    // IDF = log(1 + N / df)
    idf.set(kw, Math.log(1 + totalDocs / Math.max(1, docCount)));
  }

  // 计算每个文档的 TF-IDF 总分
  for (const doc of docs) {
    const lowerText = doc.text.toLowerCase();
    let score = 0;
    for (const kw of queryKeywords) {
      const idfVal = idf.get(kw) ?? 0;
      if (idfVal <= 0) continue;
      // TF = 关键词出现次数
      const matches = lowerText.split(kw).length - 1;
      if (matches > 0) {
        // 子线性 TF：1 + log(tf)
        score += (1 + Math.log(matches)) * idfVal;
      }
    }
    scores.set(doc.id, score);
  }

  // 归一化到 0-1
  const maxScore = Math.max(1, ...scores.values());
  for (const [id, score] of scores) {
    scores.set(id, score / maxScore);
  }

  return scores;
}

// ── 向量分数归一化 ────────────────────────────────────────────────

/**
 * 向量距离 → 相似度分数 (0-1)
 * 支持 L2 和 IP/COSINE 度量类型。
 */
function normalizeVectorScore(rawScore: number, metricType?: string): number {
  if (metricType === "L2") {
    // L2 距离：越小越好，映射到 0-1
    return 1 / (1 + rawScore);
  }
  // IP/COSINE：越大越好，截断到 0-1
  return Math.max(0, Math.min(1, rawScore));
}

// ── 时间衰减 ──────────────────────────────────────────────────────

/**
 * 时间衰减因子
 * 越旧的记忆分数越低。
 */
function temporalDecayFactor(createdAt: string, halfLifeDays = 30): number {
  if (!createdAt) return 1;
  const createdMs = Date.parse(createdAt);
  if (Number.isNaN(createdMs)) return 1;
  const ageDays = (Date.now() - createdMs) / (1000 * 60 * 60 * 24);
  if (ageDays <= 0) return 1;
  // 半衰期衰减：2^(-age/halfLife)
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

// ── MMR（最大边际相关性）───────────────────────────────────────────

/**
 * MMR 重排序：平衡相关性与多样性
 */
function applyMMR(
  results: MemoryReference[],
  lambda = 0.7,
  maxResults: number,
): MemoryReference[] {
  if (results.length <= 1) return results;

  const selected: MemoryReference[] = [];
  const candidates = [...results];

  // 第一个结果选最高分
  candidates.sort((a, b) => b.score - a.score);
  selected.push(candidates.shift()!);

  while (selected.length < maxResults && candidates.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;

    for (let i = 0; i < candidates.length; i++) {
      const relevance = candidates[i].score;
      // 与已选结果的最大文本相似度（Jaccard 近似）
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

  // ── 主搜索 ────────────────────────────────────────────────────

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

    // 清理查询文本
    const cleaned = query.trim();

    // Empty query with scalar filters → pure query (no semantic search)
    if (!cleaned) {
      if (!scalarFilter) return [];
      const refs = await this.queryByFilter(scalarFilter, fetchLimit);
      return refs.filter((r) => r.score >= minScore).slice(0, maxResults);
    }

    // 1. 获取查询向量
    let queryVec: number[] = [];
    try {
      queryVec = await this.provider.embedQuery(cleaned);
    } catch (err) {
      console.warn("[memory-milvus] embedding failed:", err);
    }
    const hasVector = queryVec.length > 0 && queryVec.some((v) => v !== 0);

    // 2. 尝试原生 BM25 混合搜索（useBM25=true 且 Milvus ≥ 2.4 有 BM25 Function）
    const useBM25 = this.cfg.search?.useBM25 ?? false;
    let merged: MemoryReference[] | undefined;

    if (useBM25 && hasVector) {
      const bm25Results = await this.searchBM25(
        queryVec, cleaned, effectiveAgentId, fetchLimit, scalarFilter,
      );
      if (bm25Results !== null) {
        // 应用时间衰减（legacy 路径由 mergeResults 内置衰减）
        merged = bm25Results.map((r) => ({
          ...r,
          score: r.score * temporalDecayFactor(
            (r as Record<string, unknown>)[FIELD_CREATED_AT] as string ?? "", 30,
          ),
        }));
      }
      // null → 降级到 legacy 路径
    }

    // 3. Legacy 路径: 独立 ANN + 关键词搜索 + 评分融合（含衰减）
    if (!merged) {
      let vectorRefs: MemoryReference[] = [];
      if (hasVector) {
        try {
          vectorRefs = await this.searchVector(queryVec, effectiveAgentId, fetchLimit, scalarFilter);
        } catch (err) {
          console.warn("[memory-milvus] vector search failed:", err);
        }
      }

      let keywordRefs: MemoryReference[] = [];
      const keywords = extractKeywords(cleaned);
      if (keywords.length > 0) {
        try {
          keywordRefs = await this.searchKeyword(keywords, effectiveAgentId, fetchLimit, scalarFilter);
        } catch (err) {
          console.warn("[memory-milvus] keyword search failed:", err);
        }
      }

      const vw = this.cfg.search?.vectorWeight ?? DEFAULT_VECTOR_WEIGHT;
      const tw = this.cfg.search?.textWeight ?? DEFAULT_TEXT_WEIGHT;
      merged = this.mergeResults(vectorRefs, keywordRefs, vw, tw);
    }

    // 4. MMR 重排序
    const mmrResults = applyMMR(merged, 0.7, maxResults * 2);

    // 5. 过滤、排序、截断
    return mmrResults
      .filter((r) => r.score >= minScore)
      .slice(0, maxResults);
  }

  // ── 向量搜索 ──────────────────────────────────────────────────

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

  // ── 关键词搜索 ────────────────────────────────────────────────

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
      output_fields: [FIELD_ID, FIELD_TEXT, FIELD_SNIPPET, FIELD_CREATED_AT, ...OUTPUT_FIELDS.filter(
        (f) => f !== FIELD_ID && f !== FIELD_TEXT && f !== FIELD_SNIPPET,
      )],
      limit,
    };

    const response = await this.client.query(request);

    if (!response.data || response.data.length === 0) {
      return [];
    }

    // 客户端 TF-IDF 计算 textScore
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

  // ── BM25 原生搜索（hybridSearch + WeightedRanker）───────────

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

  // ── 纯标量过滤查询（无语义搜索） ──────────────────────────────

  /**
   * Query by scalar filter only (no vector search).
   * Used for data collection phases (light/REM dreaming) where we
   * need to list all records matching a filter without a search query.
   */
  private async queryByFilter(
    filter: string,
    limit: number,
  ): Promise<MemoryReference[]> {
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

  // ── 结果融合 ──────────────────────────────────────────────────

  private mergeResults(
    vectorRefs: MemoryReference[],
    keywordRefs: MemoryReference[],
    vectorWeight: number,
    textWeight: number,
  ): MemoryReference[] {
    const byId = new Map<string, MemoryReference>();

    // 向量结果
    for (const r of vectorRefs) {
      byId.set(r.id, {
        ...r,
        textScore: 0,
        score: vectorWeight * (r.vectorScore ?? r.score),
      });
    }

    // 关键词结果
    for (const r of keywordRefs) {
      const existing = byId.get(r.id);
      if (existing) {
        existing.textScore = r.textScore ?? r.score;
        existing.score = vectorWeight * (existing.vectorScore ?? 0) + textWeight * (r.textScore ?? r.score);
        // 优先使用关键词匹配的 snippet（更相关）
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

    // 应用时间衰减
    const results: MemoryReference[] = [];
    for (const [, ref] of byId) {
      const decay = temporalDecayFactor(
        (ref as Record<string, unknown>)[FIELD_CREATED_AT] as string ?? "",
        30,
      );
      results.push({ ...ref, score: ref.score * decay });
    }

    // 按分数降序排列
    results.sort((a, b) => b.score - a.score);
    return results;
  }

  // ── 按 ID 读取 ────────────────────────────────────────────────

  async readFile(params: { relPath: string; from?: number; lines?: number }): Promise<MemoryReadResult> {
    if (this.closed) throw new Error("MilvusSearchManager is closed");

    // Milvus 后端：relPath 解释为记忆 ID
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

  // ── get(id) — MemoryDataBackend.get ───────────────────────────

  /**
   * 按 id 查询 PK → MemoryEntry。
   * 一次性取全 13 个字段（含 β last_recalled_at）。
   * not-found / closed / degraded → throw。
   * 不触发 recordRecall（按 PK 直查不计入召回统计）。
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

  // ── update(id, patch) — MemoryDataBackend.update ──────────────

  /**
   * 更新一条记忆：query → merge patch → re-embed if text changed → upsert。
   *
   * @param id   目标记录主键
   * @param patch 要合并的字段（text/snippet/memoryType/sessionKey/provenanceLabel）
   * @returns 更新后的 MemoryEntry
   *
   * 失败语义（§12.7）：not-found / closed / degraded → throw；
   * update 失败直接抛出，不走 fallback（update 是精确操作，不可丢）。
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
      memoryType: patch.memoryType as MemoryEntry["memoryType"] ?? existing.memoryType,
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
    const needsReembed = textChanged ||
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

  // ── archive(id) — 软删除 ────────────────────────────────────

  /**
   * 软删除一条记忆：设置 memory_type = "archived"。
   *
   * 搜索默认排除 archived 类型，`includeArchived: true` 可查。
   * 与 update 一致，失败直接 throw，不走 fallback。
   */
  async archive(id: string): Promise<void> {
    if (this.closed) throw new Error("MilvusSearchManager is closed");
    if (this.degraded) throw new Error("MilvusSearchManager is in degraded mode");

    const rawId = id.trim();
    if (!rawId) throw new Error("Missing memory id");

    const now = new Date().toISOString();
    await this.client.upsert({
      collection_name: this.collectionName,
      data: [{
        [FIELD_ID]: Number(rawId),
        [FIELD_MEMORY_TYPE]: "archived",
        [FIELD_UPDATED_AT]: now,
      }] as unknown as RowData[],
    });
  }

  // ── 写入（MemoryDataBackend.write） ───────────────────────────

  /**
   * 写入一条记忆到 Milvus。
   *
   * 流程：
   * 1. 校验 metadata（sourceLabel / memoryType）
   * 2. 若 degraded 或健康探测失败 → 走 fallback ndjson 兜底
   * 3. 健康 → 先回放 fallback 积压条目，再 embed + insert 新条目
   * 4. 任一环节失败 → 走 fallback，返回占位 MemoryReference
   */
  async write(entry: Omit<MemoryEntry, "id">): Promise<MemoryReference> {
    if (this.closed) throw new Error("MilvusSearchManager is closed");

    // 组装元数据
    const label = (entry.provenance?.label as string) ?? MEMORY_SOURCE_LABELS.CHAT_EXTRACT;
    assertValidSourceLabel(label);
    const memoryType = entry.memoryType ?? MEMORY_TYPES.SHORT_TERM;
    assertValidMemoryType(memoryType);

    const fullEntry: Omit<MemoryEntry, "id"> = {
      text: entry.text,
      snippet: entry.snippet ?? entry.text.slice(0, 200),
      agentId: entry.agentId ?? this.agentId,
      sessionKey: entry.sessionKey, // TODO(Task 16): Host 注入默认 sessionKey
      memoryType,
      recallCount: entry.recallCount ?? 0,
      createdAt: entry.createdAt ?? new Date().toISOString(),
      updatedAt: entry.updatedAt ?? new Date().toISOString(),
      provenance: { kind: entry.provenance?.kind ?? "milvus", label },
    };

    // degraded 或健康探测失败 → 直接 fallback
    if (this.degraded || !(await this.healthCheck())) {
      return this.fallbackWrite(fullEntry);
    }

    // 健康路径：先回放 fallback 积压
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

    // 写入新条目
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
   * embed + insert 一条 MemoryEntry 到 Milvus。
   * 返回 MemoryReference（id 为 Milvus 自增主键）。
   *
   * 入库前按 content_hash 查重：已存在则直接返回已有记录的 MemoryReference，
   * 不重新 embed/insert。
   */
  private async insertEntry(
    entry: Omit<MemoryEntry, "id">,
  ): Promise<MemoryReference> {
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

    // 提取 Milvus 自增主键
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
   * 按 content_hash 查询是否已存在重复记录。
   * 存在时返回已有记录的 MemoryReference，否则返回 null。
   * 存量数据无 content_hash 时靠 provenance_label 兜底不强一致回填。
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
      // 查重失败不阻塞写入
    }
    return null;
  }

  // ── 健康探测 ──────────────────────────────────────────────────

  /** 轻量 Milvus 健康探测（describe_collection） */
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

  // ── 写入兜底 ──────────────────────────────────────────────────

  /** 写入 NDJSON fallback，返回占位 MemoryReference */
  private async fallbackWrite(
    entry: Omit<MemoryEntry, "id">,
  ): Promise<MemoryReference> {
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

  // ── recordRecall 正式实现 ───────────────────────────────────

  /**
   * 批量更新召回计数：query 取当前字段 → 内存累加 recall_count + 写入
   * last_recalled_at → upsert 回 Milvus。
   *
   * 失败策略（§12.7）：失败直接 warnOnce 丢弃，不走 fallback（召回埋点可丢）。
   * 不触发时机：空 refs 短路 / degraded 跳过 / closed 抛错。
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
      // Step 1: query 当前字段（agent 隔离）
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

      // Step 2: 内存累加 recall_count + last_recalled_at
      const upsertRows: Record<string, unknown>[] = [];
      for (const id of ids) {
        const existing = existingMap.get(id);
        const prevCount = existing?.[FIELD_RECALL_COUNT] != null
          ? Number(existing[FIELD_RECALL_COUNT])
          : 0;

        const row: Record<string, unknown> = {
          [FIELD_ID]: id,
          [FIELD_RECALL_COUNT]: prevCount + 1,
          [FIELD_LAST_RECALLED_AT]: now,
          [FIELD_UPDATED_AT]: now,
        };

        // 保留现有字段值（upsert 需提供全部字段，否则可能被清空）
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

      // Step 3: 单次 upsert 写入
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

  // ── Promotion（Deep Dreaming） ──────────────────────────────

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

        // 3. Archive original short_term (upsert memory_type → archived)
        const now = new Date().toISOString();
        await this.client.upsert({
          collection_name: this.collectionName,
          data: [{
            [FIELD_ID]: candidate.id,
            [FIELD_MEMORY_TYPE]: MEMORY_TYPES.ARCHIVED,
            [FIELD_UPDATED_AT]: now,
          }] as unknown as RowData[],
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

  // ── 状态 ──────────────────────────────────────────────────────

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

  // ── 探测 ──────────────────────────────────────────────────────

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

  // ── 生命周期 ──────────────────────────────────────────────────

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
  }
}

// ── 工厂函数 ───────────────────────────────────────────────────────

/**
 * 创建 MilvusClient 实例
 */
export function createMilvusClient(host: string, port: number): MilvusClient {
  const address = host.includes(":") ? host : `${host}:${port}`;
  return new MilvusClient(address);
}
