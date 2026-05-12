/**
 * memory-milvus 类型契约与常量枚举
 *
 * 依据：1-plan.md §Task10-S1 + 2-decisions.md §12.2/12.3
 *
 * - 所有写入路径共享同一个溯源标签字典和记忆类型枚举
 * - 越界即抛错，杜绝运行时静默污染数据
 */

// ── 溯源标签 ──────────────────────────────────────────────────────

/** 记忆来源标签常量。`memory_write` 工具入口强校验越界。 */
export const MEMORY_SOURCE_LABELS = {
  /** AI flush turn 提取的记忆 */
  CHAT_EXTRACT: "chat_extract",
  /** 用户通过 UI 手动添加 */
  USER_MANUAL: "user_manual",
  /** Dreaming promotion 升级产生 */
  RECALL_PROMOTION: "recall_promotion",
  /** 老数据迁移导入 */
  IMPORT: "import",
} as const;

/** 从常量派生的溯源标签联合类型 */
export type MemorySourceLabel =
  (typeof MEMORY_SOURCE_LABELS)[keyof typeof MEMORY_SOURCE_LABELS];

/** 所有合法 source label 的 value 集合（供校验快速查找） */
const VALID_SOURCE_LABELS: ReadonlySet<string> = new Set(
  Object.values(MEMORY_SOURCE_LABELS),
);

/**
 * 校验 source label 是否在合法枚举内，越界立即抛错。
 * label 由代码路径注入而非用户输入，越界即 bug，应早暴露。
 */
export function assertValidSourceLabel(label: string): asserts label is MemorySourceLabel {
  if (!VALID_SOURCE_LABELS.has(label)) {
    throw new Error(
      `Invalid memory source label: "${label}". ` +
      `Expected one of: ${[...VALID_SOURCE_LABELS].join(", ")}`,
    );
  }
}

// ── 记忆类型 ──────────────────────────────────────────────────────

/** 记忆生命周期类型常量 */
export const MEMORY_TYPES = {
  /** 会话级短期记忆 */
  SHORT_TERM: "short_term",
  /** 经 promotion 升级后的长期记忆 */
  LONG_TERM: "long_term",
  /** 软删除归档 */
  ARCHIVED: "archived",
} as const;

/** 从常量派生的记忆类型联合 */
export type MemoryType = (typeof MEMORY_TYPES)[keyof typeof MEMORY_TYPES];

const VALID_MEMORY_TYPES: ReadonlySet<string> = new Set(
  Object.values(MEMORY_TYPES),
);

/** 校验 memory_type 是否合法，越界抛错 */
export function assertValidMemoryType(t: string): asserts t is MemoryType {
  if (!VALID_MEMORY_TYPES.has(t)) {
    throw new Error(
      `Invalid memory type: "${t}". ` +
      `Expected one of: ${[...VALID_MEMORY_TYPES].join(", ")}`,
    );
  }
}

// ── Metadata 组装类型 ─────────────────────────────────────────────

/**
 * write() 入口组装元数据时使用的中间类型。
 *
 * 来源分工（见 2-decisions.md §12.2）：
 * - agentId     → Host 注入
 * - sessionKey  → Host/Manager 注入
 * - memoryType  → Manager 默认 "short_term"
 * - createdAt   → Manager UTC 毫秒数
 * - provenance.label → Tool/Manager 注入
 */
export interface MilvusMemoryEntryMetadata {
  agentId: string;
  sessionKey?: string;
  memoryType: MemoryType;
  createdAt: number;
  provenance: {
    label: MemorySourceLabel;
  };
}
