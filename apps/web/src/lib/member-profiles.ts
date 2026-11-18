"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import {
  normalizeDisplayName,
  profileMediaHash,
  type MemberProfile,
  type MemberProfilePage,
} from "@templ/chat/profiles";
import {
  normalizeChatPrincipal,
  principalLabel,
  type ChatPrincipalId,
} from "@templ/chat/principal";
import { BoundedCache, deduplicateReads } from "./bounded-cache";
import { anonymousChatFetch } from "./chat-api";
import { subscribeCommunitySession } from "./community-auth";
import { SITE } from "./site-environment";

/** Public member profiles for the web client.
 *
 * Profiles are public by content, so every read goes through
 * `anonymousChatFetch` and never carries a cookie. The cache is presentation
 * only: a display name is a label the account chose, never a proof of who
 * holds it, and nothing here grants access. The viewer's own edits are
 * forgotten on sign-out so they cannot show up under another account. */
export const PROFILE_BATCH = 50;
export const PROFILE_CACHE_MS = 5 * 60_000;
const PROFILE_CACHE_SIZE = 512;
const FAILURE_PAUSE_MS = 30_000;

/** `null` records that the service knows no profile for the id. */
const cache = new BoundedCache<MemberProfile | null>(
  PROFILE_CACHE_SIZE,
  PROFILE_CACHE_MS,
);
const inflight = new Set<string>();
const queued = new Set<string>();
const listeners = new Set<() => void>();
const readBatch = deduplicateReads<MemberProfilePage>();
let version = 0;
let flushScheduled = false;
let pausedUntil = 0;

const publish = () => {
  version++;
  listeners.forEach((listener) => listener());
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const snapshot = () => version;

/** Display name when the account set one, otherwise the short principal label. */
export function memberLabel(
  profile: Pick<MemberProfile, "displayName"> | null | undefined,
  id: string,
) {
  const name = profile?.displayName?.trim();
  return name ? name : principalLabel(id);
}

function profileKey(id: string): ChatPrincipalId | null {
  return normalizeChatPrincipal(id);
}

/** Accepts only the public shape. Anything else is dropped, so a malformed or
 * unexpected field can never reach the page. */
function validProfile(value: unknown): MemberProfile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const principalId =
    typeof raw.principalId === "string" ? profileKey(raw.principalId) : null;
  if (!principalId) return null;
  let displayName: string | null = null;
  if (raw.displayName !== null) {
    try {
      displayName = normalizeDisplayName(raw.displayName);
      if (displayName !== raw.displayName) return null;
    } catch {
      return null;
    }
  }
  const avatar =
    raw.avatar === null
      ? null
      : profileMediaHash(raw.avatar, SITE.community)
        ? (raw.avatar as string)
        : undefined;
  if (avatar === undefined) return null;
  if (
    typeof raw.agent !== "boolean" ||
    !(
      raw.updatedAt === null ||
      (typeof raw.updatedAt === "string" &&
        Number.isFinite(Date.parse(raw.updatedAt)))
    )
  )
    return null;
  return {
    principalId,
    displayName,
    avatar,
    agent: raw.agent,
    updatedAt: raw.updatedAt,
  };
}

async function fetchBatch(ids: string[]) {
  const key = [...ids].sort().join(",");
  try {
    const page = await readBatch(key, () =>
      anonymousChatFetch<MemberProfilePage>(
        `/profiles?ids=${encodeURIComponent(ids.join(","))}`,
      ),
    );
    const found = new Map<string, MemberProfile>();
    if (!page || !Array.isArray(page.profiles))
      throw new Error("Invalid profile response");
    const list = page.profiles;
    for (const entry of list) {
      const profile = validProfile(entry);
      if (profile) found.set(profile.principalId, profile);
    }
    for (const id of ids) cache.set(id, found.get(id) ?? null);
  } catch {
    // Leave the ids uncached so a later view retries, but not immediately.
    pausedUntil = Date.now() + FAILURE_PAUSE_MS;
  } finally {
    for (const id of ids) inflight.delete(id);
    publish();
  }
}

function flush() {
  flushScheduled = false;
  const ids = [...queued];
  queued.clear();
  for (let index = 0; index < ids.length; index += PROFILE_BATCH)
    void fetchBatch(ids.slice(index, index + PROFILE_BATCH));
}

/** Queues uncached ids. Calls made in the same tick share requests of at most
 * 50 ids, so a page of messages and the sidebar cost one round trip. */
export function primeMemberProfiles(ids: readonly string[]) {
  if (Date.now() < pausedUntil) return;
  for (const raw of ids) {
    const id = profileKey(raw);
    if (!id || inflight.has(id) || cache.get(id) !== undefined) continue;
    inflight.add(id);
    queued.add(id);
  }
  if (queued.size && !flushScheduled) {
    flushScheduled = true;
    void Promise.resolve().then(flush);
  }
}

/** @public Cached profile, or undefined when unknown. `null` means the
 * account has none. Tests read the cache through it. */
export function peekMemberProfile(
  id: string,
): MemberProfile | null | undefined {
  const key = profileKey(id);
  return key ? cache.get(key) : null;
}

/** Drop one profile after the viewer edits it so the next read shows the change. */
export function forgetMemberProfile(id: string) {
  const key = profileKey(id);
  if (!key) return;
  cache.delete(key);
  inflight.delete(key);
  queued.delete(key);
  publish();
}

/** Forgets every profile. Runs on any session change so one account's edits
 * never linger while another account is signed in. */
export function clearMemberProfiles() {
  cache.clear();
  inflight.clear();
  queued.clear();
  pausedUntil = 0;
  publish();
}
subscribeCommunitySession(clearMemberProfiles);

/** Snapshots handed to React must keep their identity until the cache
 * changes, so they are rebuilt per id set and dropped on every publish. */
const snapshots = new Map<
  string,
  { version: number; map: Map<string, MemberProfile> }
>();
const SNAPSHOT_LIMIT = 64;
const EMPTY: Map<string, MemberProfile> = new Map();
function snapshotFor(joined: string, keys: readonly string[]) {
  const existing = snapshots.get(joined);
  if (existing && existing.version === version) return existing.map;
  const map = new Map<string, MemberProfile>();
  for (const id of keys) {
    const profile = cache.get(id);
    if (profile) map.set(id, profile);
  }
  snapshots.delete(joined);
  snapshots.set(joined, { version, map });
  while (snapshots.size > SNAPSHOT_LIMIT)
    snapshots.delete(snapshots.keys().next().value!);
  return map;
}

/** Profiles for the ids currently on screen. Missing ids are fetched once;
 * the map only ever contains accounts that saved a profile. */
export function useMemberProfiles(
  ids: readonly string[],
): Map<string, MemberProfile> {
  const keys = useMemo(() => {
    const set = new Set<string>();
    for (const raw of ids) {
      const id = profileKey(raw);
      if (id) set.add(id);
    }
    return [...set].sort();
  }, [ids]);
  const joined = keys.join(",");
  const current = useSyncExternalStore(subscribe, snapshot, () => 0);
  useEffect(() => {
    if (joined) primeMemberProfiles(joined.split(","));
  }, [joined, current]);
  return useSyncExternalStore(
    subscribe,
    () => (keys.length ? snapshotFor(joined, keys) : EMPTY),
    () => EMPTY,
  );
}
