export type MemorySource = "memory" | "sessions";

/** @deprecated Use `MemoryReference` instead. */
export type MemorySearchResult = {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  vectorScore?: number;
  textScore?: number;
  snippet: string;
  source: MemorySource;
  citation?: string;
};

/** New: search result with backend-neutral id */
export type MemoryReference = {
  id: string;
  snippet: string;
  score: number;
  vectorScore?: number;
  textScore?: number;
  source?: MemorySource;
  provenance: {
    kind: "file" | "milvus";
    label: string;
  };
};

export type MemoryEmbeddingProbeResult = {
  ok: boolean;
  error?: string;
  checked?: boolean;
  cached?: boolean;
  checkedAtMs?: number;
  cacheExpiresAtMs?: number;
};

export type MemorySyncProgressUpdate = {
  completed: number;
  total: number;
  label?: string;
};

export type MemorySearchRuntimeDebug = {
  backend: "builtin" | "qmd";
  configuredMode?: string;
  effectiveMode?: string;
  fallback?: string;
};

/** @deprecated Use `MemoryEntry` instead. */
export type MemoryReadResult = {
  text: string;
  path: string;
  truncated?: boolean;
  from?: number;
  lines?: number;
  nextFrom?: number;
};

/** New: backend-neutral memory entry */
export type MemoryEntry = {
  id: string;
  text: string;
  snippet?: string;
  agentId?: string;
  sessionKey?: string;
  memoryType?: "short_term" | "long_term" | "archived";
  recallCount?: number;
  createdAt?: string;
  updatedAt?: string;
  provenance: {
    kind: "file" | "milvus";
    label: string;
  };
};

export type MemoryProviderStatus = {
  backend: "builtin" | "qmd";
  provider: string;
  model?: string;
  requestedProvider?: string;
  files?: number;
  chunks?: number;
  dirty?: boolean;
  workspaceDir?: string;
  dbPath?: string;
  extraPaths?: string[];
  sources?: MemorySource[];
  sourceCounts?: Array<{ source: MemorySource; files: number; chunks: number }>;
  cache?: { enabled: boolean; entries?: number; maxEntries?: number };
  fts?: { enabled: boolean; available: boolean; error?: string };
  fallback?: { from: string; reason?: string };
  vector?: {
    enabled: boolean;
    storeAvailable?: boolean;
    semanticAvailable?: boolean;
    available?: boolean;
    extensionPath?: string;
    loadError?: string;
    dims?: number;
  };
  batch?: {
    enabled: boolean;
    failures: number;
    limit: number;
    wait: boolean;
    concurrency: number;
    pollIntervalMs: number;
    timeoutMs: number;
    lastError?: string;
    lastProvider?: string;
  };
  custom?: Record<string, unknown>;
};

/** @deprecated Use `MemoryDataBackend` instead. */
export interface MemorySearchManager {
  search(
    query: string,
    opts?: {
      maxResults?: number;
      minScore?: number;
      sessionKey?: string;
      qmdSearchModeOverride?: "query" | "search" | "vsearch";
      onDebug?: (debug: MemorySearchRuntimeDebug) => void;
      sources?: MemorySource[];
    },
  ): Promise<MemorySearchResult[]>;
  readFile(params: { relPath: string; from?: number; lines?: number }): Promise<MemoryReadResult>;
  status(): MemoryProviderStatus;
  sync?(params?: {
    reason?: string;
    force?: boolean;
    sessionFiles?: string[];
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void>;
  getCachedEmbeddingAvailability?(): MemoryEmbeddingProbeResult | null;
  probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult>;
  probeVectorStoreAvailability?(): Promise<boolean>;
  probeVectorAvailability(): Promise<boolean>;
  close?(): Promise<void>;
}

/** New: unified memory data backend interface */
export interface MemoryDataBackend {
  search(
    query: string,
    opts?: {
      maxResults?: number;
      minScore?: number;
      sessionKey?: string;
      agentId?: string;
      sources?: MemorySource[];
    },
  ): Promise<MemoryReference[]>;
  get(id: string): Promise<MemoryEntry>;
  write(entry: Omit<MemoryEntry, "id">): Promise<MemoryReference>;
  recordRecall(refs: MemoryReference[], context?: { query: string; timezone?: string }): Promise<void>;
  rankPromotionCandidates(opts: {
    limit?: number;
    minScore?: number;
    minRecallCount?: number;
    minUniqueQueries?: number;
    maxAgeDays?: number;
    recencyHalfLifeDays?: number;
    nowMs?: number;
  }): Promise<PromotionCandidate[]>;
  applyPromotions(opts: {
    candidates: PromotionCandidate[];
    limit?: number;
    minScore?: number;
    minRecallCount?: number;
    minUniqueQueries?: number;
    maxAgeDays?: number;
    timezone?: string;
    nowMs?: number;
  }): Promise<{ applied: number; appliedCandidates: PromotionCandidate[] }>;
  status(): MemoryProviderStatus;
  sync?(params?: {
    reason?: string;
    force?: boolean;
    sessionFiles?: string[];
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void>;
  close?(): Promise<void>;
}

export interface PromotionCandidate {
  id: string;
  snippet: string;
  score: number;
  recallCount: number;
  uniqueQueries: number;
}
