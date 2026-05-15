/** Milvus collection lifecycle — eager init with idempotent create/index/load steps. */

import { MilvusClient, type ResStatus, type DescribeCollectionResponse } from "@zilliz/milvus2-sdk-node";
import type { FieldType } from "@zilliz/milvus2-sdk-node/dist/milvus/types/Collection.js";
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
  AGENT_ID_MAX_LENGTH,
  BM25_FIELD_DESCRIPTION,
  CONTENT_HASH_MAX_LENGTH,
  MEMORY_TYPE_MAX_LENGTH,
  PROVENANCE_KIND_MAX_LENGTH,
  PROVENANCE_LABEL_MAX_LENGTH,
  SESSION_KEY_MAX_LENGTH,
  SNIPPET_MAX_LENGTH,
  TEXT_MAX_LENGTH,
  TIMESTAMP_MAX_LENGTH,
} from "./schema.js";

// ── Config ────────────────────────────────────────────────────────

/** Collection bootstrap configuration — HNSW params read from plugin config. */
export interface CollectionBootstrapConfig {
  collectionName: string;
  /** Embedding vector dimension (default 1024) */
  embeddingDim: number;
  /** HNSW M parameter (default 16) */
  hnswM?: number;
  /** HNSW efConstruction (default 200) */
  efConstruction?: number;
  /** Distance metric type (default "COSINE") */
  metricType?: string;
}

const DEFAULT_HNSW_M = 16;
const DEFAULT_EF_CONSTRUCTION = 200;
const DEFAULT_METRIC_TYPE = "COSINE";

// ── Schema field definitions ──────────────────────────────────────

/** Extensible metadata field (JSON type, for future expansion). */
const FIELD_METADATA = "metadata";

/**
 * Build the fields array used by create_collection.
 * 15 fields including metadata JSON fallback.
 * enable_dynamic_field is off to keep the schema strict.
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
      name: FIELD_LAST_RECALLED_AT,
      data_type: "VarChar",
      type_params: { max_length: String(TIMESTAMP_MAX_LENGTH) },
      description: "ISO 8601 last recall timestamp (β)",
    },
    {
      name: FIELD_CONTENT_HASH,
      data_type: "VarChar",
      type_params: { max_length: String(CONTENT_HASH_MAX_LENGTH) },
      description: "SHA-256 content hash for dedup (text + provenance_label)",
    },
    {
      name: FIELD_SPARSE_BM25,
      data_type: "SparseFloatVector",
      description: BM25_FIELD_DESCRIPTION,
    },
    {
      name: FIELD_METADATA,
      data_type: "JSON",
      description: "Extensible metadata for future fields",
    },
  ];
}

// ── Idempotent detection helpers ──────────────────────────────────

/**
 * Try describeCollection; return null if the collection does not exist.
 * Catches all exceptions (network errors, not-found, etc.) and returns null.
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
 * Check if an index exists on the given field.
 * Returns the index name if found, null otherwise.
 */
async function tryDescribeIndex(
  client: MilvusClient,
  collectionName: string,
  fieldName: string = FIELD_EMBEDDING,
): Promise<string | null> {
  try {
    const res = await client.describeIndex({
      collection_name: collectionName,
      field_name: fieldName,
    });
    if (res.index_descriptions?.length > 0) {
      return res.index_descriptions[0]!.index_name;
    }
    return null;
  } catch {
    return null;
  }
}

// ── Main entry ────────────────────────────────────────────────────

/**
 * Eager init: ensure the collection exists, indexes are built, and the
 * collection is loaded into memory.
 *
 * Three idempotent steps:
 * 1. describe → create if missing
 * 2. describe_index → create_index (HNSW) if missing
 * 3. describe_index (sparse) → create_index (SPARSE_INVERTED_INDEX) if missing
 * 4. get_load_state → load_collection if not loaded
 *
 * Any step may throw; the caller decides degradation strategy.
 */
export async function ensureCollectionReady(
  client: MilvusClient,
  config: CollectionBootstrapConfig,
): Promise<void> {
  const collectionName = config.collectionName;
  const m = config.hnswM ?? DEFAULT_HNSW_M;
  const ef = config.efConstruction ?? DEFAULT_EF_CONSTRUCTION;
  const metric = config.metricType ?? DEFAULT_METRIC_TYPE;

  // Step 1: Collection — idempotent create
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

  // Step 2: Index — idempotent HNSW create
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

  // Step 3: Sparse index (BM25) — idempotent create
  const existingSparseIndex = await tryDescribeIndex(client, collectionName, FIELD_SPARSE_BM25);
  if (!existingSparseIndex) {
    const sparseIndexRes: ResStatus = await client.createIndex({
      collection_name: collectionName,
      field_name: FIELD_SPARSE_BM25,
      index_name: `${collectionName}_sparse_bm25_idx`,
      index_type: "SPARSE_INVERTED_INDEX",
      metric_type: metric,
      params: {},
    });
    if (sparseIndexRes.error_code !== "Success" && sparseIndexRes.error_code !== "0") {
      throw new Error(
        `Failed to create sparse index on "${FIELD_SPARSE_BM25}": ${sparseIndexRes.reason ?? sparseIndexRes.error_code}`,
      );
    }
  }

  // Step 4: Load — ensure loaded into memory
  const loadState = await client.getLoadState({ collection_name: collectionName });
  if (loadState.state !== "LoadStateLoaded") {
    await client.loadCollection({
      collection_name: collectionName,
      replica_number: 1,
      refresh: true,
    });
  }
}
