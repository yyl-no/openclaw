import {
  freezeDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../../../infra/diagnostic-trace-context.js";
import type { EmbeddedRunTrigger } from "./params.js";

export function buildEmbeddedAttemptToolRunContext(params: {
  trigger?: EmbeddedRunTrigger;
  jobId?: string;
  memoryFlushWritePath?: string;
  memoryFlushBackendKind?: "file" | "milvus";
  toolsAllow?: string[];
  trace?: DiagnosticTraceContext;
}): {
  trigger?: EmbeddedRunTrigger;
  jobId?: string;
  memoryFlushWritePath?: string;
  memoryFlushBackendKind?: "file" | "milvus";
  runtimeToolAllowlist?: string[];
  trace?: DiagnosticTraceContext;
} {
  return {
    trigger: params.trigger,
    jobId: params.jobId,
    memoryFlushWritePath: params.memoryFlushWritePath,
    memoryFlushBackendKind: params.memoryFlushBackendKind,
    ...(params.toolsAllow ? { runtimeToolAllowlist: params.toolsAllow } : {}),
    ...(params.trace ? { trace: freezeDiagnosticTraceContext(params.trace) } : {}),
  };
}
