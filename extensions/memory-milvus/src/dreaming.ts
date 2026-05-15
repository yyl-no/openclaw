/**
 * Dreaming 调度编排 — Milvus 后端
 *
 * 依据：1-plan.md §Task13 + 2-decisions.md §12.3
 *
 * 与 memory-core 的 dreaming.ts 同构：
 * - gateway_start → 对账 cron job
 * - before_agent_reply → 检测 dreaming 触发令牌 → 执行 sweep
 * - /dreaming 命令 → 手动启停/运行
 *
 * 差异：
 * - 不走文件系统 recall entry 扫描，改查 Milvus 标量过滤
 * - promotions 通过 manager.applyPromotions() 写入 Milvus
 * - Narrative 暂不生成（deferred），只完成 rank + apply
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { MilvusSearchManager } from "./search.js";

// ── Inlined string helpers (avoid missing SDK barrel in global install) ──

function normalizeTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeLowercaseStringOrEmpty(
  value: string | undefined | null,
): string {
  return (value ?? "").toLowerCase();
}

// ── 常量 ──────────────────────────────────────────────────────────

const MANAGED_DREAMING_CRON_NAME = "milvus:short-term-dreaming";
const MANAGED_DREAMING_CRON_TAG = "[memory-milvus:dreaming]";
const DREAMING_SYSTEM_EVENT_TEXT =
  "[system-dreaming] Run the scheduled Milvus dreaming pipeline. " +
  "Use memory_search to find the top short-term recall candidates, " +
  "then apply promotions to graduate them to long-term memory.";

// ── 默认配置 ──────────────────────────────────────────────────────

const DEFAULT_DREAMING_CRON = "0 3 * * *";
const DEFAULT_DREAMING_LIMIT = 5;
const DEFAULT_DREAMING_MIN_SCORE = 0.3;
const DEFAULT_DREAMING_MIN_RECALL_COUNT = 2;
const DEFAULT_DREAMING_MIN_UNIQUE_QUERIES = 2;
const DEFAULT_DREAMING_RECENCY_HALF_LIFE_DAYS = 30;

const STARTUP_CRON_RETRY_DELAY_MS = 250;
const STARTUP_CRON_RETRY_MAX_ATTEMPTS = 5;
const RUNTIME_CRON_RECONCILE_INTERVAL_MS = 30_000;

// ── 类型 ──────────────────────────────────────────────────────────

type CronServiceLike = {
  list: (opts?: { includeDisabled?: boolean }) => Promise<ManagedCronJobLike[]>;
  add: (input: ManagedCronJobCreate) => Promise<unknown>;
  update: (id: string, patch: ManagedCronJobPatch) => Promise<unknown>;
  remove: (id: string) => Promise<{ removed?: boolean }>;
};

type ManagedCronJobLike = {
  id: string;
  name?: string;
  description?: string;
  enabled?: boolean;
  schedule?: { kind?: string; expr?: string; tz?: string };
  sessionTarget?: string;
  wakeMode?: string;
  payload?: { kind?: string; text?: string; message?: string; lightContext?: boolean };
  delivery?: { mode?: string };
  createdAtMs?: number;
};

type ManagedCronJobCreate = Omit<ManagedCronJobLike, "id" | "createdAtMs"> & {
  name: string;
  description: string;
  enabled: boolean;
  schedule: { kind: string; expr: string; tz?: string };
  wakeMode: string;
  payload: { kind: string; message: string; lightContext: boolean };
  delivery: { mode: string };
};

type ManagedCronJobPatch = Partial<
  Pick<
    ManagedCronJobLike,
    "name" | "description" | "enabled" | "schedule" | "sessionTarget" | "wakeMode" | "payload" | "delivery"
  >
>;

type ShortTermPromotionDreamingConfig = {
  enabled: boolean;
  cron: string;
  timezone?: string;
  limit: number;
  minScore: number;
  minRecallCount: number;
  minUniqueQueries: number;
  recencyHalfLifeDays: number;
  maxAgeDays?: number;
  verboseLogging: boolean;
};

type Logger = Pick<OpenClawPluginApi["logger"], "info" | "warn" | "error" | "debug">;

type ReconcileResult =
  | { status: "unavailable"; removed: number }
  | { status: "disabled"; removed: number }
  | { status: "added"; removed: number }
  | { status: "updated"; removed: number }
  | { status: "noop"; removed: number };

// ── Manager resolver（由 index.ts 注入，避免循环 import） ──────

type ManagerResolver = (
  cfg: OpenClawConfig,
  agentId: string,
) => Promise<MilvusSearchManager | null>;

let resolveManager: ManagerResolver | null = null;

export function setDreamingManagerResolver(
  fn: ManagerResolver,
): void {
  resolveManager = fn;
}

// ── Config 解析 ───────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function resolveMemoryMilvusPluginConfig(
  cfg: OpenClawConfig,
): Record<string, unknown> | undefined {
  const entry = asRecord(cfg.plugins?.entries?.["memory-milvus"]);
  return asRecord(entry?.config);
}

export function resolveShortTermPromotionDreamingConfig(params: {
  pluginConfig?: Record<string, unknown>;
  cfg?: OpenClawConfig;
}): ShortTermPromotionDreamingConfig {
  const pc =
    params.pluginConfig ??
    (params.cfg ? resolveMemoryMilvusPluginConfig(params.cfg) : undefined);
  const dreaming = asRecord(pc?.dreaming) ?? {};

  return {
    enabled: Boolean(dreaming.enabled ?? false),
    cron: String(dreaming.cron || DEFAULT_DREAMING_CRON),
    ...(dreaming.timezone ? { timezone: String(dreaming.timezone) } : {}),
    limit: Number(dreaming.limit ?? DEFAULT_DREAMING_LIMIT),
    minScore: Number(dreaming.minScore ?? DEFAULT_DREAMING_MIN_SCORE),
    minRecallCount: Number(dreaming.minRecallCount ?? DEFAULT_DREAMING_MIN_RECALL_COUNT),
    minUniqueQueries:
      Number(dreaming.minUniqueQueries ?? DEFAULT_DREAMING_MIN_UNIQUE_QUERIES),
    recencyHalfLifeDays:
      Number(dreaming.recencyHalfLifeDays ?? DEFAULT_DREAMING_RECENCY_HALF_LIFE_DAYS),
    ...(dreaming.maxAgeDays != null
      ? { maxAgeDays: Number(dreaming.maxAgeDays) }
      : {}),
    verboseLogging: Boolean(dreaming.verboseLogging ?? false),
  };
}

// ── Cron 服务解析 ─────────────────────────────────────────────────

function resolveCronServiceFromCandidate(
  candidate: unknown,
): CronServiceLike | null {
  if (!candidate || typeof candidate !== "object") return null;
  const cron = candidate as Partial<CronServiceLike>;
  if (
    typeof cron.list === "function" &&
    typeof cron.add === "function" &&
    typeof cron.update === "function" &&
    typeof cron.remove === "function"
  ) {
    return cron as CronServiceLike;
  }
  return null;
}

function resolveCronServiceFromGatewayContext(
  ctx: { getCron?: () => unknown } | undefined,
): CronServiceLike | null {
  return resolveCronServiceFromCandidate(ctx?.getCron?.());
}

// ── Cron job 构建 / 检测 ─────────────────────────────────────────

function resolveManagedCronDescription(
  config: ShortTermPromotionDreamingConfig,
): string {
  return (
    `${MANAGED_DREAMING_CRON_TAG} Promote weighted short-term recalls into long_term ` +
    `(limit=${config.limit}, minScore=${config.minScore.toFixed(3)}, ` +
    `minRecallCount=${config.minRecallCount}, recencyHalfLifeDays=${config.recencyHalfLifeDays}, ` +
    `maxAgeDays=${config.maxAgeDays ?? "none"}).`
  );
}

function buildManagedDreamingCronJob(
  config: ShortTermPromotionDreamingConfig,
): ManagedCronJobCreate {
  return {
    name: MANAGED_DREAMING_CRON_NAME,
    description: resolveManagedCronDescription(config),
    enabled: true,
    schedule: {
      kind: "cron",
      expr: config.cron,
      ...(config.timezone ? { tz: config.timezone } : {}),
    },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: {
      kind: "agentTurn",
      message: DREAMING_SYSTEM_EVENT_TEXT,
      lightContext: true,
    },
    delivery: {
      mode: "none",
    },
  };
}

function isManagedDreamingJob(job: ManagedCronJobLike): boolean {
  const description = normalizeTrimmedString(job.description);
  if (description?.includes(MANAGED_DREAMING_CRON_TAG)) return true;
  const name = normalizeTrimmedString(job.name);
  const payloadText = normalizeTrimmedString(job.payload?.message);
  return (
    name === MANAGED_DREAMING_CRON_NAME &&
    payloadText === DREAMING_SYSTEM_EVENT_TEXT
  );
}

function compareOptionalStrings(
  a: string | undefined,
  b: string | undefined,
): boolean {
  return a === b;
}

function buildManagedDreamingPatch(
  job: ManagedCronJobLike,
  desired: ManagedCronJobCreate,
): ManagedCronJobPatch | null {
  const patch: ManagedCronJobPatch = {};

  if (!compareOptionalStrings(normalizeTrimmedString(job.name), desired.name)) {
    patch.name = desired.name;
  }
  if (
    !compareOptionalStrings(
      normalizeTrimmedString(job.description),
      desired.description,
    )
  ) {
    patch.description = desired.description;
  }
  if (job.enabled !== true) {
    patch.enabled = true;
  }

  const scheduleKind = normalizeLowercaseStringOrEmpty(
    normalizeTrimmedString(job.schedule?.kind),
  );
  const scheduleExpr = normalizeTrimmedString(job.schedule?.expr);
  const scheduleTz = normalizeTrimmedString(job.schedule?.tz);
  if (
    scheduleKind !== "cron" ||
    !compareOptionalStrings(scheduleExpr, desired.schedule.expr) ||
    !compareOptionalStrings(scheduleTz, desired.schedule.tz)
  ) {
    patch.schedule = desired.schedule;
  }

  const sessionTarget = normalizeLowercaseStringOrEmpty(
    normalizeTrimmedString(job.sessionTarget),
  );
  if (sessionTarget !== desired.sessionTarget) {
    patch.sessionTarget = desired.sessionTarget;
  }
  const wakeMode = normalizeLowercaseStringOrEmpty(
    normalizeTrimmedString(job.wakeMode),
  );
  if (wakeMode !== "now") {
    patch.wakeMode = "now";
  }

  const payloadKind = normalizeLowercaseStringOrEmpty(
    normalizeTrimmedString(job.payload?.kind),
  );
  const payloadMessage = normalizeTrimmedString(job.payload?.message);
  if (
    payloadKind !== "agentturn" ||
    !compareOptionalStrings(payloadMessage, desired.payload.message) ||
    job.payload?.lightContext !== desired.payload.lightContext
  ) {
    patch.payload = desired.payload;
  }

  const deliveryMode = normalizeLowercaseStringOrEmpty(
    normalizeTrimmedString(job.delivery?.mode),
  );
  if (deliveryMode !== "none") {
    patch.delivery = desired.delivery;
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

// ── Cron 对账 ─────────────────────────────────────────────────────

async function reconcileShortTermDreamingCronJob(params: {
  cron: CronServiceLike | null;
  config: ShortTermPromotionDreamingConfig;
  logger: Logger;
}): Promise<ReconcileResult> {
  const cron = params.cron;
  if (!cron) {
    return { status: "unavailable", removed: 0 };
  }

  const allJobs = await cron.list({ includeDisabled: true });
  const managed = allJobs.filter(isManagedDreamingJob);

  if (!params.config.enabled) {
    let removed = 0;
    for (const job of managed) {
      try {
        const result = await cron.remove(job.id);
        if (result.removed === true) removed += 1;
      } catch {
        // Ignore per-job errors
      }
    }
    if (removed > 0) {
      params.logger.info(
        `memory-milvus: removed ${removed} managed dreaming cron job(s).`,
      );
    }
    return { status: "disabled", removed };
  }

  const desired = buildManagedDreamingCronJob(params.config);
  if (managed.length === 0) {
    await cron.add(desired);
    params.logger.info("memory-milvus: created managed dreaming cron job.");
    return { status: "added", removed: 0 };
  }

  // Deduplicate: keep first, remove rest
  const sorted = managed.toSorted((a, b) => {
    const aCreated =
      typeof a.createdAtMs === "number" ? a.createdAtMs : Number.MAX_SAFE_INTEGER;
    const bCreated =
      typeof b.createdAtMs === "number" ? b.createdAtMs : Number.MAX_SAFE_INTEGER;
    if (aCreated !== bCreated) return aCreated - bCreated;
    return a.id.localeCompare(b.id);
  });

  const [primary, ...duplicates] = sorted;
  let removed = 0;
  for (const dup of duplicates) {
    try {
      const result = await cron.remove(dup.id);
      if (result.removed === true) removed += 1;
    } catch {
      // Ignore
    }
  }

  const patch = buildManagedDreamingPatch(primary, desired);
  if (!patch) {
    if (removed > 0) {
      params.logger.info(
        "memory-milvus: pruned duplicate managed dreaming cron jobs.",
      );
    }
    return { status: "noop", removed };
  }

  await cron.update(primary.id, patch);
  params.logger.info("memory-milvus: updated managed dreaming cron job.");
  return { status: "updated", removed };
}

// ── Sweep 执行 ────────────────────────────────────────────────────

async function runMilvusDreamingSweep(params: {
  config: ShortTermPromotionDreamingConfig;
  logger: Logger;
  nowMs: number;
  cfg: OpenClawConfig;
  agentId: string;
}): Promise<{ candidates: number; applied: number; failed: boolean }> {
  if (!params.config.enabled) {
    return { candidates: 0, applied: 0, failed: false };
  }

  const manager = resolveManager
    ? await resolveManager(params.cfg, params.agentId)
    : null;
  if (!manager) {
    params.logger.warn(
      "memory-milvus: dreaming sweep skipped (no active manager).",
    );
    return { candidates: 0, applied: 0, failed: true };
  }

  if (manager.degraded) {
    params.logger.warn(
      "memory-milvus: dreaming sweep skipped (manager is in degraded mode).",
    );
    return { candidates: 0, applied: 0, failed: false };
  }

  if (params.config.verboseLogging) {
    params.logger.info(
      `memory-milvus: dreaming sweep start (limit=${params.config.limit}, ` +
        `minScore=${params.config.minScore.toFixed(3)}, ` +
        `minRecallCount=${params.config.minRecallCount}, ` +
        `recencyHalfLifeDays=${params.config.recencyHalfLifeDays}, ` +
        `maxAgeDays=${params.config.maxAgeDays ?? "none"}).`,
    );
  }

  // Step 1: rank candidates
  let candidates;
  try {
    candidates = await manager.rankPromotionCandidates({
      limit: params.config.limit,
      minScore: params.config.minScore,
      minRecallCount: params.config.minRecallCount,
      minUniqueQueries: params.config.minUniqueQueries,
      recencyHalfLifeDays: params.config.recencyHalfLifeDays,
      maxAgeDays: params.config.maxAgeDays,
      nowMs: params.nowMs,
    });
  } catch (err) {
    params.logger.error(
      `memory-milvus: rankPromotionCandidates failed: ${(err as Error).message}`,
    );
    return { candidates: 0, applied: 0, failed: true };
  }

  if (candidates.length === 0) {
    if (params.config.verboseLogging) {
      params.logger.info("memory-milvus: no promotion candidates found.");
    }
    return { candidates: 0, applied: 0, failed: false };
  }

  if (params.config.verboseLogging) {
    params.logger.info(
      `memory-milvus: ranked ${candidates.length} candidate(s) for promotion.`,
    );
  }

  // Step 2: apply promotions
  let result;
  try {
    result = await manager.applyPromotions({
      candidates,
      limit: params.config.limit,
      minScore: params.config.minScore,
      minRecallCount: params.config.minRecallCount,
      minUniqueQueries: params.config.minUniqueQueries,
      maxAgeDays: params.config.maxAgeDays,
      nowMs: params.nowMs,
    });
  } catch (err) {
    params.logger.error(
      `memory-milvus: applyPromotions failed: ${(err as Error).message}`,
    );
    return { candidates: candidates.length, applied: 0, failed: true };
  }

  params.logger.info(
    `memory-milvus: dreaming sweep complete ` +
      `(candidates=${candidates.length}, applied=${result.applied}).`,
  );

  return {
    candidates: candidates.length,
    applied: result.applied,
    failed: false,
  };
}

// ── 令牌检测 ──────────────────────────────────────────────────────

function includesSystemEventToken(
  cleanedBody: string,
  eventText: string,
): boolean {
  return cleanedBody.includes(eventText);
}

// ── 命令处理 ──────────────────────────────────────────────────────

function formatErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatEnabled(value: boolean): string {
  return value ? "on" : "off";
}

function formatDreamingStatus(config: ShortTermPromotionDreamingConfig): string {
  const lines = [
    `Dreaming: ${formatEnabled(config.enabled)}`,
    `  cron: ${config.cron}${config.timezone ? ` (${config.timezone})` : ""}`,
    `  limit: ${config.limit}`,
    `  minScore: ${config.minScore.toFixed(3)}`,
    `  minRecallCount: ${config.minRecallCount}`,
    `  minUniqueQueries: ${config.minUniqueQueries}`,
    `  recencyHalfLifeDays: ${config.recencyHalfLifeDays}`,
    `  maxAgeDays: ${config.maxAgeDays ?? "none"}`,
    `  verboseLogging: ${formatEnabled(config.verboseLogging)}`,
  ];
  return lines.join("\n");
}

/**
 * Persist dreaming.enabled by writing directly to the config file.
 */
async function persistDreamingEnabled(
  api: OpenClawPluginApi,
  enabled: boolean,
): Promise<void> {
  try {
    const { readFileSync, writeFileSync } = await import("node:fs");
    const { homedir } = await import("node:os");
    const { join } = await import("node:path");
    const configPath = join(homedir(), ".openclaw", "openclaw.json");
    const raw = readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw);
    const entries = config.plugins?.entries ?? {};
    const entry = entries["memory-milvus"] ?? {};
    const entryConfig = entry.config ?? {};
    entry.config = {
      ...entryConfig,
      dreaming: {
        ...(entryConfig.dreaming ?? {}),
        enabled,
      },
    };
    entries["memory-milvus"] = entry;
    config.plugins = { ...config.plugins, entries };
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
    api.logger.info(
      `memory-milvus: dreaming ${enabled ? "enabled" : "disabled"} (config persisted).`,
    );
  } catch (err) {
    api.logger.error(
      `memory-milvus: failed to persist dreaming enabled: ${formatErrorMessage(err)}`,
    );
  }
}

async function handleDreamingCommand(
  api: OpenClawPluginApi,
  args: string | undefined,
): Promise<{ text: string }> {
  const cfg =
    (api.runtime.config?.current?.() as OpenClawConfig) ??
    (api.config as OpenClawConfig);
  const pluginConfig = resolveMemoryMilvusPluginConfig(cfg);
  const config = resolveShortTermPromotionDreamingConfig({ pluginConfig, cfg });
  const normalizedArgs = normalizeTrimmedString(args);

  if (!normalizedArgs) {
    return { text: formatDreamingStatus(config) };
  }

  const parts = normalizedArgs.split(/\s+/).filter(Boolean);
  const verb = parts[0]?.toLowerCase();

  switch (verb) {
    case "status": {
      return { text: formatDreamingStatus(config) };
    }
    case "on": {
      await persistDreamingEnabled(api, true);
      return {
        text: "memory-milvus dreaming enabled in runtime config. The cron job will be reconciled on next heartbeat.",
      };
    }
    case "off": {
      await persistDreamingEnabled(api, false);
      return {
        text: "memory-milvus dreaming disabled in runtime config. The cron job will be removed on next heartbeat.",
      };
    }
    case "run": {
      if (!config.enabled) {
        return { text: "memory-milvus dreaming is disabled. Use `/milvus-dreaming on` first." };
      }
      try {
        const result = await runMilvusDreamingSweep({
          config,
          logger: api.logger,
          nowMs: Date.now(),
          cfg,
          agentId: "default",
        });
        if (result.failed) {
          return {
            text: "memory-milvus dreaming run failed. Check gateway logs for details.",
          };
        }
        return {
          text:
            `memory-milvus dreaming run complete: ` +
            `${result.candidates} candidate(s) ranked, ${result.applied} promoted.`,
        };
      } catch (err) {
        return {
          text: `memory-milvus dreaming run error: ${formatErrorMessage(err)}`,
        };
      }
    }
    default: {
      return {
        text:
          `Unknown dreaming command "${verb}". ` +
          `Available: on, off, status, run`,
      };
    }
  }
}

// ── 注册入口 ──────────────────────────────────────────────────────

export function registerShortTermPromotionDreaming(
  api: OpenClawPluginApi,
): void {
  let resolveStartupCron: (() => CronServiceLike | null) | null = null;
  let gatewayContext: { getCron?: () => CronServiceLike | null } | null = null;
  let unavailableCronWarningEmitted = false;
  let lastRuntimeReconcileAtMs = 0;
  let lastRuntimeConfigKey: string | null = null;
  let lastRuntimeCronRef: CronServiceLike | null = null;
  let startupCronRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let startupCronRetryAttempts = 0;
  let disposed = false;

  const resolveCurrentConfig = (): OpenClawConfig =>
    (api.runtime.config?.current?.() ?? api.config) as OpenClawConfig;

  const resolveCurrentDreamingConfig =
    (): ShortTermPromotionDreamingConfig => {
      const cfg = resolveCurrentConfig();
      return resolveShortTermPromotionDreamingConfig({
        pluginConfig: resolveMemoryMilvusPluginConfig(cfg),
        cfg,
      });
    };

  const clearStartupCronRetry = (): void => {
    if (startupCronRetryTimer) {
      clearTimeout(startupCronRetryTimer);
      startupCronRetryTimer = null;
    }
    startupCronRetryAttempts = 0;
  };

  const hasStartupCron = (): boolean => {
    try {
      return Boolean(resolveStartupCron?.());
    } catch {
      return false;
    }
  };

  const disposeStartupCronRetry = (): void => {
    disposed = true;
    clearStartupCronRetry();
    gatewayContext = null;
    resolveStartupCron = null;
  };

  const runtimeConfigKey = (
    config: ShortTermPromotionDreamingConfig,
  ): string =>
    [
      config.enabled ? "enabled" : "disabled",
      config.cron,
      config.timezone ?? "",
      String(config.limit),
      String(config.minScore),
      String(config.minRecallCount),
      String(config.minUniqueQueries),
      String(config.recencyHalfLifeDays),
      String(config.maxAgeDays ?? ""),
      config.verboseLogging ? "verbose" : "quiet",
    ].join("|");

  const reconcileManagedDreamingCron = async (params: {
    reason: "startup" | "runtime";
    startupConfig?: OpenClawConfig;
    startupCron?: (() => CronServiceLike | null) | null;
  }): Promise<ShortTermPromotionDreamingConfig> => {
    const startupCfg =
      params.reason === "startup"
        ? (params.startupConfig ?? api.config)
        : resolveCurrentConfig();
    const pluginConfig =
      params.reason === "runtime"
        ? resolveMemoryMilvusPluginConfig(startupCfg)
        : (resolveMemoryMilvusPluginConfig(startupCfg) ??
          resolveMemoryMilvusPluginConfig(api.config) ??
          api.pluginConfig);
    const config = resolveShortTermPromotionDreamingConfig({
      pluginConfig,
      cfg: startupCfg,
    });
    if (params.reason === "startup") {
      resolveStartupCron = params.startupCron ?? null;
    }

    let cron = resolveStartupCron?.() ?? null;
    if (!cron && params.reason === "runtime" && gatewayContext) {
      try {
        cron = resolveCronServiceFromGatewayContext(gatewayContext);
        if (cron) {
          resolveStartupCron = () => cron;
        }
      } catch {
        // Ignore
      }
    }

    const configKey = runtimeConfigKey(config);
    if (!cron && config.enabled && !unavailableCronWarningEmitted) {
      if (params.reason === "startup") {
        api.logger.debug?.(
          "memory-milvus: cron service not yet available at gateway_start; deferring to runtime reconciliation.",
        );
      } else {
        api.logger.warn(
          "memory-milvus: managed dreaming cron could not be reconciled (cron service unavailable).",
        );
        unavailableCronWarningEmitted = true;
      }
    }
    if (cron) {
      unavailableCronWarningEmitted = false;
      clearStartupCronRetry();
    }

    if (params.reason === "runtime") {
      const now = Date.now();
      const withinThrottle =
        now - lastRuntimeReconcileAtMs < RUNTIME_CRON_RECONCILE_INTERVAL_MS;
      if (
        withinThrottle &&
        lastRuntimeConfigKey === configKey &&
        lastRuntimeCronRef === cron
      ) {
        return config;
      }
      lastRuntimeReconcileAtMs = now;
      lastRuntimeConfigKey = configKey;
      lastRuntimeCronRef = cron;
    }

    await reconcileShortTermDreamingCronJob({
      cron,
      config,
      logger: api.logger,
    });
    return config;
  };

  const scheduleStartupCronRetry = (
    config: ShortTermPromotionDreamingConfig,
  ): void => {
    if (disposed || !config.enabled || hasStartupCron()) {
      clearStartupCronRetry();
      return;
    }
    if (
      startupCronRetryTimer ||
      startupCronRetryAttempts >= STARTUP_CRON_RETRY_MAX_ATTEMPTS
    ) {
      return;
    }
    startupCronRetryTimer = setTimeout(() => {
      startupCronRetryTimer = null;
      if (disposed) return;
      startupCronRetryAttempts += 1;
      void reconcileManagedDreamingCron({ reason: "runtime" })
        .then((latestConfig) => {
          if (disposed || !latestConfig.enabled || hasStartupCron()) {
            clearStartupCronRetry();
            return;
          }
          scheduleStartupCronRetry(latestConfig);
        })
        .catch((err) => {
          if (disposed) return;
          api.logger.error(
            `memory-milvus: deferred dreaming cron retry failed: ${formatErrorMessage(err)}`,
          );
          try {
            scheduleStartupCronRetry(resolveCurrentDreamingConfig());
          } catch {
            // Ignore config errors in retry
          }
        });
    }, STARTUP_CRON_RETRY_DELAY_MS);
  };

  // ── 生命周期事件 ──────────────────────────────────────────────

  api.on("gateway_start", async (_event, ctx) => {
    disposed = false;
    gatewayContext = ctx as unknown as {
      getCron?: () => CronServiceLike | null;
    };
    try {
      const config = await reconcileManagedDreamingCron({
        reason: "startup",
        startupConfig: ctx.config,
        startupCron: () => resolveCronServiceFromGatewayContext(ctx),
      });
      scheduleStartupCronRetry(config);
    } catch (err) {
      api.logger.error(
        `memory-milvus: dreaming startup reconciliation failed: ${formatErrorMessage(err)}`,
      );
    }
  });

  api.on("gateway_stop", () => {
    disposeStartupCronRetry();
  });

  api.on("before_agent_reply", async (event, ctx) => {
    try {
      if (ctx.trigger !== "heartbeat" && ctx.trigger !== "cron") {
        return undefined;
      }
      const config = await reconcileManagedDreamingCron({
        reason: "runtime",
      });
      if (!config.enabled) {
        return undefined;
      }
      const hasDreamingToken = includesSystemEventToken(
        event.cleanedBody,
        DREAMING_SYSTEM_EVENT_TEXT,
      );
      const isHeartbeatTrigger =
        ctx.trigger === "heartbeat" && hasDreamingToken;
      const isCronTrigger = ctx.trigger === "cron" && hasDreamingToken;
      if (!isHeartbeatTrigger && !isCronTrigger) {
        return undefined;
      }

      const sweepNowMs = Date.now();
      const sweepCfg = resolveCurrentConfig();
      const sweepAgentId = ctx.agentId ?? "default";
      await runMilvusDreamingSweep({
        config,
        logger: api.logger,
        nowMs: sweepNowMs,
        cfg: sweepCfg,
        agentId: sweepAgentId,
      });
    } catch (err) {
      api.logger.error(
        `memory-milvus: dreaming trigger failed: ${formatErrorMessage(err)}`,
      );
    }
    return undefined;
  });

  // ── /dreaming 命令 ────────────────────────────────────────────

  api.registerCommand({
    name: "milvus-dreaming",
    description:
      "Manage Milvus memory dreaming (short-term → long-term promotion). Usage: /milvus-dreaming [on|off|status|run]",
    acceptsArgs: true,
    handler: async (ctx) => {
      return await handleDreamingCommand(api, ctx.args);
    },
  });
}
