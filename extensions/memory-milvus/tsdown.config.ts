import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["index.ts"],
  format: ["esm"],
  outDir: "dist",
  fixedExtension: false,
  platform: "node",
  deps: {
    neverBundle: ["openclaw", "@zilliz/milvus2-sdk-node", "typebox"],
  },
});
