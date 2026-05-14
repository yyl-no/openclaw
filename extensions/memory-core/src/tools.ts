import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { MemorySource } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  asToolParamsRecord,
  jsonResult,
  readNumberParam,
  readStringParam,
  type MemoryCorpusSearchResult,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type {
  MemoryDataBackend,
  MemoryReference,
  MemorySearchResult,
  MemorySearchRuntimeDebug,
} from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import {
  resolveMemoryCorePluginConfig,
  resolveMemoryDeepDreamingConfig,
} from "openclaw/plugin-sdk/memory-core-host-status";
import { filterMemorySearchHitsBySessionVisibility } from "./session-search-visibility.js";
import {
  clampResultsByInjectedChars,
  decorateCitations,
  resolveMemoryCitationsMode,
  shouldIncludeCitations,
} from "./tools.citations.js";
import {
  buildMemorySearchUnavailableResult,
  createMemoryTool,
  getMemoryCorpusSupplementResult,
  getMemoryManagerContext,
  getMemoryManagerContextWithPurpose,
  loadMemoryToolRuntime,
  MemoryGetSchema,
  MemorySearchSchema,
  searchMemoryCorpusSupplements,
} from "./tools.shared.js";

type MemorySearchToolResult =
  | (Record<string, unknown> & { corpus: "memory"; score: number; path: string; id?: string })
  | MemoryCorpusSearchResult;

function sortMemorySearchToolResults<T extends { score: number; path: string }>(results: T[]): T[] {
  return results.toSorted((left, right) => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }
    return left.path.localeCompare(right.path);
  });
}

function mergeMemorySearchCorpusResults(params: {
  memoryResults: MemorySearchToolResult[];
  supplementResults: MemorySearchToolResult[];
  maxResults: number;
  balanceCorpora: boolean;
}): MemorySearchToolResult[] {
  const memoryResults = sortMemorySearchToolResults(params.memoryResults);
  const supplementResults = sortMemorySearchToolResults(params.supplementResults);
  if (!params.balanceCorpora || memoryResults.length === 0 || supplementResults.length === 0) {
    return sortMemorySearchToolResults([...memoryResults, ...supplementResults]).slice(
      0,
      params.maxResults,
    );
  }

  const perCorpusCap = Math.ceil(params.maxResults / 2);
  const selectedMemory = memoryResults.slice(0, perCorpusCap);
  const selectedSupplements = supplementResults.slice(0, perCorpusCap);
  const selected = [...selectedMemory, ...selectedSupplements];
  if (selected.length < params.maxResults) {
    selected.push(
      ...sortMemorySearchToolResults([
        ...memoryResults.slice(selectedMemory.length),
        ...supplementResults.slice(selectedSupplements.length),
      ]).slice(0, params.maxResults - selected.length),
    );
  }

  return sortMemorySearchToolResults(selected).slice(0, params.maxResults);
}

function buildRecallKey(
  result: { id: string } | Pick<MemorySearchResult, "source" | "path" | "startLine" | "endLine">,
): string {
  if ("id" in result && result.id) return result.id;
  const r = result as MemorySearchResult;
  return `${r.source}:${r.path}:${r.startLine}:${r.endLine}`;
}

function resolveRecallTrackingResults<T extends { id?: string; source?: string; path?: string; startLine?: number; endLine?: number }>(
  rawResults: T[],
  surfacedResults: T[],
): T[] {
  if (surfacedResults.length === 0 || rawResults.length === 0) {
    return surfacedResults;
  }
  const rawByKey = new Map<string, T>();
  for (const raw of rawResults) {
    const key = buildRecallKey(raw as any);
    if (!rawByKey.has(key)) {
      rawByKey.set(key, raw);
    }
  }
  return surfacedResults.map((surfaced) => rawByKey.get(buildRecallKey(surfaced as any)) ?? surfaced);
}

function queueShortTermRecallTracking(params: {
  recordRecall?: (refs: MemoryReference[], context?: { query: string; timezone?: string }) => void;
  query: string;
  rawResults: MemoryReference[];
  surfacedResults: MemoryReference[];
  timezone?: string;
}): void {
  const trackingResults = resolveRecallTrackingResults(params.rawResults, params.surfacedResults);
  if (params.recordRecall) {
    void Promise.resolve()
      .then(() => params.recordRecall!(trackingResults as MemoryReference[], {
        query: params.query,
        timezone: params.timezone,
      }))
      .catch(() => {
        // Recall tracking is best-effort and must never block memory recall.
      });
    return;
  }
  // Fallback for backends without recordRecall.
}

function normalizeActiveMemoryQmdSearchMode(
  value: unknown,
): "inherit" | "search" | "vsearch" | "query" {
  return value === "inherit" || value === "search" || value === "vsearch" || value === "query"
    ? value
    : "search";
}

function isActiveMemorySessionKey(sessionKey?: string): boolean {
  return typeof sessionKey === "string" && sessionKey.includes(":active-memory:");
}

function resolveActiveMemoryQmdSearchModeOverride(
  cfg: OpenClawConfig,
  sessionKey?: string,
): "search" | "vsearch" | "query" | undefined {
  if (!isActiveMemorySessionKey(sessionKey)) {
    return undefined;
  }
  const entry = cfg.plugins?.entries?.["active-memory"];
  const entryRecord =
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? (entry as { config?: unknown })
      : undefined;
  const pluginConfig =
    entryRecord?.config &&
    typeof entryRecord.config === "object" &&
    !Array.isArray(entryRecord.config)
      ? (entryRecord.config as { qmd?: { searchMode?: unknown } })
      : undefined;
  const searchMode = normalizeActiveMemoryQmdSearchMode(pluginConfig?.qmd?.searchMode);
  return searchMode === "inherit" ? undefined : searchMode;
}

async function getSupplementMemoryReadResult(params: {
  relPath: string;
  from?: number;
  lines?: number;
  agentSessionKey?: string;
  corpus?: "memory" | "wiki" | "all";
}) {
  const supplement = await getMemoryCorpusSupplementResult({
    lookup: params.relPath,
    fromLine: params.from,
    lineCount: params.lines,
    agentSessionKey: params.agentSessionKey,
    corpus: params.corpus,
  });
  if (!supplement) {
    return null;
  }
  const { content, ...rest } = supplement;
  return {
    ...rest,
    text: content,
  };
}

async function resolveMemoryReadFailureResult(params: {
  error: unknown;
  requestedCorpus?: "memory" | "wiki" | "all";
  relPath: string;
  from?: number;
  lines?: number;
  agentSessionKey?: string;
}) {
  if (params.requestedCorpus === "all") {
    const supplement = await getSupplementMemoryReadResult({
      relPath: params.relPath,
      from: params.from,
      lines: params.lines,
      agentSessionKey: params.agentSessionKey,
      corpus: params.requestedCorpus,
    });
    if (supplement) {
      return jsonResult(supplement);
    }
  }
  const message = formatErrorMessage(params.error);
  return jsonResult({ path: params.relPath, text: "", disabled: true, error: message });
}

async function executeMemoryReadResult<T>(params: {
  read: () => Promise<T>;
  requestedCorpus?: "memory" | "wiki" | "all";
  relPath: string;
  from?: number;
  lines?: number;
  agentSessionKey?: string;
}) {
  try {
    return jsonResult(await params.read());
  } catch (error) {
    return await resolveMemoryReadFailureResult({
      error,
      requestedCorpus: params.requestedCorpus,
      relPath: params.relPath,
      from: params.from,
      lines: params.lines,
      agentSessionKey: params.agentSessionKey,
    });
  }
}

export function createMemorySearchTool(options: {
  config?: OpenClawConfig;
  getConfig?: () => OpenClawConfig | undefined;
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
}) {
  return createMemoryTool({
    options,
    label: "Memory Search",
    name: "memory_search",
    description:
      "Mandatory recall step: semantically search MEMORY.md + memory/*.md (and optional session transcripts) before answering questions about prior work, decisions, dates, people, preferences, or todos. Optional `corpus=wiki` or `corpus=all` also searches registered compiled-wiki supplements. `corpus=memory` restricts hits to indexed memory files (excludes session transcript chunks from ranking). `corpus=sessions` restricts hits to indexed session transcripts (same visibility rules as session history tools). If response has disabled=true, memory retrieval is unavailable and should be surfaced to the user.",
    parameters: MemorySearchSchema,
    execute:
      ({ cfg, agentId }) =>
      async (_toolCallId, params) => {
        const rawParams = asToolParamsRecord(params);
        const query = readStringParam(rawParams, "query", { required: true });
        const maxResults = readNumberParam(rawParams, "maxResults");
        const minScore = readNumberParam(rawParams, "minScore");
        const requestedCorpus = readStringParam(rawParams, "corpus") as
          | "memory"
          | "wiki"
          | "all"
          | "sessions"
          | undefined;
        const { resolveMemoryBackendConfig } = await loadMemoryToolRuntime();
        const shouldQueryMemory = requestedCorpus !== "wiki";
        const shouldQuerySupplements = requestedCorpus === "wiki" || requestedCorpus === "all";
        const memory = shouldQueryMemory ? await getMemoryManagerContext({ cfg, agentId }) : null;
        if (shouldQueryMemory && memory && "error" in memory && !shouldQuerySupplements) {
          return jsonResult(buildMemorySearchUnavailableResult(memory.error));
        }
        try {
          const citationsMode = resolveMemoryCitationsMode(cfg);
          const includeCitations = shouldIncludeCitations({
            mode: citationsMode,
            sessionKey: options.agentSessionKey,
          });
          const searchStartedAt = Date.now();
          let rawResults: MemoryReference[] = [];
          let surfacedMemoryResults: Array<
            Record<string, unknown> & { corpus: "memory"; score: number; path: string }
          > = [];
          let provider: string | undefined;
          let model: string | undefined;
          let fallback: unknown;
          let searchMode: string | undefined;
          let searchDebug:
            | {
                backend: string;
                configuredMode?: string;
                effectiveMode?: string;
                fallback?: string;
                searchMs: number;
                hits: number;
              }
            | undefined;
          if (shouldQueryMemory && memory && !("error" in memory)) {
            const runtimeDebug: MemorySearchRuntimeDebug[] = [];
            const qmdSearchModeOverride = resolveActiveMemoryQmdSearchModeOverride(
              cfg,
              options.agentSessionKey,
            );
            const searchSources: MemorySource[] | undefined =
              requestedCorpus === "sessions"
                ? (["sessions"] as MemorySource[])
                : requestedCorpus === "memory"
                  ? (["memory"] as MemorySource[])
                  : undefined;
            rawResults = (await memory.manager.search(query, {
              maxResults,
              minScore,
              sessionKey: options.agentSessionKey,
              qmdSearchModeOverride,
              onDebug: (debug) => {
                runtimeDebug.push(debug);
              },
              ...(searchSources ? { sources: searchSources } : {}),
            })) as MemoryReference[];
            rawResults = (await filterMemorySearchHitsBySessionVisibility({
              cfg,
              requesterSessionKey: options.agentSessionKey,
              sandboxed: options.sandboxed === true,
              hits: rawResults,
            })) as MemoryReference[];
            if (requestedCorpus === "sessions") {
              rawResults = rawResults.filter((hit) => hit.source === "sessions");
            } else if (requestedCorpus === "memory") {
              rawResults = rawResults.filter((hit) => hit.source === "memory");
            }
            const status = memory.manager.status();
            const decorated = decorateCitations(rawResults, includeCitations);
            const resolved = resolveMemoryBackendConfig({ cfg, agentId });
            const memoryResults =
              status.backend === "qmd"
                ? clampResultsByInjectedChars(decorated, resolved.qmd?.limits.maxInjectedChars)
                : decorated;
            surfacedMemoryResults = memoryResults.map((result) => {
              const displayPath = result.provenance?.label ?? result.id ?? "";
              return {
                ...result,
                corpus: "memory" as const,
                path: displayPath,
              };
            });
            const sleepTimezone = resolveMemoryDeepDreamingConfig({
              pluginConfig: resolveMemoryCorePluginConfig(cfg),
              cfg,
            }).timezone;
            queueShortTermRecallTracking({
              recordRecall: (refs, ctx) => { void memory.manager.recordRecall?.(refs, ctx); },
              query,
              rawResults,
              surfacedResults: memoryResults as MemoryReference[],
              timezone: sleepTimezone,
            });
            provider = status.provider;
            model = status.model;
            fallback = status.fallback;
            const latestDebug = runtimeDebug.at(-1);
            searchMode = latestDebug?.effectiveMode;
            searchDebug = {
              backend: status.backend,
              configuredMode: latestDebug?.configuredMode,
              effectiveMode:
                status.backend === "qmd"
                  ? (latestDebug?.effectiveMode ?? latestDebug?.configuredMode)
                  : "n/a",
              fallback: latestDebug?.fallback,
              searchMs: Math.max(0, Date.now() - searchStartedAt),
              hits: rawResults.length,
            };
          }
          const supplementResults = shouldQuerySupplements
            ? await searchMemoryCorpusSupplements({
                query,
                maxResults,
                agentSessionKey: options.agentSessionKey,
                corpus: requestedCorpus,
              })
            : [];
          // Wiki and memory scores use incomparable scales, so corpus=all first
          // balances candidate selection and then backfills any unused slots.
          const effectiveMax = Math.max(1, maxResults ?? 10);
          const results = mergeMemorySearchCorpusResults({
            memoryResults: surfacedMemoryResults,
            supplementResults,
            maxResults: effectiveMax,
            balanceCorpora: requestedCorpus === "all",
          });
          return jsonResult({
            results,
            provider,
            model,
            fallback,
            citations: citationsMode,
            mode: searchMode,
            debug: searchDebug,
          });
        } catch (err) {
          const message = formatErrorMessage(err);
          return jsonResult(buildMemorySearchUnavailableResult(message));
        }
      },
  });
}

export function createMemoryGetTool(options: {
  config?: OpenClawConfig;
  getConfig?: () => OpenClawConfig | undefined;
  agentId?: string;
  agentSessionKey?: string;
}) {
  return createMemoryTool({
    options,
    label: "Memory Get",
    name: "memory_get",
    description:
      "Safe exact excerpt read from MEMORY.md or memory/*.md. Defaults to a bounded excerpt when lines are omitted, includes truncation/continuation info when more content exists, and `corpus=wiki` reads from registered compiled-wiki supplements.",
    parameters: MemoryGetSchema,
    execute:
      ({ cfg, agentId }) =>
      async (_toolCallId, params) => {
        const rawParams = asToolParamsRecord(params);
        const rawPath = readStringParam(rawParams, "path");
        const idParam = readStringParam(rawParams, "id");
        let relPath: string;
        let from: number | undefined;
        let lines: number | undefined;
        if (idParam) {
          // Parse file://id into path+line range
          if (!idParam.startsWith("file:")) {
            return jsonResult({ error: `Invalid id format: ${idParam}` });
          }
          const parsed = idParam.slice("file:".length);
          const lastColon1 = parsed.lastIndexOf(":");
          const lastColon2 = parsed.lastIndexOf(":", lastColon1 - 1);
          if (lastColon2 < 0) {
            return jsonResult({ error: `Invalid file id format: ${idParam}` });
          }
          relPath = parsed.slice(0, lastColon2);
          from = Number(parsed.slice(lastColon2 + 1, lastColon1));
          const endLine = Number(parsed.slice(lastColon1 + 1));
          lines = endLine - from + 1;
        } else if (rawPath) {
          relPath = rawPath;
          from = readNumberParam(rawParams, "from", { integer: true });
          lines = readNumberParam(rawParams, "lines", { integer: true });
        } else {
          return jsonResult({ error: "path or id is required" });
        }
        const requestedCorpus = readStringParam(rawParams, "corpus") as
          | "memory"
          | "wiki"
          | "all"
          | undefined;
        const { readAgentMemoryFile, resolveMemoryBackendConfig } = await loadMemoryToolRuntime();
        if (requestedCorpus === "wiki") {
          const supplement = await getSupplementMemoryReadResult({
            relPath,
            from: from ?? undefined,
            lines: lines ?? undefined,
            agentSessionKey: options.agentSessionKey,
            corpus: requestedCorpus,
          });
          return jsonResult(
            supplement ?? {
              path: relPath,
              text: "",
              disabled: true,
              error: "wiki corpus result not found",
            },
          );
        }
        const resolved = resolveMemoryBackendConfig({ cfg, agentId });
        if (resolved.backend === "builtin") {
          return await executeMemoryReadResult({
            read: async () =>
              await readAgentMemoryFile({
                cfg,
                agentId,
                relPath,
                from: from ?? undefined,
                lines: lines ?? undefined,
              }),
            requestedCorpus,
            relPath,
            from: from ?? undefined,
            lines: lines ?? undefined,
            agentSessionKey: options.agentSessionKey,
          });
        }
        const memory = await getMemoryManagerContextWithPurpose({
          cfg,
          agentId,
          purpose: "status",
        });
        if ("error" in memory) {
          return jsonResult({ path: relPath, text: "", disabled: true, error: memory.error });
        }
        return await executeMemoryReadResult({
          read: async () =>
            await memory.manager.readFile({
              relPath,
              from: from ?? undefined,
              lines: lines ?? undefined,
            }),
          requestedCorpus,
          relPath,
          from: from ?? undefined,
          lines: lines ?? undefined,
          agentSessionKey: options.agentSessionKey,
        });
      },
  });
}

export function createMemoryWriteTool(options: {
  config?: OpenClawConfig;
  getConfig?: () => OpenClawConfig | undefined;
  agentId?: string;
  agentSessionKey?: string;
}) {
  return createMemoryTool({
    options,
    label: "Memory Write",
    name: "memory_write",
    description:
      "Write a memory entry extracted from the conversation. " +
      "Use this to persist facts, decisions, preferences, and learnings. " +
      "Each entry is stored with text content and an optional source label.",
    parameters: {
      type: "object" as const,
      properties: {
        text: { type: "string" as const },
        label: { type: "string" as const },
      },
      required: ["text"],
    } as unknown as typeof MemoryGetSchema,
    execute:
      ({ cfg, agentId }) =>
      async (_toolCallId, params) => {
        const rawParams = asToolParamsRecord(params);
        const text = readStringParam(rawParams, "text", { required: true });
        const label = readStringParam(rawParams, "label") || "chat_extract";

        const memory = await getMemoryManagerContext({ cfg, agentId });
        if (!memory || "error" in memory) {
          const error = memory && "error" in memory ? memory.error : "memory search unavailable";
          return jsonResult({ error: error ?? "memory search unavailable" });
        }

        try {
          const ref = await (memory.manager as unknown as MemoryDataBackend).write({
            text,
            provenance: { kind: "file", label },
          });
          return jsonResult({
            id: ref.id,
            label,
          });
        } catch (err) {
          const message = formatErrorMessage(err);
          return jsonResult({ error: message });
        }
      },
  });
}
