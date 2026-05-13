/**
 * Milvus Collection Schema 定义
 *
 * 依据：1-plan.md §Task8 + 2-decisions.md §9
 *
 * 与 MemoryEntry / MemoryReference 的字段映射：
 * ┌──────────────────────┬─────────────────────┬──────────────────────┐
 * │ Milvus 字段           │ MemoryEntry          │ MemoryReference       │
 * ├──────────────────────┼─────────────────────┼──────────────────────┤
 * │ id (Int64, PK)       │ id (string)          │ id (string)          │
 * │ embedding (1024维)    │ — (内部使用)          │ — (内部使用)          │
 * │ text (VarChar 64KB)  │ text                 │ —                    │
 * │ snippet (VarChar 4KB)│ snippet              │ snippet              │
 * │ agent_id             │ agentId              │ —                    │
 * │ session_key          │ sessionKey           │ —                    │
 * │ memory_type          │ memoryType           │ —                    │
 * │ recall_count         │ recallCount          │ —                    │
 * │ provenance_kind      │ provenance.kind      │ provenance.kind      │
 * │ provenance_label     │ provenance.label     │ provenance.label     │
 * │ created_at           │ createdAt            │ —                    │
 * │ updated_at           │ updatedAt            │ —                    │
 * │ score                │ —                    │ score (运行时计算)     │
 * └──────────────────────┴─────────────────────┴──────────────────────┘
 */

import type { MemoryEntry, MemoryReference } from "openclaw/plugin-sdk/memory-core-host-engine-storage";

// ── Milvus 字段名常量 ──────────────────────────────────────────────

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

/** 所有字段名集合 */
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
] as const;

// ── Schema 配置常量 ────────────────────────────────────────────────

/** 默认 Collection 名称 */
export const DEFAULT_COLLECTION_NAME = "openclaw_memory";

/** 默认 embedding 维度（阿里云 text-embedding-v3） */
export const DEFAULT_EMBEDDING_DIM = 1024;

/** Milvus 默认 gRPC 端口 */
export const DEFAULT_MILVUS_PORT = 19530;

/** text 字段最大长度 */
export const TEXT_MAX_LENGTH = 65536;

/** snippet 字段最大长度 */
export const SNIPPET_MAX_LENGTH = 4096;

/** agent_id 字段最大长度 */
export const AGENT_ID_MAX_LENGTH = 256;

/** session_key 字段最大长度 */
export const SESSION_KEY_MAX_LENGTH = 512;

/** memory_type 字段最大长度 */
export const MEMORY_TYPE_MAX_LENGTH = 32;

/** provenance_kind 字段最大长度 */
export const PROVENANCE_KIND_MAX_LENGTH = 32;

/** provenance_label 字段最大长度 */
export const PROVENANCE_LABEL_MAX_LENGTH = 1024;

/** 时间戳字段最大长度（ISO 8601 格式） */
export const TIMESTAMP_MAX_LENGTH = 32;

// ── 输出字段子集（不含 embedding）──────────────────────────────────

/** search 返回时不需要的字段（排除 embedding 以减小传输） */
export const OUTPUT_FIELDS = ALL_SCHEMA_FIELDS.filter(
  (f) => f !== FIELD_EMBEDDING,
);

// ── 类型映射辅助 ──────────────────────────────────────────────────

/**
 * Milvus 行数据 → MemoryReference
 * 用于 search 结果映射。
 */
export function rowToMemoryReference(row: Record<string, unknown>): MemoryReference {
  const id = String(row[FIELD_ID] ?? "");
  return {
    id,
    snippet: String(row[FIELD_SNIPPET] ?? ""),
    score: 0, // 由搜索层在运行时设置
    provenance: {
      kind: (String(row[FIELD_PROVENANCE_KIND] ?? "milvus")) as "milvus",
      label: String(row[FIELD_PROVENANCE_LABEL] ?? `Milvus #${id}`),
    },
  };
}

/**
 * Milvus 行数据 → MemoryEntry
 * 用于 get(id) 结果映射。
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
 * MemoryEntry (不含 id) → Milvus insert 数据对象
 * 返回纯 JSON 对象，embedding 由调用方在 insert 前附加。
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
  };
}
