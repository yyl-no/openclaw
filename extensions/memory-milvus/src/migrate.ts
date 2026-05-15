/** Bidirectional markdown ↔ Milvus migration CLI. */

import { readFile, readdir, mkdir, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import type { MilvusClient, QueryReq } from "@zilliz/milvus2-sdk-node";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

import {
  FIELD_CONTENT_HASH,
  FIELD_ID,
  FIELD_TEXT,
  FIELD_SNIPPET,
  FIELD_AGENT_ID,
  FIELD_MEMORY_TYPE,
  FIELD_PROVENANCE_KIND,
  FIELD_PROVENANCE_LABEL,
  FIELD_CREATED_AT,
  FIELD_SESSION_KEY,
  FIELD_RECALL_COUNT,
  FIELD_UPDATED_AT,
  FIELD_LAST_RECALLED_AT,
  computeContentHash,
} from "./schema.js";
import {
  MilvusSearchManager,
  createMilvusClient,
  type MilvusSearchConfig,
} from "./search.js";
import { ensureCollectionReady } from "./collection-bootstrap.js";
import { MEMORY_TYPES } from "./types.js";

// ── Types ─────────────────────────────────────────────────────────

/** Migration result statistics. */
export interface MigrationResult {
  /** Entries successfully inserted into Milvus */
  inserted: number;
  /** Entries skipped due to dedup */
  skipped: number;
  /** Write failures */
  failed: number;
  /** Files processed (forward) or files written (reverse) */
  files: number;
}

/** Markdown chunk after splitting by heading / paragraph boundaries. */
interface FileChunk {
  /** 1-based start line */
  startLine: number;
  /** 1-based end line (inclusive) */
  endLine: number;
  /** Chunk text */
  text: string;
  /** Closest preceding heading (e.g., "## Section Name") */
  heading: string | null;
}

// ── File scanning ─────────────────────────────────────────────────

/** memory/YYYY-MM-DD.md filename pattern */
const DAILY_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}\.md$/;

/**
 * Recursively scan a directory for MEMORY.md and memory/YYYY-MM-DD.md files.
 * Returns file paths sorted lexicographically (MEMORY.md first, then by date).
 */
async function scanMemoryFiles(dir: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(current: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(current);
    } catch {
      return;
    }

    for (const name of entries) {
      const fullPath = path.join(current, name);
      let entryStat;
      try {
        entryStat = await stat(fullPath);
      } catch {
        continue;
      }
      if (entryStat.isDirectory()) {
        if (name === "memory" || name === ".milvus-fallback") {
          await walk(fullPath);
        }
      } else if (entryStat.isFile()) {
        const rel = path.relative(dir, fullPath).replace(/\\/g, "/");
        if (rel === "MEMORY.md" || DAILY_FILE_PATTERN.test(name)) {
          files.push(fullPath);
        }
      }
    }
  }

  await walk(dir);

  // Lexicographic: MEMORY.md first, then by date
  return files.sort((a, b) => {
    const ra = path.relative(dir, a).replace(/\\/g, "/");
    const rb = path.relative(dir, b).replace(/\\/g, "/");
    if (ra === "MEMORY.md") return -1;
    if (rb === "MEMORY.md") return 1;
    return ra.localeCompare(rb);
  });
}

// ── Markdown chunking ─────────────────────────────────────────────

/**
 * Split markdown lines into semantic chunks.
 *
 * Strategy:
 * - `## ` / `### ` lines start a new chunk and set the heading
 * - Blank lines start a new chunk (paragraph boundary)
 * - Consecutive non-blank lines accumulate into one chunk
 * - Chunks shorter than 20 characters are discarded as noise
 */
function chunkMarkdown(lines: string[]): FileChunk[] {
  const chunks: FileChunk[] = [];
  let heading: string | null = null;
  let chunkLines: string[] = [];
  let chunkStartLine = 0;

  const flush = (endLine: number) => {
    if (chunkLines.length === 0) {
      chunkStartLine = endLine + 1;
      return;
    }
    const body = chunkLines.join(" ").replace(/\s+/g, " ").trim();
    // Minimum chunk size filter (skip noise shorter than 20 chars)
    if (body.length < 20) {
      chunkLines = [];
      chunkStartLine = endLine + 1;
      return;
    }
    const text = heading ? `${heading}: ${body}` : body;
    chunks.push({
      startLine: chunkStartLine,
      endLine,
      text,
      heading,
    });
    chunkLines = [];
    chunkStartLine = endLine + 1;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1; // 1-based

    // Heading detection
    const hMatch = /^(#{2,3})\s+(.+)/.exec(line);
    if (hMatch) {
      flush(lineNum - 1);
      heading = hMatch[2].trim();
      chunkStartLine = lineNum;
      continue;
    }

    const trimmed = line.trim();

    // Blank line → flush current chunk
    if (!trimmed) {
      flush(lineNum);
      continue;
    }

    // List item or regular line → accumulate
    if (chunkLines.length === 0) {
      chunkStartLine = lineNum;
    }
    // Strip list bullet marker
    const content = /^[-*]\s+/.test(trimmed)
      ? trimmed.replace(/^[-*]\s+/, "")
      : trimmed;
    chunkLines.push(content);
  }

  // Final flush
  flush(lines.length);

  return chunks;
}

// ── Dedup ─────────────────────────────────────────────────────────

/** Dedup key: content_hash via SHA-256(text + "\0" + provenance_label), matches schema.ts. */
const dedupKey = computeContentHash;

// ── Forward: Markdown → Milvus ───────────────────────────────────

/**
 * Forward migration: scan markdown files → chunk → embed → write to Milvus.
 */
export async function migrateMarkdownToMilvus(
  manager: MilvusSearchManager,
  client: MilvusClient,
  collectionName: string,
  inputDir: string,
  opts: { dryRun?: boolean } = {},
): Promise<MigrationResult> {
  const result: MigrationResult = { inserted: 0, skipped: 0, failed: 0, files: 0 };

  const files = await scanMemoryFiles(inputDir);
  if (files.length === 0) {
    console.warn("[memory-milvus] No MEMORY.md or memory/*.md files found in", inputDir);
    return result;
  }

  result.files = files.length;
  const seenHashes = new Set<string>(); // in-batch dedup

  for (const filePath of files) {
    const relPath = path.relative(inputDir, filePath).replace(/\\/g, "/");
    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch (err) {
      console.warn(`[memory-milvus] Failed to read ${relPath}:`, (err as Error).message);
      result.failed++;
      continue;
    }

    const lines = content.split("\n");
    const chunks = chunkMarkdown(lines);

    for (let ci = 0; ci < chunks.length; ci++) {
      const chunk = chunks[ci];
      const provenanceLabel = `${relPath}:${chunk.startLine}:${chunk.endLine}`;
      const dKey = dedupKey(chunk.text, provenanceLabel);

      // In-batch dedup
      if (seenHashes.has(dKey)) {
        result.skipped++;
        if (!opts.dryRun) {
          console.log(`[${ci + 1}/${chunks.length}] file=${relPath} action=skip:dup-in-batch`);
        }
        continue;
      }
      seenHashes.add(dKey);

      // Cross-batch dedup: check content_hash in Milvus
      if (!opts.dryRun) {
        try {
          const existing = await client.query({
            collection_name: collectionName,
            filter: `${FIELD_CONTENT_HASH} == "${dKey.replace(/"/g, '\\"')}"`,
            output_fields: [FIELD_ID],
            limit: 1,
          } as QueryReq);
          if (existing.data && existing.data.length > 0) {
            result.skipped++;
            console.log(`[${ci + 1}/${chunks.length}] file=${relPath} action=skip:dup-cross-batch`);
            continue;
          }
        } catch (err) {
          // Fallback: content_hash not yet on schema → try provenance_label
          try {
            const existing = await client.query({
              collection_name: collectionName,
              filter: `${FIELD_PROVENANCE_LABEL} == "${provenanceLabel.replace(/"/g, '\\"')}"`,
              output_fields: [FIELD_ID],
              limit: 1,
            } as QueryReq);
            if (existing.data && existing.data.length > 0) {
              result.skipped++;
              console.log(`[${ci + 1}/${chunks.length}] file=${relPath} action=skip:dup-cross-batch(label-fallback)`);
              continue;
            }
          } catch {
            // Both failed — proceed with insert
          }
        }
      }

      // Dry-run: only count
      if (opts.dryRun) {
        result.inserted++;
        console.log(`[${ci + 1}/${chunks.length}] file=${relPath} action=would-insert`);
        continue;
      }

      // Write to Milvus
      try {
        await manager.write({
          text: chunk.text,
          snippet: chunk.text.slice(0, 200),
          memoryType: MEMORY_TYPES.SHORT_TERM,
          provenance: {
            kind: "file",
            label: provenanceLabel,
          },
        });

        // We also need to set the source label to IMPORT via provenance
        // But write() only sets provenance.kind/label, not source label.
        // The IMPORT designation is tracked via provenance.label convention.
        result.inserted++;
        console.log(`[${ci + 1}/${chunks.length}] file=${relPath} action=insert`);
      } catch (err) {
        result.failed++;
        console.warn(
          `[${ci + 1}/${chunks.length}] file=${relPath} action=fail:`,
          (err as Error).message,
        );
      }
    }
  }

  // Summary
  const dryLabel = opts.dryRun ? " (dry-run)" : "";
  console.log(
    `\n[Migration${dryLabel}] inserted=${result.inserted} skipped=${result.skipped} failed=${result.failed} files=${result.files}`,
  );

  return result;
}

// ── Reverse: Milvus → Markdown ──────────────────────────────────

/** Page size for reverse migration queries. */
const REVERSE_PAGE_SIZE = 500;

/**
 * Reverse migration: export all entries from Milvus → markdown files.
 *
 * Output structure:
 * ```
 * memory-export/<timestamp>/
 *   MEMORY.md          ← long_term entries (merged)
 *   memory/
 *     YYYY-MM-DD.md    ← short_term entries (grouped by createdAt date)
 * ```
 */
export async function migrateMilvusToMarkdown(
  client: MilvusClient,
  collectionName: string,
  outputDir: string,
  opts: { type?: string } = {},
): Promise<MigrationResult> {
  const result: MigrationResult = { inserted: 0, skipped: 0, failed: 0, files: 0 };
  const filterType = opts.type ?? "all";

  // Paginate all entries via offset
  const allEntries: Array<Record<string, unknown>> = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const typeFilter = filterType !== "all"
      ? `${FIELD_MEMORY_TYPE} == "${filterType}"`
      : undefined;

    try {
      const response = await client.query({
        collection_name: collectionName,
        filter: typeFilter ?? "",
        output_fields: [
          FIELD_ID,
          FIELD_TEXT,
          FIELD_SNIPPET,
          FIELD_AGENT_ID,
          FIELD_MEMORY_TYPE,
          FIELD_PROVENANCE_KIND,
          FIELD_PROVENANCE_LABEL,
          FIELD_CREATED_AT,
          FIELD_SESSION_KEY,
          FIELD_RECALL_COUNT,
          FIELD_UPDATED_AT,
          FIELD_LAST_RECALLED_AT,
        ],
        limit: REVERSE_PAGE_SIZE,
        offset,
      } as QueryReq);

      const page = (response.data ?? []) as Record<string, unknown>[];
      allEntries.push(...page);
      offset += REVERSE_PAGE_SIZE;
      hasMore = page.length === REVERSE_PAGE_SIZE;
    } catch (err) {
      console.warn(
        `[memory-milvus] Reverse migration query failed at offset ${offset}:`,
        (err as Error).message,
      );
      break;
    }
  }

  if (allEntries.length === 0) {
    console.warn("[memory-milvus] No entries found in Milvus for export.");
    return result;
  }

  // Classify: long_term → MEMORY.md, short_term + archived → memory/YYYY-MM-DD.md
  const longTermEntries: Array<Record<string, unknown>> = [];
  const dateGrouped = new Map<string, Array<Record<string, unknown>>>();

  for (const row of allEntries) {
    const memType = String(row[FIELD_MEMORY_TYPE] ?? "");
    if (memType === MEMORY_TYPES.LONG_TERM) {
      longTermEntries.push(row);
    } else {
      // short_term, archived, or unknown → group by date
      const createdAt = String(row[FIELD_CREATED_AT] ?? "");
      const date = createdAt.slice(0, 10); // YYYY-MM-DD
      if (!date) continue;
      const group = dateGrouped.get(date) ?? [];
      group.push(row);
      dateGrouped.set(date, group);
    }
  }

  // Write output directory
  await mkdir(path.join(outputDir, "memory"), { recursive: true });

  // MEMORY.md (long_term entries)
  if (longTermEntries.length > 0) {
    const memLines: string[] = [
      "# Memory Export",
      `# Exported at ${new Date().toISOString()}`,
      "",
      "## Long-term Memories",
      "",
    ];
    for (const row of longTermEntries) {
      const text = String(row[FIELD_TEXT] ?? "");
      const provenance = String(row[FIELD_PROVENANCE_LABEL] ?? "");
      memLines.push(`- ${text}${provenance ? `  *(source: ${provenance})*` : ""}`);
    }
    memLines.push("");

    await writeFile(path.join(outputDir, "MEMORY.md"), memLines.join("\n"), "utf-8");
    result.files++;
    result.inserted += longTermEntries.length;
  }

  // memory/YYYY-MM-DD.md (grouped by date)
  for (const [date, rows] of dateGrouped.entries()) {
    const lines: string[] = [
      `## ${date}`,
      "",
    ];
    for (const row of rows) {
      const text = String(row[FIELD_TEXT] ?? "");
      const memType = String(row[FIELD_MEMORY_TYPE] ?? "");
      const provenance = String(row[FIELD_PROVENANCE_LABEL] ?? "");
      const typeTag = memType === MEMORY_TYPES.ARCHIVED ? "[archived] " : "";
      lines.push(`- ${typeTag}${text}${provenance ? `  *(source: ${provenance})*` : ""}`);
    }
    lines.push("");

    await writeFile(
      path.join(outputDir, "memory", `${date}.md`),
      lines.join("\n"),
      "utf-8",
    );
    result.files++;
    result.inserted += rows.length;
  }

  console.log(
    `\n[Reverse migration] exported=${result.inserted} files=${result.files} output=${outputDir}`,
  );

  return result;
}

// ── CLI registration ──────────────────────────────────────────────

/**
 * Register the `migrate <dir>` subcommand on the commander program.
 * Called from index.ts via api.registerCli.
 */
export function registerMigrationCli(
  program: Command,
  cfg: OpenClawConfig,
): void {
  program
    .command("migrate <dir>")
    .description("Migrate memory files between Markdown and Milvus")
    .option("--reverse", "Export from Milvus back to Markdown")
    .option("--dry-run", "Preview the migration without writing any data")
    .option(
      "--type <type>",
      "Filter by memory type (reverse only: short_term|long_term|archived|all)",
      "all",
    )
    .action(async (dir: string, options: Record<string, string | boolean>) => {
      const reverse = Boolean(options.reverse);
      const dryRun = Boolean(options.dryRun);
      const type = String(options.type ?? "all");

      // Resolve agent ID from config (use "default" as fallback)
      const agentsDefaults = cfg.agents?.defaults;
      const agentId = typeof agentsDefaults === "object" && agentsDefaults !== null
        ? String((agentsDefaults as Record<string, unknown>).agentId ?? "default")
        : "default";

      try {
        // Validate input directory exists (forward mode only)
        if (!reverse) {
          const dirStat = await stat(dir).catch(() => null);
          if (!dirStat?.isDirectory()) {
            console.error(`Error: "${dir}" is not a valid directory.`);
            process.exit(1);
          }
        }

        // Read plugin config
        const pluginEntry = cfg.plugins?.entries?.["memory-milvus"];
        if (!pluginEntry || typeof pluginEntry !== "object") {
          console.error("Error: memory-milvus plugin not configured.");
          process.exit(1);
        }
        const rawConfig = (pluginEntry as Record<string, unknown>).config;
        if (!rawConfig || typeof rawConfig !== "object") {
          console.error("Error: memory-milvus plugin config missing.");
          process.exit(1);
        }

        const milvus = (rawConfig as Record<string, unknown>).milvus as Record<string, unknown> | undefined;
        const embedding = (rawConfig as Record<string, unknown>).embedding as Record<string, unknown> | undefined;

        const searchCfg: MilvusSearchConfig = {
          host: String(milvus?.host ?? "localhost"),
          port: Number(milvus?.port ?? 19530) || 19530,
          collectionName: String(milvus?.collectionName ?? "openclaw_memory"),
          embedding: {
            provider: String(embedding?.provider ?? "auto"),
            model: String(embedding?.model ?? "text-embedding-v3"),
            dimensions: embedding?.dimensions != null ? Number(embedding.dimensions) : undefined,
          },
        };

        // Create Milvus client
        const client = createMilvusClient(searchCfg.host, searchCfg.port);

        if (reverse) {
          // Reverse: Milvus → Markdown
          const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
          const exportDir = path.resolve(dir, `memory-export/${timestamp}`);
          await migrateMilvusToMarkdown(client, searchCfg.collectionName, exportDir, { type });
        } else {
          // Forward: Markdown → Milvus
          // For forward migration we need the embedding provider
          // Dynamic import to avoid loading heavy deps when not needed
          const { getMemoryEmbeddingProvider } = await import(
            "openclaw/plugin-sdk/memory-core-host-engine-embeddings"
          );
          const adapter = getMemoryEmbeddingProvider(searchCfg.embedding.provider, cfg);
          if (!adapter) {
            console.error(
              `Error: Unknown memory embedding provider: ${searchCfg.embedding.provider}`,
            );
            process.exit(1);
          }

          const { resolveAgentWorkspaceDir } = await import(
            "openclaw/plugin-sdk/memory-core-host-engine-foundation"
          );
          const agentDir = resolveAgentWorkspaceDir(cfg, agentId);

          const providerResult = await adapter.create({
            config: cfg,
            agentDir,
            provider: searchCfg.embedding.provider,
            fallback: "none",
            model: searchCfg.embedding.model,
            ...(searchCfg.embedding.dimensions
              ? { outputDimensionality: searchCfg.embedding.dimensions }
              : {}),
          });

          if (!providerResult.provider) {
            console.error(
              `Error: Memory embedding provider ${searchCfg.embedding.provider} is unavailable.`,
            );
            process.exit(1);
          }

          // Ensure collection is ready
          try {
            await ensureCollectionReady(client, {
              collectionName: searchCfg.collectionName,
              embeddingDim: searchCfg.embedding.dimensions ?? 1024,
            });
          } catch (err) {
            console.error(
              "Error: Failed to connect to Milvus or prepare collection:",
              (err as Error).message,
            );
            process.exit(1);
          }

          const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
          const manager = new MilvusSearchManager(
            client,
            searchCfg.collectionName,
            providerResult.provider,
            agentId,
            searchCfg,
            workspaceDir,
          );

          await migrateMarkdownToMilvus(manager, client, searchCfg.collectionName, dir, { dryRun });

          await manager.close();
        }
      } catch (err) {
        console.error("Migration error:", (err as Error).message ?? err);
        process.exit(1);
      }
    });
}
