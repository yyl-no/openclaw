/**
 * Key-based 去重 console.warn helper。
 *
 * 同一个 key 只 warn 一次，避免刷屏。
 * 用于 degraded / corpus 不支持 / citation 缺失等一次性提醒。
 */

const warnedKeys = new Set<string>();

export function warnOnce(key: string, message: string): void {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  console.warn(`[memory-milvus] ${message}`);
}
