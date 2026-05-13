# Memory (Milvus)

Milvus-backed memory plugin providing vector ANN search for OpenClaw memory.

## Current capabilities

| Capability | Status |
|---|---|
| `memory_write` tool (vector insert with fallback) | ✅ |
| `memory_search` tool (ANN + keyword hybrid search) | ✅ |
| `memory_get` tool (PK lookup) | ✅ |
| Collection auto-bootstrap (create + load) | ✅ |
| Degraded mode (Milvus unreachable → ndjson fallback) | ✅ |
| `recordRecall` (recall-count tracking + upsert) | ✅ |
| Dreaming promotion `rankPromotionCandidates` + `applyPromotions` | ✅ |
| Source label / memory type validation | ✅ |
| AI flush turn prompt integration | ✅ |

## Not yet available

| Capability | Target |
|---|---|
| BM25 native full-text search (Milvus ≥ 2.4) | Task 16 |
| Dedup / update / delete / versioning | Task 16 |
| Citation decoration pipeline | Task 16 |
| Multi-corpus support (sessions / wiki) | Task 16 |
| 9-dim advanced recall signals | Task 16 |

## Quick start (Docker)

Launch a local Milvus instance:

```bash
# Standalone mode with embedded etcd
docker run -d --name milvus-standalone \
  -p 19530:19530 -p 9091:9091 \
  milvusdb/milvus:v2.4.0 standalone
```

Configure the plugin in `openclaw.yaml`:

```yaml
plugins:
  entries:
    memory-milvus:
      config:
        milvus:
          host: localhost
          port: 19530
        embedding:
          provider: alibaba
          model: text-embedding-v3
```

## Testing

### Unit tests (no Milvus required)

```bash
pnpm test extensions/memory-milvus
```

### Live tests (requires Milvus + embedding API key)

Live end-to-end tests are guarded behind `OPENCLAW_LIVE_TEST=1`, covering write → search → recordRecall → promotion pipelines.

```bash
# Start Milvus first (see Quick start above)
export OPENCLAW_LIVE_TEST=1
export OPENAI_API_KEY="sk-..."
pnpm test:live extensions/memory-milvus
```

## Architecture

The plugin registers a `MemoryPluginCapability` that is mutually exclusive with
`memory-core`. Switching backends only requires changing the `plugins.slots.memory`
entry — the AI tool chain (`memory_write`) remains consistent.

```
AI flush turn
  ↓ memory_write(text, label?)
  ↓ MilvusSearchManager.write()
  ↓ health check → embed → insert → vector stored
  ↓ on failure → ndjson fallback (zero data loss)
```

## References

- [Task 10 plan](../../refactor/1-plan.md)
- [Task 10 decisions](../../refactor/2-decisions.md)
- [Task 13](#) — Dreaming promotion (completed)
- [Task 16](#) — Dedup / citation / multi-corpus
