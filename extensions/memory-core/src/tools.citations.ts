import {
  parseAgentSessionKey,
  type MemoryCitationsMode,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { MemoryReference, MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

export function resolveMemoryCitationsMode(cfg: OpenClawConfig): MemoryCitationsMode {
  const mode = cfg.memory?.citations;
  if (mode === "on" || mode === "off" || mode === "auto") {
    return mode;
  }
  return "auto";
}

type CitationInput = { snippet: string; provenance?: { kind: string; label: string }; path?: string; startLine?: number; endLine?: number };

export function decorateCitations<T extends CitationInput>(
  results: T[],
  include: boolean,
): T[] {
  if (!include) {
    return results;
  }
  return results.map((entry) => {
    const citation = formatCitation(entry);
    const snippet = `${(entry.snippet ?? "").trim()}\n\nSource: ${citation}`;
    return { ...entry, snippet };
  });
}

export function formatCitation(entry: CitationInput): string {
  if (entry.provenance?.label) {
    return entry.provenance.label;
  }
  if (entry.path != null && entry.startLine != null && entry.endLine != null) {
    const lineRange =
      entry.startLine === entry.endLine
        ? `#L${entry.startLine}`
        : `#L${entry.startLine}-L${entry.endLine}`;
    return `${entry.path}${lineRange}`;
  }
  return "";
}

export function clampResultsByInjectedChars<T extends { snippet?: string }>(
  results: T[],
  budget?: number,
): T[] {
  if (!budget || budget <= 0) {
    return results;
  }
  let remaining = budget;
  const clamped: T[] = [];
  for (const entry of results) {
    if (remaining <= 0) {
      break;
    }
    const snippet = entry.snippet ?? "";
    if (snippet.length <= remaining) {
      clamped.push(entry);
      remaining -= snippet.length;
    } else {
      const trimmed = snippet.slice(0, Math.max(0, remaining));
      clamped.push({ ...entry, snippet: trimmed });
      break;
    }
  }
  return clamped;
}

export function shouldIncludeCitations(params: {
  mode: MemoryCitationsMode;
  sessionKey?: string;
}): boolean {
  if (params.mode === "on") {
    return true;
  }
  if (params.mode === "off") {
    return false;
  }
  return deriveChatTypeFromSessionKey(params.sessionKey) === "direct";
}

function deriveChatTypeFromSessionKey(sessionKey?: string): "direct" | "group" | "channel" {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed?.rest) {
    return "direct";
  }
  const tokens = new Set(normalizeLowercaseStringOrEmpty(parsed.rest).split(":").filter(Boolean));
  if (tokens.has("channel")) {
    return "channel";
  }
  if (tokens.has("group")) {
    return "group";
  }
  return "direct";
}
