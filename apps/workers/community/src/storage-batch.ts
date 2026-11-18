/** Read independent room-local records together. Durable Object storage
 * returns a Map for array keys. The single-key fallback also supports older
 * in-memory adapters that implement only the scalar form of the API. */
export async function readStorageBatch<T>(
  storage: Pick<DurableObjectTransaction, "get">,
  keys: readonly string[],
): Promise<Map<string, T>> {
  if (!keys.length) return new Map();
  const values = await storage.get<T>([...keys]);
  if (values instanceof Map) return values;
  const entries = await Promise.all(
    keys.map(async (key) => [key, await storage.get<T>(key)] as const),
  );
  const result = new Map<string, T>();
  for (const [key, value] of entries)
    if (value !== undefined) result.set(key, value as T);
  return result;
}
