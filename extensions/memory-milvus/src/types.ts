/** Memory provenance label constants. `memory_write` validates at entry. */
export const MEMORY_SOURCE_LABELS = {
  /** AI flush turn extracted memory */
  CHAT_EXTRACT: "chat_extract",
  /** User manually added via UI */
  USER_MANUAL: "user_manual",
  /** Produced by dreaming promotion */
  RECALL_PROMOTION: "recall_promotion",
  /** Imported from legacy data migration */
  IMPORT: "import",
} as const;

/** Union of valid source label values. */
export type MemorySourceLabel =
  (typeof MEMORY_SOURCE_LABELS)[keyof typeof MEMORY_SOURCE_LABELS];

/** Valid label lookup set for fast validation. */
const VALID_SOURCE_LABELS: ReadonlySet<string> = new Set(
  Object.values(MEMORY_SOURCE_LABELS),
);

/** Validate a source label — throws on invalid values. */
export function assertValidSourceLabel(label: string): asserts label is MemorySourceLabel {
  if (!VALID_SOURCE_LABELS.has(label)) {
    throw new Error(
      `Invalid memory source label: "${label}". ` +
      `Expected one of: ${[...VALID_SOURCE_LABELS].join(", ")}`,
    );
  }
}

/** Memory lifecycle type constants. */
export const MEMORY_TYPES = {
  /** Session-scoped short-term memory */
  SHORT_TERM: "short_term",
  /** Promoted long-term memory */
  LONG_TERM: "long_term",
  /** Soft-deleted (archived) */
  ARCHIVED: "archived",
} as const;

/** Union of valid memory type values. */
export type MemoryType = (typeof MEMORY_TYPES)[keyof typeof MEMORY_TYPES];

const VALID_MEMORY_TYPES: ReadonlySet<string> = new Set(
  Object.values(MEMORY_TYPES),
);

/** Validate a memory type — throws on invalid values. */
export function assertValidMemoryType(t: string): asserts t is MemoryType {
  if (!VALID_MEMORY_TYPES.has(t)) {
    throw new Error(
      `Invalid memory type: "${t}". ` +
      `Expected one of: ${[...VALID_MEMORY_TYPES].join(", ")}`,
    );
  }
}

/** Intermediate metadata type assembled at write() entry. */
export interface MilvusMemoryEntryMetadata {
  agentId: string;
  sessionKey?: string;
  memoryType: MemoryType;
  createdAt: number;
  provenance: {
    label: MemorySourceLabel;
  };
}
