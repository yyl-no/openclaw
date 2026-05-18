# `feat/memory-milvus` 分支核心修改方案与测试方案

适用仓库：

```text
Rf-104/openclaw-yylno
```

目标分支：

```text
feat/memory-milvus
```

## 1. 目标

当前目标不是一次性完成完整重构，而是先让 `memory-milvus` 成为可验证的 `memory-core` 替代后端：

```text
1. memory slot 确实由 memory-milvus 接管
2. 自动/显式记忆写入走 memory_write -> Milvus
3. 不再走 write -> memory/*.md
4. memory_search / memory_get 能从 Milvus 查回数据
5. 高级配置字段至少能通过 configSchema 校验并被运行时代码读取
```

当前分支已经有基础：`memory-milvus` 注册了 memory capability，并声明：

```ts
api.registerMemoryCapability({
  promptBuilder: buildPromptSection,
  flushPlanResolver: buildMilvusFlushPlan,
  runtime: milvusRuntime,
  writeToolNames: ["memory_write"],
});
```

`buildMilvusFlushPlan()` 也返回：

```ts
backendKind: "milvus"
```

这说明设计方向已经是替代 `memory-core`，但测试中暴露出若干阻塞点。

---

## 2. 最重要的四个问题

### 问题 1：`memory-milvus` 的 configSchema 与运行时代码不一致

#### 现象

当前 `extensions/memory-milvus/openclaw.plugin.json` 的 `configSchema` 只允许：

```text
milvus.host
milvus.port
milvus.collectionName

embedding.provider
embedding.model
embedding.dimensions
```

但 `extensions/memory-milvus/index.ts` 的运行时代码实际会读取：

```text
milvus.token
milvus.username
milvus.password
milvus.ssl
milvus.database

search.vectorWeight
search.textWeight
search.useBM25

index.metricType
index.hnswM
index.efConstruction
```

因此一旦用户配置高级字段，就会出现：

```text
must NOT have additional properties
```

#### 影响

```text
1. Zilliz Cloud、有认证 Milvus、非默认 database 无法配置。
2. BM25 / hybrid search 权重无法配置。
3. HNSW / metricType 等索引参数无法配置。
4. 项目代码看似支持高级功能，但配置层直接拦截。
```

#### 修改文件

```text
extensions/memory-milvus/openclaw.plugin.json
```

#### 修改方案

在 `configSchema.properties.milvus.properties` 中补充：

```json
"token": {
  "type": "string"
},
"username": {
  "type": "string"
},
"password": {
  "type": "string"
},
"ssl": {
  "type": "boolean"
},
"database": {
  "type": "string"
}
```

在 `configSchema.properties` 中新增 `search`：

```json
"search": {
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "vectorWeight": {
      "type": "number",
      "minimum": 0,
      "maximum": 1
    },
    "textWeight": {
      "type": "number",
      "minimum": 0,
      "maximum": 1
    },
    "useBM25": {
      "type": "boolean"
    }
  }
}
```

在 `configSchema.properties` 中新增 `index`：

```json
"index": {
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "metricType": {
      "type": "string",
      "enum": ["COSINE", "IP", "L2"]
    },
    "hnswM": {
      "type": "number",
      "minimum": 4,
      "maximum": 128
    },
    "efConstruction": {
      "type": "number",
      "minimum": 8,
      "maximum": 1024
    }
  }
}
```

#### 测试方案

在 `~/.openclaw/openclaw.json` 中配置：

```json
{
  "plugins": {
    "slots": {
      "memory": "memory-milvus"
    },
    "entries": {
      "memory-milvus": {
        "enabled": true,
        "config": {
          "milvus": {
            "host": "127.0.0.1",
            "port": 19530,
            "collectionName": "openclaw_memory",
            "ssl": false,
            "database": "default"
          },
          "embedding": {
            "provider": "alibaba",
            "model": "text-embedding-v3",
            "dimensions": 1024
          },
          "search": {
            "vectorWeight": 0.7,
            "textWeight": 0.3,
            "useBM25": true
          },
          "index": {
            "metricType": "COSINE",
            "hnswM": 16,
            "efConstruction": 200
          }
        }
      }
    }
  }
}
```

执行：

```bash
node ./openclaw.mjs config validate
```

预期：

```text
配置校验通过
```

不能再出现：

```text
must NOT have additional properties
```

---

### 问题 2：`memory-milvus` 插件打包/加载形态不稳定

#### 现象

`extensions/memory-milvus/package.json` 当前声明：

```json
"openclaw": {
  "extensions": [
    "./index.ts"
  ]
}
```

这在源码开发路径下可以工作，但如果它被当成安装插件加载，OpenClaw 会要求存在编译后的 JS 入口：

```text
dist/index.js
dist/index.mjs
index.js
index.mjs
index.cjs
```

测试中出现过：

```text
installed plugin package requires compiled runtime output for TypeScript entry index.ts
```

还出现过运行时从以下路径加载残留插件：

```text
~/.openclaw/extensions/memory-milvus
~/.openclaw/extensions/.openclaw-install-stage-*
```

#### 影响

```text
1. 本地源码存在，但运行时可能加载的是 ~/.openclaw/extensions 中的旧插件。
2. 插件列表显示 memory-milvus，但实际 runtime 可能没有正常执行。
3. 测试结论不可信。
4. 容易继续出现 memoryFlushWritePath required 这类旧链路错误。
```

#### 修改文件 1

```text
extensions/memory-milvus/package.json
```

#### 修改方案

把：

```json
"openclaw": {
  "extensions": [
    "./index.ts"
  ]
}
```

改成：

```json
"openclaw": {
  "extensions": [
    "./dist/index.js"
  ]
}
```

增加构建脚本：

```json
"scripts": {
  "build": "tsdown index.ts --format esm --out-dir dist --external openclaw --external @zilliz/milvus2-sdk-node --external typebox"
}
```

目标是构建后存在：

```text
extensions/memory-milvus/dist/index.js
```

#### 修改文件 2

```text
scripts/build-all.mjs
```

#### 修改方案

在主 `tsdown` 构建完成后，增加 `memory-milvus` 插件构建步骤。

伪代码：

```js
await run("pnpm", ["--filter", "@openclaw/memory-milvus", "build"], {
  label: "build:memory-milvus",
});
```

如果运行时要求 bundled plugin 进入根 `dist/extensions`，还需要在 postbuild/copy 阶段复制：

```text
extensions/memory-milvus/openclaw.plugin.json
extensions/memory-milvus/package.json
extensions/memory-milvus/dist/**
```

到：

```text
dist/extensions/memory-milvus/
```

#### 测试方案

清理残留安装插件：

```bash
rm -rf ~/.openclaw/extensions/memory-milvus
rm -rf ~/.openclaw/extensions/.openclaw-install-stage-*
```

重新构建：

```bash
pnpm build
```

检查：

```bash
ls -la extensions/memory-milvus/dist/index.js
find dist -path "*memory-milvus*" | head -50
```

启动：

```bash
node ./openclaw.mjs gateway run
```

预期日志中不再出现：

```text
installed plugin package requires compiled runtime output for TypeScript entry index.ts
```

也不应该再从下面路径加载：

```text
/home/rf/.openclaw/extensions/memory-milvus
/home/rf/.openclaw/extensions/.openclaw-install-stage-*
```

---

### 问题 3：Milvus manager 初始化失败时真实原因被丢失

#### 现象

UI 中已经能看到真实工具调用：

```text
memory_search
```

但返回：

```text
Milvus search manager is not initialized.
```

`milvusRuntime.getMemorySearchManager()` 内部其实会返回详细错误：

```ts
{ manager: null, error: "Failed to initialize Milvus search manager: ..." }
```

但 `makeGetManager()` 只返回 `manager`，没有把 `result.error` 暴露给工具层。

#### 影响

无法区分真实失败原因：

```text
1. Milvus 服务没启动
2. Milvus host/port 错误
3. collection 创建失败
4. embedding provider 不可用
5. config 读取失败
6. 插件加载来源错误
```

调试会一直卡在泛化错误上。

#### 修改文件 1

```text
extensions/memory-milvus/index.ts
```

#### 修改方案

找到 `makeGetManager()`：

```ts
const result = await milvusRuntime.getMemorySearchManager({ cfg, agentId });
return (result.manager as MilvusSearchManager | null) ?? null;
```

改成：

```ts
const result = await milvusRuntime.getMemorySearchManager({ cfg, agentId });

if (!result.manager) {
  throw new Error(
    result.error ??
      "Milvus search manager is not initialized. Check memory-milvus config, Milvus connectivity, collection bootstrap, and embedding provider.",
  );
}

return result.manager as MilvusSearchManager;
```

#### 修改文件 2

```text
extensions/memory-milvus/src/tools.ts
```

#### 修改方案

当前 `memory_write` 只处理 manager 为 null 的情况。应补充 `getManager()` 抛错时的 JSON 输出。

把：

```ts
const manager = await Promise.resolve(deps.getManager());
if (!manager) {
  return jsonResult({
    error:
      "Milvus search manager is not initialized. Ensure the memory-milvus plugin is configured and the Milvus server is reachable.",
  });
}
```

改成：

```ts
let manager: MemoryWriteManager | null;
try {
  manager = await Promise.resolve(deps.getManager());
} catch (err) {
  return jsonResult({
    error: err instanceof Error ? err.message : String(err),
  });
}

if (!manager) {
  return jsonResult({
    error:
      "Milvus search manager is not initialized. Ensure the memory-milvus plugin is configured and the Milvus server is reachable.",
  });
}
```

#### 修改文件 3

```text
extensions/memory-milvus/src/tools.get.ts
```

#### 修改方案

同样把：

```ts
const manager = await Promise.resolve(deps.getManager());
if (!manager) {
  return jsonResult({
    error:
      "Milvus search manager is not initialized. Ensure the memory-milvus plugin is configured and the Milvus server is reachable.",
  });
}
```

改成：

```ts
let manager: MemoryGetManager | null;
try {
  manager = await Promise.resolve(deps.getManager());
} catch (err) {
  return jsonResult({
    error: err instanceof Error ? err.message : String(err),
  });
}

if (!manager) {
  return jsonResult({
    error:
      "Milvus search manager is not initialized. Ensure the memory-milvus plugin is configured and the Milvus server is reachable.",
  });
}
```

`memory_search` 本身已经有外层 `try`，所以 `makeGetManager()` 抛出真实错误后，`memory_search` 能返回更具体的 JSON 错误。

#### 测试方案

##### 场景 A：Milvus 没启动

关闭 Milvus，然后在 UI 中触发：

```text
请使用 memory_search 搜索 MILVUS_TEST
```

预期不再只是：

```text
Milvus search manager is not initialized
```

而是类似：

```text
Failed to initialize Milvus search manager: connection refused ...
```

##### 场景 B：embedding provider 配错

临时配置：

```json
"embedding": {
  "provider": "not-exist",
  "model": "text-embedding-v3",
  "dimensions": 1024
}
```

触发：

```text
请使用 memory_search 搜索 MILVUS_TEST
```

预期返回：

```text
Unknown memory embedding provider: not-exist
```

##### 场景 C：正常配置

启动 Milvus，配置正确 embedding provider，触发：

```text
请使用 memory_write 记住：MILVUS_TEST_001 = memory-milvus manager 初始化测试
```

预期返回：

```json
{
  "id": "...",
  "label": "chat_extract"
}
```

---

### 问题 4：Milvus memory flush 必须强制只允许 `memory_write`，并禁止 `deepseek-reasoner` 使用工具

这个问题直接关系到核心目标：

```text
不要还走写入 md
不要再出现 <exec><command> 伪工具输出
```

---

## 4.1 强制 Milvus memory flush 只允许 `memory_write`

### 当前状态

`src/agents/pi-tools.ts` 当前 memory flush 默认允许：

```ts
const MEMORY_FLUSH_ALLOWED_TOOL_NAMES = new Set(["read", "write"]);
```

然后把 active memory plugin 的 `writeToolNames` 加进去。

后面虽然已有逻辑：如果 `isMilvusBackend`，跳过普通 `write` 工具：

```ts
if (tool.name === "write") {
  if (isMilvusBackend) {
    continue;
  }
}
```

但为了确保不写 md，应该改成更强的 fail-closed 逻辑：

```text
trigger === "memory" && memoryFlushBackendKind === "milvus"
=> 只允许 memory_write
```

### 修改文件

```text
src/agents/pi-tools.ts
```

### 修改方案

找到：

```ts
const toolsForMemoryFlush: AnyAgentTool[] = isMemoryFlushRun ? [] : tools;
if (isMemoryFlushRun) {
  for (const tool of tools) {
    if (!resolveMemoryWriteToolNames().has(tool.name)) {
      continue;
    }
    if (tool.name === "write") {
      if (isMilvusBackend) {
        continue;
      }
      ...
    }
    toolsForMemoryFlush.push(tool);
  }
}
```

改成：

```ts
const toolsForMemoryFlush: AnyAgentTool[] = isMemoryFlushRun ? [] : tools;

if (isMemoryFlushRun) {
  const allowedMemoryFlushToolNames = isMilvusBackend
    ? new Set(["memory_write"])
    : resolveMemoryWriteToolNames();

  for (const tool of tools) {
    if (!allowedMemoryFlushToolNames.has(tool.name)) {
      continue;
    }

    if (tool.name === "write") {
      if (isMilvusBackend) {
        continue;
      }

      if (memoryFlushWritePath) {
        toolsForMemoryFlush.push(
          wrapToolMemoryFlushAppendOnlyWrite(tool, {
            root: sandboxRoot ?? workspaceRoot,
            relativePath: memoryFlushWritePath,
            containerWorkdir: sandbox?.containerWorkdir,
            sandbox:
              sandboxRoot && sandboxFsBridge
                ? { root: sandboxRoot, bridge: sandboxFsBridge }
                : undefined,
          }),
        );
        continue;
      }
    }

    toolsForMemoryFlush.push(tool);
  }

  if (
    isMilvusBackend &&
    !toolsForMemoryFlush.some((tool) => tool.name === "memory_write")
  ) {
    throw new Error(
      "memory_write tool required for Milvus memory flush but was not available",
    );
  }
}
```

### 测试方案

启动前记录文件状态：

```bash
find ~/.openclaw/workspace -path "*/memory/*.md" -type f -printf "%TY-%Tm-%Td %TH:%TM %p\n" 2>/dev/null | sort | tail -20
```

UI 中触发：

```text
请使用 memory_write 记住：MILVUS_TEST_NO_MD_001 = 不应写入 md 的测试。
```

检查 md：

```bash
grep -R "MILVUS_TEST_NO_MD_001" ~/.openclaw/workspace/memory 2>/dev/null
```

预期：

```text
没有输出
```

检查日志：

```bash
tail -n 500 /tmp/openclaw/openclaw-2026-05-17.log | grep -iE "memoryFlush|memory_write|writePath|required|error|warn"
```

预期不再出现：

```text
memoryFlushWritePath required
```

---

## 4.2 给 `deepseek-reasoner` 加 `supportsTools: false`

### 问题

`extensions/deepseek/openclaw.plugin.json` 中 `deepseek-reasoner` 当前没有：

```json
"supportsTools": false
```

而 OpenClaw 工具能力判断逻辑是：

```ts
return compat?.supportsTools !== false;
```

也就是不显式禁用就默认启用工具。

因此 `deepseek-reasoner` 可能会拿到 `exec`、`memory_search`、`memory_write` 等工具，并在不支持或不稳定的情况下输出：

```text
<exec><command>python3 -c ...
```

### 修改文件

```text
extensions/deepseek/openclaw.plugin.json
```

### 修改方案

找到：

```json
{
  "id": "deepseek-reasoner",
  "name": "DeepSeek Reasoner",
  "reasoning": true,
  "compat": {
    "supportsUsageInStreaming": true,
    "supportsReasoningEffort": false,
    "maxTokensField": "max_tokens"
  }
}
```

改成：

```json
{
  "id": "deepseek-reasoner",
  "name": "DeepSeek Reasoner",
  "reasoning": true,
  "compat": {
    "supportsUsageInStreaming": true,
    "supportsReasoningEffort": false,
    "maxTokensField": "max_tokens",
    "supportsTools": false
  }
}
```

工具型 memory 对话和 memory flush 使用：

```text
deepseek-chat
```

不要使用：

```text
deepseek-reasoner
```

### 测试方案

切到 `deepseek-reasoner` 后询问：

```text
请搜索我的记忆里有没有 MILVUS_TEST_NO_MD_001
```

预期：

```text
不会出现 <exec><command>...</command>
```

如果需要实际调用 `memory_search`，应切换到 `deepseek-chat`。

---

## 3. 总体验收方案

### 3.1 构建与配置验证

```bash
cd ~/Projects/openclaw-yylno
pnpm build
node ./openclaw.mjs config validate
```

预期不能出现：

```text
must NOT have additional properties
requires compiled runtime output for TypeScript entry index.ts
```

---

### 3.2 清理残留并启动

```bash
systemctl --user stop openclaw-gateway.service 2>/dev/null || true
pkill -f openclaw-gateway || true

rm -rf ~/.openclaw/extensions/memory-milvus
rm -rf ~/.openclaw/extensions/.openclaw-install-stage-*

node ./openclaw.mjs gateway run
```

另开终端确认进程来源：

```bash
PID=$(ss -ltnp | awk '/18789/ {match($0,/pid=([0-9]+)/,a); print a[1]; exit}')
readlink -f /proc/$PID/cwd
tr '\0' ' ' < /proc/$PID/cmdline; echo
```

预期：

```text
/home/rf/Projects/openclaw-yylno
```

---

### 3.3 验证工具链

UI 中输入：

```text
请使用 memory_write 记住：MILVUS_TEST_FINAL_001 = memory-milvus 替代 memory-core 验收测试。
```

预期工具调用：

```text
memory_write
```

不能是：

```text
write
exec
<exec><command>...
```

再输入：

```text
请使用 memory_search 搜索 MILVUS_TEST_FINAL_001
```

预期工具调用：

```text
memory_search
```

并返回刚才写入的记录。

---

### 3.4 验证没有写 md

```bash
grep -R "MILVUS_TEST_FINAL_001" ~/.openclaw/workspace/memory 2>/dev/null
find ~/.openclaw/workspace -path "*/memory/*.md" -type f -mmin -10 -print 2>/dev/null
```

预期：

```text
没有包含 MILVUS_TEST_FINAL_001 的 md 文件
```

---

### 3.5 直接验证 Milvus 数据

先安装 `pymilvus`：

```bash
cd ~/Projects/openclaw-yylno
python3 -m venv .venv-milvus
source .venv-milvus/bin/activate
python -m pip install -U pip
python -m pip install pymilvus
```

查询：

```bash
python3 - <<'PY'
from pymilvus import connections, Collection, utility

connections.connect(host="127.0.0.1", port="19530")
name = "openclaw_memory"

print("collections:", utility.list_collections())

if not utility.has_collection(name):
    print("collection not found:", name)
    raise SystemExit(1)

col = Collection(name)
col.load()
print("num_entities:", col.num_entities)

rows = col.query(
    expr='text like "%MILVUS_TEST_FINAL_001%"',
    output_fields=["id", "text", "agent_id", "session_key", "memory_type", "created_at"],
    limit=10,
)

for r in rows:
    print("----")
    print(r)
PY
```

预期：能查到测试文本。

---

## 4. 成功标准

修完这四类问题后，达到以下结果即可认为当前目标完成：

```text
1. memory-milvus 能稳定加载，不再从 ~/.openclaw/extensions 残留路径加载。
2. configSchema 允许运行时代码已支持的高级字段。
3. memory_write 可以成功写入 Milvus。
4. memory_search / memory_get 可以查回 Milvus 数据。
5. memory flush 阶段只允许 memory_write，不再允许 write 写 memory/*.md。
6. deepseek-reasoner 不再拿到工具，不再输出 <exec><command> 伪工具文本。
7. 日志中不再出现 memoryFlushWritePath required。
8. ~/.openclaw/workspace/memory/*.md 不再出现新的测试记忆内容。
```

达到这些条件后，可以判断：

```text
memory-milvus 已经可以作为 memory-core 的核心替代后端；
核心记忆读写走 Milvus；
不再走 md 文件写入；
高级功能具备继续验证和启用的基础。
```
