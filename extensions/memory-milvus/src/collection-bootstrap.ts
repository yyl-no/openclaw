/** Milvus collection lifecycle — eager init with idempotent create/index/load steps. */

import type {
  MilvusClient,
  ResStatus,
  DescribeCollectionResponse,
} from "@zilliz/milvus2-sdk-node";
import type { FieldType } from "@zilliz/milvus2-sdk-node/dist/milvus/types/Collection.js";
import {
  FIELD_AGENT_ID,
  FIELD_CONTENT_HASH,
  FIELD_CREATED_AT,
  FIELD_EMBEDDING,
  FIELD_ID,
  FIELD_LAST_RECALLED_AT,
  FIELD_METADATA,
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
  /** Milvus host for REST create_collection when BM25 Function is enabled. */
  host?: string;
  /** Milvus port for REST create_collection when BM25 Function is enabled. */
  port?: number;
  /** Use HTTPS for Milvus REST calls. */
  ssl?: boolean;
  /** Bearer token for Milvus REST calls. */
  token?: string;
  /** Username used as username:password REST token when token is absent. */
  username?: string;
  /** Password used as username:password REST token when token is absent. */
  password?: string;
  /** Milvus database name. */
  database?: string;
  /** Embedding vector dimension (default 1024) */
  embeddingDim: number;
  /** HNSW M parameter (default 16) */
  hnswM?: number;
  /** HNSW efConstruction (default 200) */
  efConstruction?: number;
  /** Distance metric type (default "COSINE") */
  metricType?: string;
  /** Create optional sparse BM25 index when native BM25 search is enabled. */
  enableSparseIndex?: boolean;
}

const DEFAULT_HNSW_M = 16;
const DEFAULT_EF_CONSTRUCTION = 200;
const DEFAULT_METRIC_TYPE = "COSINE";
const LOAD_POLL_ATTEMPTS = 30;
const LOAD_POLL_INTERVAL_MS = 400;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isCollectionNotLoadedMessage(message: string): boolean {
  return message.includes("collection not loaded");
}

// ── Schema field definitions ──────────────────────────────────────

/**
 * Build the fields array used by create_collection.
 * 15 fields including metadata JSON fallback.
 * enable_dynamic_field is off to keep the schema strict.
 */
function buildCollectionFields(embeddingDim: number, includeSparseField: boolean): FieldType[] {
  const fields: FieldType[] = [
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
      name: FIELD_METADATA,
      data_type: "JSON",
      description: "Extensible metadata for future fields",
    },
  ];
  if (includeSparseField) {
    fields.splice(fields.length - 1, 0, {
      name: FIELD_SPARSE_BM25,
      data_type: "SparseFloatVector",
      nullable: true,
      description: BM25_FIELD_DESCRIPTION,
    } as FieldType);
  }
  return fields;
}

interface MilvusRestCreateField {
  fieldName: string;
  dataType: string;
  isPrimary?: boolean;
  isFunctionOutput?: boolean;
  autoID?: boolean;
  elementTypeParams?: Record<string, string | number | boolean>;
}

interface MilvusRestCreateCollectionPayload {
  dbName?: string;
  collectionName: string;
  schema: {
    autoID?: boolean;
    enabledDynamicField: boolean;
    fields: MilvusRestCreateField[];
    functions: Array<{
      name: string;
      description: string;
      type: "BM25";
      inputFieldNames: [string];
      outputFieldNames: [string];
      params: Record<string, never>;
    }>;
  };
}

function buildBm25RestPayload(config: CollectionBootstrapConfig): MilvusRestCreateCollectionPayload {
  return {
    ...(config.database ? { dbName: config.database } : {}),
    collectionName: config.collectionName,
    schema: {
      autoID: true,
      enabledDynamicField: false,
      fields: [
        { fieldName: FIELD_ID, dataType: "Int64", isPrimary: true, autoID: true },
        {
          fieldName: FIELD_EMBEDDING,
          dataType: "FloatVector",
          elementTypeParams: { dim: config.embeddingDim },
        },
        {
          fieldName: FIELD_TEXT,
          dataType: "VarChar",
          elementTypeParams: {
            max_length: TEXT_MAX_LENGTH,
            enable_analyzer: true,
          },
        },
        {
          fieldName: FIELD_SNIPPET,
          dataType: "VarChar",
          elementTypeParams: { max_length: SNIPPET_MAX_LENGTH },
        },
        {
          fieldName: FIELD_AGENT_ID,
          dataType: "VarChar",
          elementTypeParams: { max_length: AGENT_ID_MAX_LENGTH },
        },
        {
          fieldName: FIELD_SESSION_KEY,
          dataType: "VarChar",
          elementTypeParams: { max_length: SESSION_KEY_MAX_LENGTH },
        },
        {
          fieldName: FIELD_MEMORY_TYPE,
          dataType: "VarChar",
          elementTypeParams: { max_length: MEMORY_TYPE_MAX_LENGTH },
        },
        { fieldName: FIELD_RECALL_COUNT, dataType: "Int32" },
        {
          fieldName: FIELD_PROVENANCE_KIND,
          dataType: "VarChar",
          elementTypeParams: { max_length: PROVENANCE_KIND_MAX_LENGTH },
        },
        {
          fieldName: FIELD_PROVENANCE_LABEL,
          dataType: "VarChar",
          elementTypeParams: { max_length: PROVENANCE_LABEL_MAX_LENGTH },
        },
        {
          fieldName: FIELD_CREATED_AT,
          dataType: "VarChar",
          elementTypeParams: { max_length: TIMESTAMP_MAX_LENGTH },
        },
        {
          fieldName: FIELD_UPDATED_AT,
          dataType: "VarChar",
          elementTypeParams: { max_length: TIMESTAMP_MAX_LENGTH },
        },
        {
          fieldName: FIELD_LAST_RECALLED_AT,
          dataType: "VarChar",
          elementTypeParams: { max_length: TIMESTAMP_MAX_LENGTH },
        },
        {
          fieldName: FIELD_CONTENT_HASH,
          dataType: "VarChar",
          elementTypeParams: { max_length: CONTENT_HASH_MAX_LENGTH },
        },
        { fieldName: FIELD_SPARSE_BM25, dataType: "SparseFloatVector", isFunctionOutput: true },
        { fieldName: FIELD_METADATA, dataType: "JSON" },
      ],
      functions: [
        {
          name: "text_bm25_emb",
          description: "BM25 function for memory text",
          type: "BM25",
          inputFieldNames: [FIELD_TEXT],
          outputFieldNames: [FIELD_SPARSE_BM25],
          params: {},
        },
      ],
    },
  };
}

function milvusRestCollectionEndpoint(
  config: CollectionBootstrapConfig,
  action: "create" | "load",
): string {
  const host = config.host ?? "localhost";
  const hasScheme = /^https?:\/\//i.test(host);
  const base = hasScheme
    ? host
    : `${config.ssl ? "https" : "http"}://${host.includes(":") ? host : `${host}:${config.port ?? 19530}`}`;
  return `${base.replace(/\/+$/, "")}/v2/vectordb/collections/${action}`;
}

function milvusAuthToken(config: CollectionBootstrapConfig): string | undefined {
  if (config.token) return config.token;
  if (config.username && config.password) return `${config.username}:${config.password}`;
  return undefined;
}

function hasExplicitMilvusRestTarget(config: CollectionBootstrapConfig): boolean {
  return (
    config.host != null ||
    config.port != null ||
    config.ssl != null ||
    config.token != null ||
    config.username != null ||
    config.database != null
  );
}

async function createBm25CollectionViaRest(config: CollectionBootstrapConfig): Promise<void> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Request-Timeout": "30",
  };
  const authToken = milvusAuthToken(config);
  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }

  const response = await fetch(milvusRestCollectionEndpoint(config, "create"), {
    method: "POST",
    headers,
    body: JSON.stringify(buildBm25RestPayload(config)),
  });
  const bodyText = await response.text();
  let body: Record<string, unknown> | null = null;
  if (bodyText) {
    try {
      body = JSON.parse(bodyText) as Record<string, unknown>;
    } catch {
      body = null;
    }
  }
  const code = typeof body?.code === "number" ? body.code : response.ok ? 0 : response.status;
  const okCode = code === 0 || code === 200;
  if (!response.ok || !okCode) {
    const message =
      typeof body?.message === "string" && body.message
        ? body.message
        : bodyText || response.statusText || `HTTP ${response.status}`;
    throw new Error(`Failed to create BM25 collection "${config.collectionName}": ${message}`);
  }
}

async function loadCollectionViaRest(config: CollectionBootstrapConfig): Promise<void> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Request-Timeout": "30",
  };
  const authToken = milvusAuthToken(config);
  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }
  const response = await fetch(milvusRestCollectionEndpoint(config, "load"), {
    method: "POST",
    headers,
    body: JSON.stringify({
      ...(config.database ? { dbName: config.database } : {}),
      collectionName: config.collectionName,
    }),
  });
  const bodyText = await response.text();
  let body: Record<string, unknown> | null = null;
  if (bodyText) {
    try {
      body = JSON.parse(bodyText) as Record<string, unknown>;
    } catch {
      body = null;
    }
  }
  const code = typeof body?.code === "number" ? body.code : response.ok ? 0 : response.status;
  const okCode = code === 0 || code === 200;
  if (!response.ok || !okCode) {
    const message =
      typeof body?.message === "string" && body.message
        ? body.message
        : bodyText || response.statusText || `HTTP ${response.status}`;
    throw new Error(`Failed to start loading collection "${config.collectionName}": ${message}`);
  }
}

// ── Idempotent detection helpers ──────────────────────────────────

/**
 * Check collection existence through the SDK helper. The SDK implements this
 * with a fresh DescribeCollection RPC and avoids the describe cache.
 */
async function hasCollection(client: MilvusClient, collectionName: string): Promise<boolean> {
  try {
    const res = await client.hasCollection({ collection_name: collectionName });
    const status = res.status;
    if (status?.error_code === "Success" || status?.error_code === "0") {
      return Boolean(res.value);
    }
    if (status?.error_code === "CollectionNotExists") {
      return false;
    }
    throw new Error(
      `Failed to check collection "${collectionName}": ${status?.reason ?? status?.error_code ?? "unknown error"}`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      message.includes("CollectionNotExists") ||
      message.includes("collection not found") ||
      message === "not found"
    ) {
      return false;
    }
    throw err;
  }
}

/**
 * Try describeCollection; return null if the collection does not exist.
 * Milvus may report not-found through status.error_code instead of throwing.
 */
async function tryDescribe(
  client: MilvusClient,
  collectionName: string,
): Promise<DescribeCollectionResponse | null> {
  const exists = await hasCollection(client, collectionName);
  if (!exists) {
    return null;
  }

  const res = await client.describeCollection({ collection_name: collectionName, cache: false });
  const status = res.status;
  if (status?.error_code === "Success" || status?.error_code === "0") {
    return res;
  }
  throw new Error(
    `Failed to describe collection "${collectionName}": ${status?.reason ?? status?.error_code ?? "unknown error"}`,
  );
}

async function ensureCollectionExists(
  client: MilvusClient,
  config: CollectionBootstrapConfig,
): Promise<void> {
  const collectionName = config.collectionName;
  const existing = await tryDescribe(client, collectionName);
  if (existing) {
    return;
  }

  if (config.enableSparseIndex) {
    await createBm25CollectionViaRest(config);
    return;
  }

  const fields = buildCollectionFields(config.embeddingDim, config.enableSparseIndex === true);
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

async function collectionLoadState(client: MilvusClient, collectionName: string): Promise<string> {
  try {
    const res = await client.getLoadState({ collection_name: collectionName });
    return res.state;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      message.includes("CollectionNotExists") ||
      message.includes("collection not found") ||
      message === "not found"
    ) {
      return "LoadStateNotExist";
    }
    if (isCollectionNotLoadedMessage(message)) {
      return "LoadStateNotLoad";
    }
    throw err;
  }
}

async function loadCollectionIntoMemory(
  client: MilvusClient,
  config: CollectionBootstrapConfig,
): Promise<void> {
  const collectionName = config.collectionName;
  const loadReq = {
    collection_name: collectionName,
    replica_number: 1,
    refresh: true,
  };
  const asyncLoader = (client as unknown as {
    loadCollectionAsync?: (req: typeof loadReq) => Promise<ResStatus>;
  }).loadCollectionAsync;

  let restErr: unknown = null;
  if (hasExplicitMilvusRestTarget(config)) {
    try {
      await loadCollectionViaRest(config);
    } catch (err) {
      restErr = err;
    }
  }
  if (restErr) {
    if (typeof asyncLoader === "function") {
      const res = await asyncLoader.call(client, loadReq);
      if (res.error_code !== "Success" && res.error_code !== "0") {
        const reason = res.reason ?? res.error_code;
        const restMessage = restErr instanceof Error ? restErr.message : String(restErr);
        throw new Error(
          `Failed to start loading collection "${collectionName}": ${reason}; REST fallback failed: ${restMessage}`,
        );
      }
    } else {
      try {
        await client.loadCollection(loadReq);
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!isCollectionNotLoadedMessage(message)) {
          throw err;
        }
      }
    }
  } else if (!hasExplicitMilvusRestTarget(config)) {
    if (typeof asyncLoader === "function") {
      const res = await asyncLoader.call(client, loadReq);
      if (res.error_code !== "Success" && res.error_code !== "0") {
        throw new Error(
          `Failed to start loading collection "${collectionName}": ${res.reason ?? res.error_code}`,
        );
      }
    } else {
      try {
        await client.loadCollection(loadReq);
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!isCollectionNotLoadedMessage(message)) {
          throw err;
        }
      }
    }
  }

  for (let attempt = 0; attempt < LOAD_POLL_ATTEMPTS; attempt += 1) {
    const state = await collectionLoadState(client, collectionName);
    if (state === "LoadStateLoaded") {
      return;
    }
    await sleep(LOAD_POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for collection "${collectionName}" to load`);
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
    for (const description of res.index_descriptions ?? []) {
      const record = description as unknown as Record<string, unknown>;
      const indexName = String(record.index_name ?? record.indexName ?? "");
      const indexedField = String(record.field_name ?? record.fieldName ?? record.field ?? "");
      if (indexedField) {
        if (indexedField === fieldName) return indexName || fieldName;
        continue;
      }
      if (indexName === `${collectionName}_${fieldName}_idx` || indexName.includes(fieldName)) {
        return indexName;
      }
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

  await ensureCollectionExists(client, config);

  // Step 1: Collection — idempotent create
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
  if (config.enableSparseIndex) {
    const existingSparseIndex = await tryDescribeIndex(client, collectionName, FIELD_SPARSE_BM25);
    if (!existingSparseIndex) {
      const sparseIndexRes: ResStatus = await client.createIndex({
        collection_name: collectionName,
        field_name: FIELD_SPARSE_BM25,
        index_name: `${collectionName}_sparse_bm25_idx`,
        index_type: "SPARSE_INVERTED_INDEX",
        metric_type: "IP",
        params: {
          inverted_index_algo: "DAAT_MAXSCORE",
        },
      });
      if (sparseIndexRes.error_code !== "Success" && sparseIndexRes.error_code !== "0") {
        throw new Error(
          `Failed to create sparse index on "${FIELD_SPARSE_BM25}": ${sparseIndexRes.reason ?? sparseIndexRes.error_code}`,
        );
      }
    }
  }

  // Step 4: Load — ensure loaded into memory
  const loadState = await collectionLoadState(client, collectionName);
  if (loadState !== "LoadStateLoaded") {
    await loadCollectionIntoMemory(client, config);
  }
}
