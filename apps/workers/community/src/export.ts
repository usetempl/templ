import { HttpError } from "./common";

export function exportPolicy() {
  return { pageSize: 100, nextRequestAfterMs: 1000, roomRequests: 2 };
}

/** Ordinary reads retain their smaller page bound. Export has no plan paywall. */
export function messagePagination(url: URL, maximum = 50) {
  const before = url.searchParams.get("before");
  const raw = url.searchParams.get("limit") ?? String(maximum);
  if (
    url.searchParams.getAll("before").length > 1 ||
    url.searchParams.getAll("limit").length > 1 ||
    !/^[1-9][0-9]{0,2}$/.test(raw) ||
    Number(raw) > maximum ||
    (before !== null &&
      (!/^[1-9][0-9]{0,14}$/.test(before) ||
        !Number.isSafeInteger(Number(before))))
  )
    throw new HttpError(400, "Invalid message pagination.");
  return { before, limit: Number(raw) };
}

type ExportRate = {
  now: number;
  room: number[];
  principals: Record<string, number>;
};
type Storage = Pick<DurableObjectTransaction, "get" | "put">;
/** One bounded row per room; successful admission shares the read transaction. */
export async function admitExport(
  storage: Storage,
  actor: string,
  currentTime = Date.now(),
  servicePrincipals: readonly string[] = [actor],
) {
  const policy = exportPolicy();
  const previous = await storage.get<ExportRate>("export-rate-v1");
  const now = Math.max(currentTime, previous?.now ?? 0);
  const room = (previous?.room ?? []).filter((at) => at > now - 1000);
  const principals = Object.fromEntries(
    Object.entries(previous?.principals ?? {}).filter(
      ([, until]) => until > now,
    ),
  );
  const next = Math.max(
    ...servicePrincipals.map((id) => principals[id] ?? 0),
    room.length >= policy.roomRequests ? room[0] + 1000 : 0,
  );
  if (next > now)
    throw new HttpError(
      429,
      "Export is moving too quickly. Try again shortly.",
      Math.max(1, Math.ceil((next - now) / 1000)),
    );
  for (const id of servicePrincipals)
    principals[id] = now + policy.nextRequestAfterMs;
  await storage.put("export-rate-v1", {
    now,
    room: [...room, now],
    principals,
  });
  return policy;
}
