# switch-memory-backend

Switch the active OpenClaw memory backend between **memory-core** (file-based)
and **memory-milvus** (Milvus + ANN/BM25), or disable both with `none`.

The script edits two keys in your OpenClaw config file:

- `plugins.slots.memory` — the exclusive memory slot
- `plugins.entries.<id>.enabled` — keeps the chosen plugin enabled and the
  other one disabled, mirroring the loader's exclusive-slot rule

> 中文版本: see `README.zh.md`.

## Config file location

Resolution order (first match wins):

1. `--config <path>` CLI flag
2. `OPENCLAW_CONFIG_PATH` environment variable
3. `${OPENCLAW_STATE_DIR}/openclaw.json`
4. `~/.openclaw/openclaw.json` (default)

The config is parsed as JSON. Line (`//`) and block (`/* */`) comments are
tolerated, so JSON5-flavored configs round-trip safely (re-emitted as plain JSON).

## Commands

### Inspect the current backend

```bash
node scripts/switch-memory-backend/switch-memory-backend.mjs status
```

Sample output:

```text
Config:   /home/alice/.openclaw/openclaw.json
Slot:     plugins.slots.memory = "memory-core"
Entries:
  memory-core   enabled=true
  memory-milvus enabled=false
```

### Switch backends

```bash
# Switch to Milvus
node scripts/switch-memory-backend/switch-memory-backend.mjs to milvus

# Switch back to memory-core (default file-based backend)
node scripts/switch-memory-backend/switch-memory-backend.mjs to core

# Disable both memory plugins
node scripts/switch-memory-backend/switch-memory-backend.mjs to none
```

Aliases:

- `core`, `memory-core`
- `milvus`, `memory-milvus`
- `none`, `off`, `disable`

The script writes the new config in place and creates a timestamped backup
next to the original (e.g. `openclaw.json.bak.2026-05-12T08-30-00-123Z`).

### Useful flags

| Flag           | Description                                        |
| -------------- | -------------------------------------------------- |
| `--config <p>` | Override the config file path                      |
| `--dry-run`    | Print the resulting JSON to stdout without writing |
| `--no-backup`  | Skip the `.bak.<timestamp>` file                   |
| `-h`, `--help` | Show usage                                         |

### Examples

```bash
# Preview the change without touching the file
node scripts/switch-memory-backend/switch-memory-backend.mjs to milvus --dry-run

# Use a custom config path
node scripts/switch-memory-backend/switch-memory-backend.mjs to core --config ./tmp/openclaw.json

# Switch via env override
OPENCLAW_CONFIG_PATH=/srv/openclaw/openclaw.json \
  node scripts/switch-memory-backend/switch-memory-backend.mjs to milvus

# Switch without a backup file
node scripts/switch-memory-backend/switch-memory-backend.mjs to none --no-backup
```

## What the script writes

For `to milvus` the relevant fragment becomes:

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

For `to none` both entries become `enabled: false` and the slot value is
literally `"none"` — the loader treats this as "no active memory plugin".

The script never touches Milvus connection settings, embedding provider
config, or the per-plugin `config` block. It only flips the slot and the two
`enabled` flags.

## After switching

1. **Restart the gateway** so the loader picks up the new slot:
   ```bash
   openclaw gateway restart
   ```
2. **Verify** the active plugin:
   ```bash
   openclaw plugins list
   ```
3. **For Milvus**: ensure a Milvus server is reachable at
   `plugins.entries.memory-milvus.config.milvus.host:port`. If not, the
   plugin enters degraded mode (writes go to a local NDJSON fallback).

## Proving the active backend with official CLI commands

The script only edits the config file. To prove that the gateway is actually
running **memory-milvus** (not memory-core), use these five OpenClaw CLI
checks. Each layer rules out a different failure mode (config wrong /
slot mismatch / runtime not loaded / wrong plugin loaded / Milvus
unreachable).

### 1. Config layer — only memory-milvus is enabled

```bash
openclaw plugins list --enabled
```

Expected: a line like `memory-milvus enabled [openclaw] - ...` and
**no** line for `memory-core`.

For a one-shot machine-readable check:

```bash
openclaw plugins list --json
```

Look for both records:

```json
{ "id": "memory-milvus", "enabled": true,  "status": "loaded"   }
{ "id": "memory-core",   "enabled": false, "status": "disabled" }
```

### 2. Slot layer — memory-milvus owns the memory slot

```bash
openclaw plugins inspect memory-milvus --json
```

Key field to look for:

```json
{ "plugin": { "id": "memory-milvus", "memorySlotSelected": true } }
```

`memorySlotSelected: true` means the loader resolved
`plugins.slots.memory` to this plugin and gave it ownership of the
active memory slot.

### 3. Runtime layer — the plugin is actually loaded with its tools

```bash
openclaw plugins inspect memory-milvus --runtime
```

> The `--runtime` flag was added in 2026.5.10-beta.1. On older CLIs drop it
> and rely on the gateway logs check (step 5).

Expected output sections:

```text
Status: loaded
Capabilities: memory: (registered)
Tools:
  memory_write
  memory_search
  memory_get
```

All three tool names showing up means the ctx factory ran and the Manager
Pool successfully built a `MilvusSearchManager` for the current agent.

### 4. Negative check — memory-core is disabled by slot policy

```bash
openclaw plugins inspect memory-core --runtime
```

Expected:

```text
Status: disabled
error:  memory slot set to "memory-milvus"
```

This exact reason string proves that memory-core was **deliberately**
shut off by the slot resolver, not silently failing.

### 5. Gateway log layer — Milvus is connected, not degraded

```bash
openclaw gateway logs 2>&1 | Select-String "memory-milvus|degraded"
```

Good signs:

- `memory-milvus loaded` / tool registration lines
- No `degraded mode` / `dreaming manager lazy-init failed` warnings
- Milvus connect line pointing at your `host:port`

If you see `degraded mode`, the plugin is running but Milvus is unreachable
— writes are being mirrored to a local NDJSON fallback. Fix Milvus
connectivity, then restart the gateway and re-check steps 3 and 5.

### One-liner end-to-end proof (PowerShell)

```powershell
openclaw plugins list --enabled;
openclaw plugins inspect memory-milvus --json |
  ConvertFrom-Json |
  Select-Object -ExpandProperty plugin |
  Format-List id, status, memorySlotSelected;
openclaw plugins inspect memory-milvus --runtime;
openclaw gateway logs 2>&1 | Select-String "memory-milvus|degraded" | Select-Object -First 20
```

If step 1 shows only memory-milvus, step 2 prints `memorySlotSelected: True`,
step 3 lists all three tools under `Status: loaded`, and step 4 has no
`degraded` lines — the active backend is conclusively memory-milvus.

## Data is NOT migrated

Memory data is stored independently per backend:

- `memory-core` writes Markdown files under the workspace memory directory
- `memory-milvus` writes vectors + payloads to a Milvus collection

Switching the slot does **not** copy or convert data between them. To move
existing Markdown memories into Milvus, use the `memory-migrate` command.

## Exit codes

- `0` — success
- `1` — runtime error (config missing, parse failure, unknown target, etc.)
- `2` — unknown command

## Related

- `extensions/memory-milvus/README.md` — Milvus backend overview
- `extensions/memory-milvus/README.zh.md` — Chinese version
- `src/plugins/slots.ts` — the underlying `applyExclusiveSlotSelection` logic
