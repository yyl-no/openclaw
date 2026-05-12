/**
 * Milvus Collection 生命周期管理
 *
 * 依据：1-plan.md §Task10-S2 + 2-decisions.md §12.1/12.6
 *
 * Eager init 原子化三步：create_collection → create_index → load_collection
 * 每步幂等，已存在不视作错误。
 */

import { MilvusClient, type ResStatus, type DescribeCollectionResponse } from "@zilliz/milvus2-sdk-node";
import type { FieldType } from "@zilliz/milvus2-sdk-node/dist/milvus/types/Collection.js";
import {
  FIELD_AGENT_ID,
  FIELD_CREATED_AT,
  FIELD_EMBEDDING,
  FIELD_ID,
  FIELD_MEMORY_TYPE,
  FIELD_PROVENANCE_KIND,
  FIELD_PROVENANCE_LABEL,
  FIELD_RECALL_COUNT,
  FIELD_SESSION_KEY,
  FIELD_SNIPPET,
  FIELD_TEXT,
  FIELD_UPDATED_AT,
  AGENT_ID_MAX_LENGTH,
  MEMORY_TYPE_MAX_LENGTH,
  PROVENANCE_KIND_MAX_LENGTH,
  PROVENANCE_LABEL_MAX_LENGTH,
  SESSION_KEY_MAX_LENGTH,
  SNIPPET_MAX_LENGTH,
  TEXT_MAX_LENGTH,
  TIMESTAMP_MAX_LENGTH,
} from "./schema.js";

// ── Config ────────────────────────────────────────────────────────

/** Collection 初始化配置，HNSW 参数从插件 config 读取 */
export interface CollectionBootstrapConfig {
  /** Milvus collection 名称 */
  collectionName: string;
  /** embedding 向量维度（默认 1024） */
  embeddingDim: number;
  /** HNSW M 参数（默认 16） */
  hnswM?: number;
  /** HNSW efConstruction 参数（默认 200） */
  efConstruction?: number;
  /** 距离度量类型（默认 "COSINE"） */
  metricType?: string;
}

const DEFAULT_HNSW_M = 16;
const DEFAULT_EF_CONSTRUCTION = 200;
const DEFAULT_METRIC_TYPE = "COSINE";

// ── Schema 字段定义 ───────────────────────────────────────────────

/** 元数据兜底字段名（JSON 类型，用于未来扩展） */
const FIELD_METADATA = "metadata";

/**
 * 构建 create_collection 所需的 fields 数组。
 * Task 8 Schema 12 字段 + metadata JSON 兜底字段。
 * 不启用 enable_dynamic_field，保持 schema 可控。
 */
function buildCollectionFields(embeddingDim: number): FieldType[] {
  return [
    {
      name: FIELD_ID,
      data_type: "Int64",
      is_primary_key: true,
      autoID: true,
      description: "Auto-increment primary key",
    },
    {
      name: FIELD_EMBEDDING,
      data_type: "FloatVector",
      type_params: { dim: String(embeddingDim) },
      description: "1024-dim text embedding vector",
    },
    {
      name: FIELD_TEXT,
      data_type: "VarChar",
      type_params: { max_length: String(TEXT_MAX_LENGTH) },
      description: "Full memory content (max 64KB)",
    },
    {
      name: FIELD_SNIPPET,
      data_type: "VarChar",
      type_params: { max_length: String(SNIPPET_MAX_LENGTH) },
      description: "Search preview snippet (max 4KB)",
    },
    {
      name: FIELD_AGENT_ID,
      data_type: "VarChar",
      type_params: { max_length: String(AGENT_ID_MAX_LENGTH) },
      description: "Agent identifier for logical isolation",
    },
    {
      name: FIELD_SESSION_KEY,
      data_type: "VarChar",
      type_params: { max_length: String(SESSION_KEY_MAX_LENGTH) },
      description: "Session identifier",
    },
    {
      name: FIELD_MEMORY_TYPE,
      data_type: "VarChar",
      type_params: { max_length: String(MEMORY_TYPE_MAX_LENGTH) },
      description: "short_term / long_term / archived",
    },
    {
      name: FIELD_RECALL_COUNT,
      data_type: "Int32",
      description: "Recall frequency counter",
    },
    {
      name: FIELD_PROVENANCE_KIND,
      data_type: "VarChar",
      type_params: { max_length: String(PROVENANCE_KIND_MAX_LENGTH) },
      description: "Provenance kind (milvus)",
    },
    {
      name: FIELD_PROVENANCE_LABEL,
      data_type: "VarChar",
      type_params: { max_length: String(PROVENANCE_LABEL_MAX_LENGTH) },
      description: "Human-readable source description",
    },
    {
      name: FIELD_CREATED_AT,
      data_type: "VarChar",
      type_params: { max_length: String(TIMESTAMP_MAX_LENGTH) },
      description: "ISO 8601 creation timestamp",
    },
    {
      name: FIELD_UPDATED_AT,
      data_type: "VarChar",
      type_params: { max_length: String(TIMESTAMP_MAX_LENGTH) },
      description: "ISO 8601 update timestamp",
    },
    {
      name: FIELD_METADATA,
      data_type: "JSON",
      description: "Extensible metadata for future fields",
    },
  ];
}

// ── 幂等探测辅助 ──────────────────────────────────────────────────

/**
 * 尝试 describeCollection，不存在则返回 null。
 * catch 所有异常（网络错误、collection 不存在等）统一返回 null。
 */
async function tryDescribe(
  client: MilvusClient,
  collectionName: string,
): Promise<DescribeCollectionResponse | null> {
  try {
    return await client.describeCollection({ collection_name: collectionName });
  } catch {
    return null;
  }
}

/**
 * 探测 index 是否已在 embedding 字段上存在。
 * 返回已存在的 index 名称，不存在则返回 null。
 */
async function tryDescribeIndex(
  client: MilvusClient,
  collectionName: string,
): Promise<string | null> {
  try {
    const res = await client.describeIndex({
      collection_name: collectionName,
      field_name: FIELD_EMBEDDING,
    });
    if (res.index_descriptions?.length > 0) {
      return res.index_descriptions[0]!.index_name;
    }
    return null;
  } catch {
    return null;
  }
}

// ── 主入口 ────────────────────────────────────────────────────────

/**
 * Eager init：确保 Collection 存在、索引就绪、已加载。
 *
 * 三步原子化，每步幂等：
 * 1. describe → 不存在则 create
 * 2. describe_index → 不存在则 create_index (HNSW)
 * 3. get_load_state → 未 loaded 则 load
 *
 * 任一步失败抛出异常，由调用方决定降级策略。
 */
export async function ensureCollectionReady(
  client: MilvusClient,
  config: CollectionBootstrapConfig,
): Promise<void> {
  const collectionName = config.collectionName;
  const m = config.hnswM ?? DEFAULT_HNSW_M;
  const ef = config.efConstruction ?? DEFAULT_EF_CONSTRUCTION;
  const metric = config.metricType ?? DEFAULT_METRIC_TYPE;

  // Step 1: Collection — 幂等创建
  const existing = await tryDescribe(client, collectionName);
  if (!existing) {
    const fields = buildCollectionFields(config.embeddingDim);
    const createRes: ResStatus = await client.createCollection({
      collection_name: collectionName,
      fields,
      enable_dynamic_field: false,
    });
    if (createRes.error_code !== "Success" && createRes.error_code !== "0") {
      throw new Error(
        `Failed to create collection "${collectionName}": ${createRes.reason ?? createRes.error_code}`,
      );
    }
  }

  // Step 2: Index — 幂等创建 HNSW
  const existingIndex = await tryDescribeIndex(client, collectionName);
  if (!existingIndex) {
    const indexRes: ResStatus = await client.createIndex({
      collection_name: collectionName,
      field_name: FIELD_EMBEDDING,
      index_name: `${collectionName}_embedding_idx`,
      index_type: "HNSW",
      metric_type: metric,
      params: {
        M: String(m),
        efConstruction: String(ef),
      },
    });
    if (indexRes.error_code !== "Success" && indexRes.error_code !== "0") {
      throw new Error(
        `Failed to create index on "${FIELD_EMBEDDING}": ${indexRes.reason ?? indexRes.error_code}`,
      );
    }
  }

  // Step 3: Load — 确保 loaded
  const loadState = await client.getLoadState({ collection_name: collectionName });
  if (loadState.state !== "LoadStateLoaded") {
    await client.loadCollection({
      collection_name: collectionName,
      replica_number: 1,
      refresh: true,
    });
  }
}
