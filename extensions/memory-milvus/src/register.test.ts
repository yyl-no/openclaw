import { describe, expect, it, vi } from "vitest";
import pluginEntry from "../index.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

describe("memory-milvus plugin register", () => {
  it("unconditionally registers memory_write / memory_search / memory_get three tools", () => {
    const registerToolSpy = vi.fn();
    const mockApi = {
      registerMemoryCapability: vi.fn(),
      registerTool: registerToolSpy,
      registerCli: vi.fn(),
    } as unknown as OpenClawPluginApi;

    pluginEntry.register(mockApi);

    expect(registerToolSpy).toHaveBeenCalledTimes(3);

    // 1st call: memory_write
    expect(registerToolSpy).toHaveBeenNthCalledWith(
      1,
      expect.any(Function),
      { names: ["memory_write"] },
    );

    // 2nd call: memory_search
    expect(registerToolSpy).toHaveBeenNthCalledWith(
      2,
      expect.any(Function),
      { names: ["memory_search"] },
    );

    // 3rd call: memory_get
    expect(registerToolSpy).toHaveBeenNthCalledWith(
      3,
      expect.any(Function),
      { names: ["memory_get"] },
    );
  });

  it("registerMemoryCapability is also called", () => {
    const capabilitySpy = vi.fn();
    const mockApi = {
      registerMemoryCapability: capabilitySpy,
      registerTool: vi.fn(),
      registerCli: vi.fn(),
    } as unknown as OpenClawPluginApi;

    pluginEntry.register(mockApi);

    expect(capabilitySpy).toHaveBeenCalledOnce();
    expect(capabilitySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        promptBuilder: expect.any(Function),
        flushPlanResolver: expect.any(Function),
        runtime: expect.any(Object),
      }),
    );
  });
});
