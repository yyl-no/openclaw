import { describe, expect, it, vi } from "vitest";
import pluginEntry from "../index.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

describe("memory-milvus plugin register", () => {
  it("无条件注册 memory_write / memory_search / memory_get 三个工具", () => {
    const registerToolSpy = vi.fn();
    const mockApi = {
      registerMemoryCapability: vi.fn(),
      registerTool: registerToolSpy,
      registerCli: vi.fn(),
    } as unknown as OpenClawPluginApi;

    pluginEntry.register(mockApi);

    expect(registerToolSpy).toHaveBeenCalledTimes(3);

    // 第一次调用：memory_write
    expect(registerToolSpy).toHaveBeenNthCalledWith(
      1,
      expect.any(Function),
      { names: ["memory_write"] },
    );

    // 第二次调用：memory_search
    expect(registerToolSpy).toHaveBeenNthCalledWith(
      2,
      expect.any(Function),
      { names: ["memory_search"] },
    );

    // 第三次调用：memory_get
    expect(registerToolSpy).toHaveBeenNthCalledWith(
      3,
      expect.any(Function),
      { names: ["memory_get"] },
    );
  });

  it("registerMemoryCapability 也被调用", () => {
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
