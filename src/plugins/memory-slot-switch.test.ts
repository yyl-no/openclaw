import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { applyExclusiveSlotSelection } from "./slots.js";

/**
 * Task 15: 接入 memory slot — 切换集成测试
 *
 * 验证 applyExclusiveSlotSelection 在 memory-core 与 memory-milvus
 * 两个 kind:"memory" 插件之间正确执行互斥切换。
 */

function registryWithBothMemoryPlugins() {
  return {
    plugins: [
      { id: "memory-core", kind: "memory" as const },
      { id: "memory-milvus", kind: "memory" as const },
    ],
  };
}

function baseConfig(overrides?: Partial<OpenClawConfig["plugins"]>): OpenClawConfig {
  return {
    plugins: {
      entries: {
        "memory-core": { enabled: true },
        "memory-milvus": { enabled: true },
      },
      ...overrides,
    },
  };
}

function resultSummary(result: ReturnType<typeof applyExclusiveSlotSelection>) {
  return {
    changed: result.changed,
    slot: result.config.plugins?.slots?.memory,
    memoryCoreEnabled: result.config.plugins?.entries?.["memory-core"]?.enabled ?? true,
    memoryMilvusEnabled: result.config.plugins?.entries?.["memory-milvus"]?.enabled ?? true,
    warnings: result.warnings,
  };
}

describe("memory slot switch (Task 15)", () => {
  describe("scenario A: memory-core selected", () => {
    it("enables memory-core and disables memory-milvus", () => {
      const result = applyExclusiveSlotSelection({
        config: baseConfig({ slots: { memory: "memory-core" } }),
        selectedId: "memory-core",
        selectedKind: "memory",
        registry: registryWithBothMemoryPlugins(),
      });

      const summary = resultSummary(result);
      expect(summary.slot).toBe("memory-core");
      expect(summary.memoryCoreEnabled).toBe(true);
      expect(summary.memoryMilvusEnabled).toBe(false);
      expect(summary.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining('Disabled other "memory" slot plugins: memory-milvus'),
        ]),
      );
    });

    it("already-selected slot produces no change", () => {
      const config = baseConfig({
        slots: { memory: "memory-core" },
        entries: {
          "memory-core": { enabled: true },
          "memory-milvus": { enabled: false },
        },
      });

      const result = applyExclusiveSlotSelection({
        config,
        selectedId: "memory-core",
        selectedKind: "memory",
        registry: registryWithBothMemoryPlugins(),
      });

      expect(result.changed).toBe(false);
      expect(result.config).toBe(config);
    });
  });

  describe("scenario B: memory-milvus selected", () => {
    it("enables memory-milvus and disables memory-core", () => {
      const result = applyExclusiveSlotSelection({
        config: baseConfig({ slots: { memory: "memory-milvus" } }),
        selectedId: "memory-milvus",
        selectedKind: "memory",
        registry: registryWithBothMemoryPlugins(),
      });

      const summary = resultSummary(result);
      expect(summary.slot).toBe("memory-milvus");
      expect(summary.memoryMilvusEnabled).toBe(true);
      expect(summary.memoryCoreEnabled).toBe(false);
      expect(summary.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining('Disabled other "memory" slot plugins: memory-core'),
        ]),
      );
    });

    it("switching from memory-core to memory-milvus generates slot-change warning", () => {
      const result = applyExclusiveSlotSelection({
        config: baseConfig({ slots: { memory: "memory-core" } }),
        selectedId: "memory-milvus",
        selectedKind: "memory",
        registry: registryWithBothMemoryPlugins(),
      });

      const summary = resultSummary(result);
      expect(summary.changed).toBe(true);
      expect(summary.slot).toBe("memory-milvus");
      expect(summary.memoryCoreEnabled).toBe(false);
      expect(summary.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining('switched from "memory-core" to "memory-milvus"'),
          expect.stringContaining('Disabled other "memory" slot plugins: memory-core'),
        ]),
      );
    });
  });

  describe("scenario C: slots.memory = none", () => {
    it("disables both memory plugins when slot is 'none'", () => {
      const result = applyExclusiveSlotSelection({
        config: baseConfig({ slots: { memory: "none" } }),
        selectedId: "none",
        selectedKind: "memory",
        registry: registryWithBothMemoryPlugins(),
      });

      const summary = resultSummary(result);
      expect(summary.changed).toBe(true);
      expect(summary.slot).toBe("none");
      expect(summary.memoryCoreEnabled).toBe(false);
      expect(summary.memoryMilvusEnabled).toBe(false);
    });

    it("reverts to 'none' from a previously selected plugin", () => {
      const result = applyExclusiveSlotSelection({
        config: baseConfig({ slots: { memory: "memory-milvus" } }),
        selectedId: "none",
        selectedKind: "memory",
        registry: registryWithBothMemoryPlugins(),
      });

      const summary = resultSummary(result);
      expect(summary.changed).toBe(true);
      expect(summary.slot).toBe("none");
      expect(summary.memoryMilvusEnabled).toBe(false);
      expect(summary.memoryCoreEnabled).toBe(false);
      expect(summary.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining('switched from "memory-milvus" to "none"'),
          expect.stringContaining('Disabled other "memory" slot plugins: memory-core, memory-milvus'),
        ]),
      );
    });

    it("resolveMemorySlotDecision returns disabled when slot is 'none'", async () => {
      const { resolveMemorySlotDecision } = await import("./config-state.js");

      // memory-core against "none" slot
      expect(resolveMemorySlotDecision({ id: "memory-core", kind: "memory", slot: "none", selectedId: null }))
        .toEqual({ enabled: false, reason: 'memory slot set to "none"' });

      // memory-milvus against "none" slot
      expect(resolveMemorySlotDecision({ id: "memory-milvus", kind: "memory", slot: "none", selectedId: null }))
        .toEqual({ enabled: false, reason: 'memory slot set to "none"' });
    });
  });

  describe("cross-compatibility invariants", () => {
    it("both plugins receive enabled:false for the non-selected one", () => {
      for (const selectedId of ["memory-core", "memory-milvus"] as const) {
        const otherId = selectedId === "memory-core" ? "memory-milvus" : "memory-core";

        const result = applyExclusiveSlotSelection({
          config: baseConfig({ slots: { memory: selectedId } }),
          selectedId,
          selectedKind: "memory",
          registry: registryWithBothMemoryPlugins(),
        });

        expect(result.config.plugins?.entries?.[selectedId]?.enabled).not.toBe(false);
        expect(result.config.plugins?.entries?.[otherId]?.enabled).toBe(false);
      }
    });

    it("selected plugin config fields are preserved (not overwritten)", () => {
      const config: OpenClawConfig = {
        plugins: {
          slots: { memory: "memory-milvus" },
          entries: {
            "memory-milvus": { enabled: true, config: { milvus: { host: "custom-host" } } },
            "memory-core": { enabled: true },
          },
        },
      };

      const result = applyExclusiveSlotSelection({
        config,
        selectedId: "memory-milvus",
        selectedKind: "memory",
        registry: registryWithBothMemoryPlugins(),
      });

      expect(result.config.plugins?.entries?.["memory-milvus"]?.config).toEqual({
        milvus: { host: "custom-host" },
      });
      expect(result.config.plugins?.entries?.["memory-milvus"]?.enabled).toBe(true);
      expect(result.config.plugins?.entries?.["memory-core"]?.enabled).toBe(false);
    });
  });
});
