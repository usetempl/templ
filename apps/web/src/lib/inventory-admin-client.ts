import type { ChatPrincipalId } from "@templ/chat/principal";
import {
  communitySessionRevision,
  peekCommunitySession,
} from "./community-auth";
import { COMMUNITY_API, communityFetch } from "./community-client";

/** One answer of `GET /operator/inventory/group-files` from the community
 * worker: counts and times only, never a file key. */
export type GroupFileInventoryPage = {
  schemaVersion: 1;
  prefix: "group/";
  objects: number;
  bytes: number;
  otherKeys: number;
  oldestUploaded: string | null;
  newestUploaded: string | null;
  cursor: string | null;
};
/** The worker release that answered the count, from its `/release`. */
export type InventoryRelease = { commit: string; versionId: string };
/** The saved inventory record the founder reviews before any reset. It names
 * the community origin and the worker release that answered, read before and
 * after the count. */
export type GroupFileInventoryRecord = {
  schemaVersion: 1;
  kind: "retained-group-files";
  prefix: "group/";
  communityOrigin: string;
  release: InventoryRelease;
  startedAt: string;
  finishedAt: string;
  requests: number;
  objects: number;
  bytes: number;
  otherKeys: number;
  oldestUploaded: string | null;
  newestUploaded: string | null;
  complete: boolean;
};
/** At 20,000 files an answer, this reads up to two million files. */
export const INVENTORY_MAX_REQUESTS = 100;
const natural = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const time = (value: unknown) =>
  value === null ||
  (typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value);

export function validInventoryPage(
  value: unknown,
): value is GroupFileInventoryPage {
  const page = value as GroupFileInventoryPage;
  return (
    !!page &&
    typeof page === "object" &&
    Object.keys(page).length === 8 &&
    page.schemaVersion === 1 &&
    page.prefix === "group/" &&
    natural(page.objects) &&
    natural(page.bytes) &&
    natural(page.otherKeys) &&
    time(page.oldestUploaded) &&
    time(page.newestUploaded) &&
    (page.cursor === null ||
      (typeof page.cursor === "string" &&
        /^[A-Za-z0-9+/=_-]{1,1024}$/.test(page.cursor)))
  );
}

/** Reads the worker's `/release` identity: its commit and version id. */
async function workerRelease(signal?: AbortSignal): Promise<InventoryRelease> {
  const identity = (await communityFetch<unknown>(
    "/release",
    undefined,
    signal,
  )) as Record<string, unknown> | null;
  if (
    !identity ||
    identity.service !== "community" ||
    typeof identity.commit !== "string" ||
    !/^[0-9a-f]{40}$/.test(identity.commit) ||
    typeof identity.versionId !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(identity.versionId)
  )
    throw new Error("The count didn't finish. Try again.");
  return { commit: identity.commit, versionId: identity.versionId };
}

const earlier = (a: string | null, b: string | null) =>
  a === null ? b : b === null ? a : a < b ? a : b;
const later = (a: string | null, b: string | null) =>
  a === null ? b : b === null ? a : a > b ? a : b;

/** Counts the retained group files for a Templ operator's session, page by
 * page, and reports the running total after each answer. */
export function groupFileInventory(
  principal: ChatPrincipalId,
  now: () => Date = () => new Date(),
) {
  const revision = communitySessionRevision();
  const current = () => {
    if (
      communitySessionRevision() !== revision ||
      peekCommunitySession()?.principalId !== principal
    )
      throw new Error("Your sign-in changed. Sign in again.");
  };
  return {
    async count(
      signal?: AbortSignal,
      progress?: (record: GroupFileInventoryRecord) => void,
    ): Promise<GroupFileInventoryRecord> {
      current();
      const release = await workerRelease(signal);
      const record: GroupFileInventoryRecord = {
        schemaVersion: 1,
        kind: "retained-group-files",
        prefix: "group/",
        communityOrigin: COMMUNITY_API,
        release,
        startedAt: now().toISOString(),
        finishedAt: now().toISOString(),
        requests: 0,
        objects: 0,
        bytes: 0,
        otherKeys: 0,
        oldestUploaded: null,
        newestUploaded: null,
        complete: false,
      };
      let cursor: string | null = null;
      while (record.requests < INVENTORY_MAX_REQUESTS) {
        current();
        const page: unknown = await communityFetch(
          `/operator/inventory/group-files${
            cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""
          }`,
          undefined,
          signal,
        );
        current();
        if (!validInventoryPage(page))
          throw new Error("The count didn't finish. Try again.");
        record.requests++;
        record.objects += page.objects;
        record.bytes += page.bytes;
        record.otherKeys += page.otherKeys;
        record.oldestUploaded = earlier(
          record.oldestUploaded,
          page.oldestUploaded,
        );
        record.newestUploaded = later(
          record.newestUploaded,
          page.newestUploaded,
        );
        record.finishedAt = now().toISOString();
        cursor = page.cursor;
        record.complete = cursor === null;
        progress?.({ ...record });
        if (record.complete) break;
      }
      // A deploy during the count would mix two releases in one record.
      if (record.complete) {
        const after = await workerRelease(signal);
        if (
          after.commit !== release.commit ||
          after.versionId !== release.versionId
        )
          throw new Error("The worker changed during the count. Count again.");
      }
      return record;
    },
  };
}
