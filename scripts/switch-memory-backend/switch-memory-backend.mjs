#!/usr/bin/env node
// Switch the active OpenClaw memory backend between memory-core / memory-milvus / none.
// Edits `plugins.slots.memory` and the corresponding `plugins.entries.<id>.enabled`
// in the OpenClaw config file. Creates a timestamped backup by default.

import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

const KNOWN_TARGETS = new Set(["memory-core", "memory-milvus", "none"]);
const ALIAS = {
  core: "memory-core",
  "memory-core": "memory-core",
  milvus: "memory-milvus",
  "memory-milvus": "memory-milvus",
  none: "none",
  off: "none",
  disable: "none",
};

function printUsage() {
  process.stdout.write(
    [
      "Usage:",
      "  node scripts/switch-memory-backend/switch-memory-backend.mjs status",
      "  node scripts/switch-memory-backend/switch-memory-backend.mjs to <core|milvus|none> [options]",
      "",
      "Options:",
      "  --config <path>   Override config file path (default: ~/.openclaw/openclaw.json)",
      "  --dry-run         Print the resulting JSON to stdout without writing",
      "  --no-backup       Do not create a .bak.<timestamp> copy before writing",
      "  -h, --help        Show this help",
      "",
      "Environment overrides:",
      "  OPENCLAW_CONFIG_PATH  Same as --config",
      "  OPENCLAW_STATE_DIR    Look for openclaw.json under this directory",
      "",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const args = { command: null, target: null, config: null, dryRun: false, backup: true };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      args.command = "help";
      continue;
    }
    if (a === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (a === "--no-backup") {
      args.backup = false;
      continue;
    }
    if (a === "--config") {
      args.config = argv[++i];
      continue;
    }
    if (a.startsWith("--config=")) {
      args.config = a.slice("--config=".length);
      continue;
    }
    rest.push(a);
  }
  if (rest.length > 0 && !args.command) {
    args.command = rest.shift();
  }
  if (args.command === "to" && rest.length > 0) {
    args.target = rest.shift();
  }
  return args;
}

function resolveConfigPath(cliPath) {
  if (cliPath && cliPath.trim().length > 0) return path.resolve(cliPath);
  const env = process.env.OPENCLAW_CONFIG_PATH?.trim();
  if (env) return path.resolve(env);
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim();
  if (stateDir) return path.resolve(stateDir, "openclaw.json");
  return path.join(homedir(), ".openclaw", "openclaw.json");
}

// Strip `// line` and `/* block */` comments so JSON5-style configs parse.
function stripComments(text) {
  let out = "";
  let i = 0;
  let inStr = false;
  let strCh = "";
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (inStr) {
      out += ch;
      if (ch === "\\" && i + 1 < text.length) {
        out += text[i + 1];
        i += 2;
        continue;
      }
      if (ch === strCh) inStr = false;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = true;
      strCh = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function loadConfig(configPath) {
  if (!existsSync(configPath)) {
    throw new Error(
      `Config file not found: ${configPath}\n` +
        `Run \`openclaw\` once or set OPENCLAW_CONFIG_PATH / --config <path>.`,
    );
  }
  let raw = readFileSync(configPath, "utf8");
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // strip UTF-8 BOM
  let cfg;
  try {
    cfg = JSON.parse(stripComments(raw));
  } catch (err) {
    throw new Error(`Failed to parse ${configPath}: ${(err && err.message) || err}`);
  }
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
    throw new Error(`Config root must be a JSON object: ${configPath}`);
  }
  return cfg;
}

function readSlot(cfg) {
  return cfg?.plugins?.slots?.memory ?? null;
}

function readEnabled(cfg, id) {
  return cfg?.plugins?.entries?.[id]?.enabled;
}

function applyTarget(cfg, target) {
  cfg.plugins ??= {};
  cfg.plugins.slots ??= {};
  cfg.plugins.entries ??= {};
  cfg.plugins.slots.memory = target;

  for (const id of ["memory-core", "memory-milvus"]) {
    cfg.plugins.entries[id] ??= {};
    if (target === "none") {
      cfg.plugins.entries[id].enabled = false;
    } else {
      cfg.plugins.entries[id].enabled = id === target;
    }
  }
  return cfg;
}

function backupFile(configPath) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${configPath}.bak.${ts}`;
  copyFileSync(configPath, backupPath);
  return backupPath;
}

function writeConfig(configPath, cfg) {
  const out = `${JSON.stringify(cfg, null, 2)}\n`;
  writeFileSync(configPath, out, "utf8");
}

function commandStatus(configPath) {
  const cfg = loadConfig(configPath);
  const slot = readSlot(cfg);
  process.stdout.write(
    [
      `Config:   ${configPath}`,
      `Slot:     plugins.slots.memory = ${JSON.stringify(slot)}`,
      `Entries:`,
      `  memory-core   enabled=${JSON.stringify(readEnabled(cfg, "memory-core"))}`,
      `  memory-milvus enabled=${JSON.stringify(readEnabled(cfg, "memory-milvus"))}`,
      "",
    ].join("\n"),
  );
}

function commandSwitch(configPath, rawTarget, opts) {
  if (!rawTarget) throw new Error("Missing target. Expected: core | milvus | none");
  const target = ALIAS[rawTarget.toLowerCase()] ?? rawTarget;
  if (!KNOWN_TARGETS.has(target)) {
    throw new Error(
      `Unknown target "${rawTarget}". Expected one of: core, milvus, none ` +
        `(or memory-core / memory-milvus).`,
    );
  }

  const cfg = loadConfig(configPath);
  const before = readSlot(cfg);
  applyTarget(cfg, target);
  const after = readSlot(cfg);

  if (opts.dryRun) {
    process.stdout.write(`# DRY RUN — would write to ${configPath}\n`);
    process.stdout.write(`# slot: ${JSON.stringify(before)} -> ${JSON.stringify(after)}\n`);
    process.stdout.write(`${JSON.stringify(cfg, null, 2)}\n`);
    return;
  }

  let backupPath = null;
  if (opts.backup) backupPath = backupFile(configPath);
  writeConfig(configPath, cfg);

  process.stdout.write(
    [
      `OK: switched memory backend`,
      `  config: ${configPath}`,
      `  slot:   ${JSON.stringify(before)} -> ${JSON.stringify(after)}`,
      backupPath ? `  backup: ${backupPath}` : `  backup: (skipped)`,
      ``,
      `Next: restart the OpenClaw gateway so the new slot takes effect.`,
      ``,
    ].join("\n"),
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.command || args.command === "help") {
    printUsage();
    process.exit(args.command ? 0 : 1);
  }
  const configPath = resolveConfigPath(args.config);
  try {
    if (args.command === "status") {
      commandStatus(configPath);
      return;
    }
    if (args.command === "to") {
      commandSwitch(configPath, args.target, { dryRun: args.dryRun, backup: args.backup });
      return;
    }
    process.stderr.write(`Unknown command: ${args.command}\n\n`);
    printUsage();
    process.exit(2);
  } catch (err) {
    process.stderr.write(`ERROR: ${(err && err.message) || err}\n`);
    process.exit(1);
  }
}

main();
