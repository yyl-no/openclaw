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
| `memory migrate` CLI (Markdown ↔ Milvus bidirectional) | ✅ |

## Migration

The plugin includes a bidirectional migration CLI subcommand under `openclaw memory`.

```bash
# Forward: scan MEMORY.md + memory/*.md → chunk → embed → Milvus
openclaw memory migrate ./my-memory-dir

# Reverse: query Milvus → export to memory-export/<timestamp>/
openclaw memory migrate ./my-memory-dir --reverse

# Dry-run: preview without writing
openclaw memory migrate ./my-memory-dir --dry-run

# Reverse with type filter
openclaw memory migrate ./my-memory-dir --reverse --type=short_term
```

**Dedup**: SHA-256 in-batch dedup by `text + provenance_label`; cross-batch dedup via
Milvus `provenance_label` query. Reverse output goes to `memory-export/<timestamp>/`
(human-friendly) and never overwrites the original `memory/*.md`.

## Not yet available

| Capability | Target |
|---|---|
| BM25 native full-text search (Milvus ≥ 2.4) | Task 16 |
| Dedup / update / delete / versioning | Task 16 |
| Citation decoration pipeline | Task 16 |
| Multi-corpus support (sessions / wiki) | Task 16 |
| 9-dim advanced recall signals | Task 16 |

## Enable

The `memory-milvus` plugin is mutually exclusive with `memory-core`.
Set `plugins.slots.memory` to activate it — all other `kind:"memory"`
plugins are automatically disabled.

```json
// openclaw.config.json
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
            "host": "localhost",
            "port": 19530
          },
          "embedding": {
            "provider": "alibaba",
            "model": "text-embedding-v3"
          }
        }
      }
    }
  }
}
```

**Switching back to `memory-core`**: change `plugins.slots.memory` to
`"memory-core"`. Your Milvus data and Markdown files are stored independently —
neither is lost when you switch.

**Startup verification**: after switching, the gateway startup log will show
`memory-milvus` among the loaded plugins. If the Milvus server is unreachable,
the plugin initializes in "degraded" mode (falls back to local ndjson files)
and logs a warning.

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
- [Task 14](#) — Markdown ↔ Milvus migration tool (completed)
- [Task 16](#) — Dedup / citation / multi-corpus
