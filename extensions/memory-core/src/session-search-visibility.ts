import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { MemoryReference, MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import {
  extractTranscriptIdentityFromSessionsMemoryHit,
  loadCombinedSessionStoreForGateway,
  resolveTranscriptStemToSessionKeys,
} from "openclaw/plugin-sdk/session-transcript-hit";
import {
  createAgentToAgentPolicy,
  createSessionVisibilityGuard,
  resolveEffectiveSessionToolsVisibility,
} from "openclaw/plugin-sdk/session-visibility";

type SearchHit = { source?: string; path?: string; id?: string };

function hitFilePath(hit: SearchHit): string {
  if (hit.path) return hit.path;
  if (hit.id?.startsWith("file:")) {
    const inner = hit.id.slice("file:".length);
    const c1 = inner.lastIndexOf(":");
    const c2 = inner.lastIndexOf(":", c1 - 1);
    if (c2 >= 0) return inner.slice(0, c2);
    return inner;
  }
  return "";
}

export async function filterMemorySearchHitsBySessionVisibility(params: {
  cfg: OpenClawConfig;
  requesterSessionKey: string | undefined;
  sandboxed: boolean;
  hits: (MemorySearchResult | MemoryReference)[];
}): Promise<(MemorySearchResult | MemoryReference)[]> {
  const visibility = resolveEffectiveSessionToolsVisibility({
    cfg: params.cfg,
    sandboxed: params.sandboxed,
  });
  const a2aPolicy = createAgentToAgentPolicy(params.cfg);
  const guard = params.requesterSessionKey
    ? await createSessionVisibilityGuard({
        action: "history",
        requesterSessionKey: params.requesterSessionKey,
        visibility,
        a2aPolicy,
      })
    : null;

  const { store: combinedSessionStore } = loadCombinedSessionStoreForGateway(params.cfg);

  const next: (MemorySearchResult | MemoryReference)[] = [];
  for (const hit of params.hits) {
    if (hit.source !== "sessions") {
      next.push(hit);
      continue;
    }
    if (!params.requesterSessionKey || !guard) {
      continue;
    }
    const identity = extractTranscriptIdentityFromSessionsMemoryHit(hitFilePath(hit));
    if (!identity) {
      continue;
    }
    const keys = resolveTranscriptStemToSessionKeys({
      store: combinedSessionStore,
      stem: identity.stem,
      ...(identity.archived && identity.ownerAgentId
        ? { archivedOwnerAgentId: identity.ownerAgentId }
        : {}),
    });
    if (keys.length === 0) {
      continue;
    }
    const allowed = keys.some((key) => guard.check(key).allowed);
    if (!allowed) {
      continue;
    }
    next.push(hit);
  }
  return next;
}
