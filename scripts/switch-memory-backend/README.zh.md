# switch-memory-backend（中文）

一键切换 OpenClaw 的 **memory-core**（基于文件）与 **memory-milvus**
（Milvus + ANN/BM25）记忆后端，或用 `none` 同时禁用两者。

脚本只改两类配置字段：

- `plugins.slots.memory`：互斥记忆槽
- `plugins.entries.<id>.enabled`：把选中的插件设为启用、另一个设为禁用，
  与加载器（`applyExclusiveSlotSelection`）的互斥规则保持一致

> English version: see `README.md`.

## 配置文件路径解析

按优先级（先命中先用）：

1. `--config <路径>` 命令行参数
2. `OPENCLAW_CONFIG_PATH` 环境变量
3. `${OPENCLAW_STATE_DIR}/openclaw.json`
4. `~/.openclaw/openclaw.json`（默认）

文件按 JSON 解析。脚本会自动剥离 `//` 行注释和 `/* */` 块注释，
JSON5 风格的配置也能安全读写（写回时统一为标准 JSON）。

## 命令一览

### 查看当前后端

```bash
node scripts/switch-memory-backend/switch-memory-backend.mjs status
```

示例输出：

```text
Config:   /home/alice/.openclaw/openclaw.json
Slot:     plugins.slots.memory = "memory-core"
Entries:
  memory-core   enabled=true
  memory-milvus enabled=false
```

### 切换后端

```bash
# 切到 Milvus
node scripts/switch-memory-backend/switch-memory-backend.mjs to milvus

# 切回 memory-core（默认文件后端）
node scripts/switch-memory-backend/switch-memory-backend.mjs to core

# 同时禁用两个 memory 插件
node scripts/switch-memory-backend/switch-memory-backend.mjs to none
```

支持的别名：

- `core`、`memory-core`
- `milvus`、`memory-milvus`
- `none`、`off`、`disable`

脚本会原地写回，并在同目录生成带时间戳的备份文件，例如
`openclaw.json.bak.2026-05-12T08-30-00-123Z`。

### 常用参数

| 参数              | 说明                                    |
| ----------------- | --------------------------------------- |
| `--config <路径>` | 指定配置文件路径                        |
| `--dry-run`       | 仅把改动后的 JSON 打印到 stdout，不写盘 |
| `--no-backup`     | 跳过 `.bak.<时间戳>` 备份               |
| `-h`、`--help`    | 显示帮助                                |

### 示例

```bash
# 干跑预览，不动文件
node scripts/switch-memory-backend/switch-memory-backend.mjs to milvus --dry-run

# 自定义配置路径
node scripts/switch-memory-backend/switch-memory-backend.mjs to core --config ./tmp/openclaw.json

# 通过环境变量切换
OPENCLAW_CONFIG_PATH=/srv/openclaw/openclaw.json \
  node scripts/switch-memory-backend/switch-memory-backend.mjs to milvus

# 不生成备份文件
node scripts/switch-memory-backend/switch-memory-backend.mjs to none --no-backup
```

## 脚本到底改了什么

执行 `to milvus` 后，相关片段变为：

```json
{
  "plugins": {
    "slots": { "memory": "memory-milvus" },
    "entries": {
      "memory-core": { "enabled": false },
      "memory-milvus": { "enabled": true }
    }
  }
}
```

执行 `to none` 时两个 `enabled` 都置为 `false`，槽位值字面量为 `"none"`，
加载器会视为"无活动 memory 插件"。

脚本不会动 Milvus 连接信息、embedding provider 配置以及各插件的 `config`
子块——只翻转槽位字段和两个 `enabled` 开关。

## 切换之后

1. **重启网关**，让加载器读取新槽位：
   ```bash
   openclaw gateway restart
   ```
2. **验证**当前生效的插件：
   ```bash
   openclaw plugins list
   ```
3. **切到 Milvus 时**：确认 `plugins.entries.memory-milvus.config.milvus.host:port`
   指向的 Milvus 服务可达；否则插件会进入降级模式（写入本地 NDJSON 回放文件）。

## 用官方命令证明当前后端

脚本只改配置文件。要证明网关实际在跑 **memory-milvus**（而不是 memory-core），
用下面这五条官方 OpenClaw CLI 检查，每一层排除一种失败场景（配置错 /
槽位错 / 运行时未加载 / 加载错了插件 / Milvus 不可达）。

### 1. 配置层 —— 只有 memory-milvus 是 enabled

```bash
openclaw plugins list --enabled
```

预期：输出里出现 `memory-milvus enabled [openclaw] - ...`，且看**不到**
`memory-core` 一行。

机器可读形式：

```bash
openclaw plugins list --json
```

两条记录应该分别是：

```json
{ "id": "memory-milvus", "enabled": true,  "status": "loaded"   }
{ "id": "memory-core",   "enabled": false, "status": "disabled" }
```

### 2. 槽位层 —— memory-milvus 拿到了 memory 槽

```bash
openclaw plugins inspect memory-milvus --json
```

关键字段：

```json
{ "plugin": { "id": "memory-milvus", "memorySlotSelected": true } }
```

`memorySlotSelected: true` 表示加载器已把 `plugins.slots.memory` 解析到这个
插件，授予它 active memory 槽的所有权。

### 3. 运行时层 —— 插件真的被加载，且工具全部注册

```bash
openclaw plugins inspect memory-milvus --runtime
```

> `--runtime` 参数从 2026.5.10-beta.1 开始支持。旧版 CLI 请去掉该参数，
> 改靠第 5 步的网关日志兑现运行时状态。

预期输出片段：

```text
Status: loaded
Capabilities: memory: (registered)
Tools:
  memory_write
  memory_search
  memory_get
```

三个工具名都出现，说明 ctx 工厂回调跑起来了、Manager Pool 为当前 agent
成功构造出 `MilvusSearchManager`。

### 4. 反向证伪 —— memory-core 被槽位策略明确禁用

```bash
openclaw plugins inspect memory-core --runtime
```

预期：

```text
Status: disabled
error:  memory slot set to "memory-milvus"
```

这句 reason 字串不是随意出现的——它证明 memory-core 是被 slot 解析器
**主动关掉**，而不是沉默出错。

### 5. 网关日志层 —— Milvus 已连上，未进降级模式

```bash
openclaw gateway logs 2>&1 | Select-String "memory-milvus|degraded"
```

良好特征：

- 出现 `memory-milvus loaded` / 工具注册日志
- 没有 `degraded mode` / `dreaming manager lazy-init failed` 告警
- 有一条 Milvus 连接日志指向你配置的 `host:port`

如果看到 `degraded mode`，说明插件跑起来了但 Milvus 不可达——写入被镜像到
本地 NDJSON 回放文件。修复 Milvus 连通后重启网关，重跑第 3 、 5 步。

### 一行命令完成全链路证明（PowerShell）

```powershell
openclaw plugins list --enabled;
openclaw plugins inspect memory-milvus --json |
  ConvertFrom-Json |
  Select-Object -ExpandProperty plugin |
  Format-List id, status, memorySlotSelected;
openclaw plugins inspect memory-milvus --runtime;
openclaw gateway logs 2>&1 | Select-String "memory-milvus|degraded" | Select-Object -First 20
```

如果第 1 步只有 memory-milvus、第 2 步输出 `memorySlotSelected: True`、
第 3 步在 `Status: loaded` 下列出三个工具、第 4 步无 `degraded` 行——
当前后端就是 memory-milvus。

## 数据不会迁移

两个后端的数据各存各的：

- `memory-core` 写 Markdown 文件到工作区记忆目录
- `memory-milvus` 写向量 + 元数据到 Milvus collection

切槽位**不会**互拷或转换数据。如需把已有 Markdown 记忆导入 Milvus，
请用 `memory-migrate` 命令。

## 退出码

- `0`：成功
- `1`：运行时错误（配置缺失 / 解析失败 / 目标不识别等）
- `2`：未知命令

## 相关文档

- `extensions/memory-milvus/README.md`：Milvus 后端总览
- `extensions/memory-milvus/README.zh.md`：中文版
- `src/plugins/slots.ts`：底层 `applyExclusiveSlotSelection` 切换逻辑
