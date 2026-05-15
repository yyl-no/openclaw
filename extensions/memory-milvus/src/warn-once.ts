/** Deduplicated console.warn helper — each key fires at most once. */

const warnedKeys = new Set<string>();

export function warnOnce(key: string, message: string): void {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  console.warn(`[memory-milvus] ${message}`);
}
