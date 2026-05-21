/** Milvus collection schema definition and row-type mappers. */

import { createHash } from "node:crypto";
import type { MemoryEntry, MemoryReference } from "openclaw/plugin-sdk/memory-core-host-engine-storage";

// ── Content hash ──────────────────────────────────────────────────

/**
 * Compute SHA-256 content dedup hash: SHA-256(text + "\0" + provenance_label).
 * provenance_label defaults to empty string when undefined.
 */
export function computeContentHash(text: string, provenanceLabel?: string): string {
  const label = provenanceLabel ?? "";
  return createHash("sha256").update(`${text}\0${label}`).digest("hex");
}

// ── Field name constants ───────────────────────────────────────────

export const FIELD_ID = "id";
export const FIELD_EMBEDDING = "embedding";
export const FIELD_TEXT = "text";
export const FIELD_SNIPPET = "snippet";
export const FIELD_AGENT_ID = "agent_id";
export const FIELD_SESSION_KEY = "session_key";
export const FIELD_MEMORY_TYPE = "memory_type";
export const FIELD_RECALL_COUNT = "recall_count";
export const FIELD_PROVENANCE_KIND = "provenance_kind";
export const FIELD_PROVENANCE_LABEL = "provenance_label";
export const FIELD_CREATED_AT = "created_at";
export const FIELD_UPDATED_AT = "updated_at";
export const FIELD_LAST_RECALLED_AT = "last_recalled_at";
export const FIELD_CONTENT_HASH = "content_hash";
export const FIELD_SPARSE_BM25 = "sparse_bm25";
export const FIELD_METADATA = "metadata";

/** All schema field names (including internal vector fields). */
export const ALL_SCHEMA_FIELDS = [
  FIELD_ID,
  FIELD_EMBEDDING,
  FIELD_TEXT,
  FIELD_SNIPPET,
  FIELD_AGENT_ID,
  FIELD_SESSION_KEY,
  FIELD_MEMORY_TYPE,
  FIELD_RECALL_COUNT,
  FIELD_PROVENANCE_KIND,
  FIELD_PROVENANCE_LABEL,
  FIELD_CREATED_AT,
  FIELD_UPDATED_AT,
  FIELD_LAST_RECALLED_AT,
  FIELD_CONTENT_HASH,
] as const;

// ── Schema config constants ────────────────────────────────────────

/** Default collection name */
export const DEFAULT_COLLECTION_NAME = "openclaw_memory";

/** Default embedding dimension (text-embedding-v3) */
export const DEFAULT_EMBEDDING_DIM = 1024;

/** Default Milvus gRPC port */
export const DEFAULT_MILVUS_PORT = 19530;

/** text field max length (Milvus VarChar upper bound) */
export const TEXT_MAX_LENGTH = 65535;

/** snippet field max length (4KB) */
export const SNIPPET_MAX_LENGTH = 4096;

/** agent_id field max length */
export const AGENT_ID_MAX_LENGTH = 256;

/** session_key field max length */
export const SESSION_KEY_MAX_LENGTH = 512;

/** memory_type field max length */
export const MEMORY_TYPE_MAX_LENGTH = 32;

/** provenance_kind field max length */
export const PROVENANCE_KIND_MAX_LENGTH = 32;

/** provenance_label field max length */
export const PROVENANCE_LABEL_MAX_LENGTH = 1024;

/** content_hash field max length (SHA-256 hex = 64 chars) */
export const CONTENT_HASH_MAX_LENGTH = 64;

/** BM25 sparse vector field description */
export const BM25_FIELD_DESCRIPTION = "BM25 sparse vector (requires server-side BM25 Function)";

/** Timestamp field max length (ISO 8601) */
export const TIMESTAMP_MAX_LENGTH = 32;

// ── Output field subset (excludes embedding to reduce wire size) ───

/** Fields returned by search — embedding is excluded. */
export const OUTPUT_FIELDS = ALL_SCHEMA_FIELDS.filter(
  (f) => f !== FIELD_EMBEDDING,
);

// ── Type mappers ──────────────────────────────────────────────────

/**
 * Map a Milvus row to a MemoryReference.
 * Score is left at 0 — the search layer sets it at runtime.
 */
export function rowToMemoryReference(row: Record<string, unknown>): MemoryReference {
  const id = String(row[FIELD_ID] ?? "");
  return {
    id,
    snippet: String(row[FIELD_SNIPPET] ?? ""),
    score: 0,
    provenance: {
      kind: (String(row[FIELD_PROVENANCE_KIND] ?? "milvus")) as "milvus",
      label: String(row[FIELD_PROVENANCE_LABEL] ?? `Milvus #${id}`),
    },
  };
}

/**
 * Map a Milvus row to a MemoryEntry.
 * Used for get(id) result mapping.
 */
export function rowToMemoryEntry(row: Record<string, unknown>): MemoryEntry {
  const id = String(row[FIELD_ID] ?? "");
  return {
    id,
    text: String(row[FIELD_TEXT] ?? ""),
    snippet: row[FIELD_SNIPPET] != null ? String(row[FIELD_SNIPPET]) : undefined,
    agentId: row[FIELD_AGENT_ID] != null ? String(row[FIELD_AGENT_ID]) : undefined,
    sessionKey: row[FIELD_SESSION_KEY] != null ? String(row[FIELD_SESSION_KEY]) : undefined,
    memoryType:
      row[FIELD_MEMORY_TYPE] != null
        ? (String(row[FIELD_MEMORY_TYPE]) as MemoryEntry["memoryType"])
        : undefined,
    recallCount:
      row[FIELD_RECALL_COUNT] != null ? Number(row[FIELD_RECALL_COUNT]) : undefined,
    createdAt:
      row[FIELD_CREATED_AT] != null ? String(row[FIELD_CREATED_AT]) : undefined,
    updatedAt:
      row[FIELD_UPDATED_AT] != null ? String(row[FIELD_UPDATED_AT]) : undefined,
    provenance: {
      kind: (String(row[FIELD_PROVENANCE_KIND] ?? "milvus")) as "milvus",
      label: String(row[FIELD_PROVENANCE_LABEL] ?? `Milvus #${id}`),
    },
  };
}

/**
 * Map a MemoryEntry (without id) to a Milvus insert data object.
 * The embedding vector is attached by the caller before insert.
 */
export function entryToInsertData(
  entry: Omit<MemoryEntry, "id">,
): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    [FIELD_TEXT]: entry.text,
    [FIELD_SNIPPET]: entry.snippet ?? entry.text.slice(0, SNIPPET_MAX_LENGTH),
    [FIELD_AGENT_ID]: entry.agentId ?? "",
    [FIELD_SESSION_KEY]: entry.sessionKey ?? "",
    [FIELD_MEMORY_TYPE]: entry.memoryType ?? "short_term",
    [FIELD_RECALL_COUNT]: entry.recallCount ?? 0,
    [FIELD_PROVENANCE_KIND]: entry.provenance?.kind ?? "milvus",
    [FIELD_PROVENANCE_LABEL]:
      entry.provenance?.label ?? "",
    [FIELD_CREATED_AT]: entry.createdAt ?? now,
    [FIELD_UPDATED_AT]: entry.updatedAt ?? now,
    [FIELD_LAST_RECALLED_AT]: "",
    [FIELD_CONTENT_HASH]: computeContentHash(entry.text, entry.provenance?.label),
    [FIELD_METADATA]: {},
  };
}
