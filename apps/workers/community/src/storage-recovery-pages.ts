/** Recovery pages keep growing financial history out of single storage values and requests. */
import { HttpError } from "./common";
import {
  checkedKeptState,
  keptEntries,
  type RecoveryKeptEntry,
  type RecoveryKeptReader,
} from "./storage-recovery-keys";

type Storage = Pick<
  DurableObjectTransaction,
  "get" | "put" | "list" | "delete"
>;
export type RecoveryPages = { id: string; pages: number; digest: string };
export const RECOVERY_SNAPSHOT_GROUPS = [
  "staff",
  "roles",
  "bans",
  "mutes",
  "stops",
  "ai",
] as const;
type SnapshotGroup = (typeof RECOVERY_SNAPSHOT_GROUPS)[number];
type PageEntry = [RecoveryKeptEntry[0] | SnapshotGroup, string, unknown];
const ID = /^[0-9a-f]{32}:(restore|undo):[0-9a-f]{32}$/;
const HASH = /^[0-9a-f]{64}$/;
const PAGE_CHARS = 24_000;
const EMPTY_DIGEST = "0".repeat(64);
export const recoverySnapshotKey = (op: string) =>
  `recovery-current-snapshot-v1:${op}`;
export const recoveryPageKey = (id: string, index: number) =>
  `recovery-kept-page-v1:${id}:${String(index).padStart(12, "0")}`;
const stagePrefix = (id: string) => `recovery-kept-stage-v1:${id}:`;
const draftKey = (id: string) => `recovery-kept-draft-v1:${id}`;
const tailPrefix = (id: string) => `${stagePrefix(id)}tail:`;
const progressKey = (id: string) => `${stagePrefix(id)}progress`;
const rowPrefix = (id: string, group: string) => `${stagePrefix(id)}${group}:`;
const rowKey = (id: string, group: string, key: string) =>
  rowPrefix(id, group) + key;
const invalid = () =>
  new HttpError(409, "The recovery snapshot is incomplete or changed.");
export async function recoveryPageDigest(previous: string, page: string) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(previous + JSON.stringify(page)),
  );
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
export function checkedRecoveryPages(input: unknown): RecoveryPages {
  const value = input as RecoveryPages | null;
  if (
    !value ||
    !ID.test(value.id) ||
    !Number.isSafeInteger(value.pages) ||
    value.pages < 0 ||
    !HASH.test(value.digest)
  )
    throw invalid();
  return { id: value.id, pages: value.pages, digest: value.digest };
}
export function checkedRecoveryPage(page: unknown): string {
  if (typeof page !== "string" || page.length > PAGE_CHARS) throw invalid();
  return page;
}

/** The caller holds the same transaction used to capture current access. */
export async function saveRecoveryPages(
  storage: Storage,
  op: string,
  groups: Partial<Record<SnapshotGroup, Record<string, unknown>>> = {},
): Promise<RecoveryPages> {
  const drafts = await storage.list<{ id: string; expiresAt: number }>({
    prefix: "recovery-kept-draft-v1:",
  });
  for (const draft of drafts.values())
    if (draft.expiresAt <= Date.now())
      await clearRecoveryPages(storage, draft.id);
  const id = `${op}:${crypto.randomUUID().replaceAll("-", "")}`;
  const result = checkedRecoveryPages({ id, pages: 0, digest: EMPTY_DIGEST });
  let pending = "";
  const put = async (page: string) => {
    await storage.put(recoveryPageKey(id, result.pages++), page);
    result.digest = await recoveryPageDigest(result.digest, page);
  };
  async function* entries(): AsyncGenerator<PageEntry> {
    for (const group of RECOVERY_SNAPSHOT_GROUPS)
      for (const [key, value] of Object.entries(groups[group] ?? {}))
        yield [group, key, value];
    yield* keptEntries(storage);
  }
  for await (const entry of entries()) {
    pending += JSON.stringify(entry) + "\n";
    while (pending.length >= PAGE_CHARS) {
      await put(pending.slice(0, PAGE_CHARS));
      pending = pending.slice(PAGE_CHARS);
    }
  }
  if (pending) await put(pending);
  await storage.put(draftKey(id), { id, expiresAt: Date.now() + 86_400_000 });
  return result;
}

type Progress = RecoveryPages & {
  next: number;
  currentDigest: string;
  tailParts: number;
};
function checkedEntry(input: unknown): PageEntry {
  if (
    !Array.isArray(input) ||
    input.length !== 3 ||
    !["kept", "off", "destinations", ...RECOVERY_SNAPSHOT_GROUPS].includes(
      input[0],
    ) ||
    typeof input[1] !== "string" ||
    input[2] === undefined
  )
    throw invalid();
  const [group, key, value] = input as PageEntry;
  if (["kept", "off", "destinations"].includes(group))
    checkedKeptState({
      kept: {},
      off: {},
      destinations: {},
      [group]: { [key]: value },
    });
  return [group, key, value];
}

/** A retry restages the same pages. Any incomplete page leaves the workspace locked. */
export async function stageRecoveryPage(
  storage: Storage,
  raw: unknown,
  index: number,
  input: unknown,
) {
  const pages = checkedRecoveryPages(raw),
    page = checkedRecoveryPage(input);
  if (!Number.isSafeInteger(index) || index < 0 || index >= pages.pages)
    throw invalid();
  let progress = await storage.get<Progress>(progressKey(pages.id));
  if (!progress)
    progress = { ...pages, next: 0, currentDigest: EMPTY_DIGEST, tailParts: 0 };
  if (
    progress.pages !== pages.pages ||
    progress.digest !== pages.digest ||
    index > progress.next
  )
    throw invalid();
  if (index < progress.next) {
    if ((await storage.get(recoveryPageKey(pages.id, index))) !== page)
      throw invalid();
    return;
  }
  let tail = "";
  for (let part = 0; part < progress.tailParts; part++) {
    const value = await storage.get<string>(`${tailPrefix(pages.id)}${part}`);
    if (typeof value !== "string") throw invalid();
    tail += value;
  }
  const text = tail + page;
  const end = text.lastIndexOf("\n") + 1;
  for (const line of text.slice(0, end).split("\n")) {
    if (!line) continue;
    let entry: PageEntry;
    try {
      entry = checkedEntry(JSON.parse(line));
    } catch {
      throw invalid();
    }
    const [group, key, value] = entry;
    const target = rowKey(pages.id, group, key);
    if ((await storage.get(target)) !== undefined) throw invalid();
    await storage.put(target, value);
  }
  const remainder = text.slice(end);
  const previousParts = progress.tailParts;
  progress.tailParts = Math.ceil(remainder.length / PAGE_CHARS);
  for (
    let part = 0;
    part < Math.max(previousParts, progress.tailParts);
    part++
  ) {
    const key = `${tailPrefix(pages.id)}${part}`;
    if (part < progress.tailParts)
      await storage.put(
        key,
        remainder.slice(part * PAGE_CHARS, (part + 1) * PAGE_CHARS),
      );
    else await storage.delete(key);
  }
  progress.currentDigest = await recoveryPageDigest(
    progress.currentDigest,
    page,
  );
  progress.next++;
  if (
    progress.next === pages.pages &&
    (progress.tailParts || progress.currentDigest !== pages.digest)
  )
    throw invalid();
  await storage.put(recoveryPageKey(pages.id, index), page);
  await storage.put(progressKey(pages.id), progress);
}

export async function recoveryPagesReader(
  storage: Storage,
  raw: unknown,
): Promise<RecoveryKeptReader> {
  const pages = checkedRecoveryPages(raw);
  const progress = await storage.get<Progress>(progressKey(pages.id));
  if (
    pages.pages
      ? !progress ||
        progress.next !== pages.pages ||
        progress.digest !== pages.digest ||
        progress.currentDigest !== pages.digest ||
        progress.tailParts
      : pages.digest !== EMPTY_DIGEST
  )
    throw invalid();
  return {
    get: (group, key) => storage.get(rowKey(pages.id, group, key)),
    entries: (group) => stagedEntries(storage, pages.id, group),
  };
}
export async function recoveryStagedNext(storage: Storage, raw: unknown) {
  const pages = checkedRecoveryPages(raw);
  const progress = await storage.get<Progress>(progressKey(pages.id));
  if (!progress) return 0;
  if (progress.pages !== pages.pages || progress.digest !== pages.digest)
    throw invalid();
  return progress.next;
}
export async function clearRecoveryPages(storage: Storage, id: string) {
  await storage.delete(draftKey(id));
  const key = recoverySnapshotKey(id.split(":").slice(0, 2).join(":"));
  if (
    (await storage.get<{ keptPages?: RecoveryPages }>(key))?.keptPages?.id ===
    id
  )
    await storage.delete(key);
  for (const prefix of [stagePrefix(id), `recovery-kept-page-v1:${id}:`]) {
    for (;;) {
      const page = await storage.list({ prefix, limit: 128 });
      if (!page.size) break;
      await storage.delete([...page.keys()]);
    }
  }
}

async function* stagedEntries(
  storage: Storage,
  id: string,
  group: string,
): AsyncGenerator<[string, unknown]> {
  const prefix = rowPrefix(id, group);
  let startAfter: string | undefined;
  for (;;) {
    const page = await storage.list({
      prefix,
      limit: 128,
      ...(startAfter ? { startAfter } : {}),
    });
    for (const [key, value] of page) {
      startAfter = key;
      yield [key.slice(prefix.length), value];
    }
    if (page.size < 128) return;
  }
}
export async function recoverySnapshotGroups(
  storage: Storage,
  pages: RecoveryPages,
) {
  const groups = {} as Record<SnapshotGroup, Record<string, unknown>>;
  for (const group of RECOVERY_SNAPSHOT_GROUPS) {
    groups[group] = {};
    for await (const [key, value] of stagedEntries(storage, pages.id, group))
      groups[group][key] = value;
  }
  return groups;
}

export async function clearRecoverySourcePages(storage: Storage, id: string) {
  for (;;) {
    const page = await storage.list({
      prefix: `recovery-kept-page-v1:${id}:`,
      limit: 128,
    });
    if (!page.size) return;
    await storage.delete([...page.keys()]);
  }
}
