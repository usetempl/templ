import type { ChatPrincipalId } from "@templ/chat/principal";
import {
  communitySessionRevision,
  peekCommunitySession,
} from "./community-auth";
import { COMMUNITY_API, communityFetch } from "./community-client";

/** One row of `GET /operator/grants`: fixed fields only. */
export type GrantStatusRow = {
  id: string;
  kind: string;
  status: "pending" | "credited" | "deferred" | "revoked";
  cases: number;
  endsAt: string | null;
};
/** The record an operator saves for verify-product-grants.mjs. */
export type GrantStatusRecord = {
  schemaVersion: 1;
  kind: "product-grant-status";
  communityOrigin: string;
  release: { commit: string; versionId: string };
  checkedAt: string;
  listSha256: string;
  grants: GrantStatusRow[];
};
const STATUSES = ["pending", "credited", "deferred", "revoked"];
const time = (value: unknown) =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

export function validGrantStatus(value: unknown): value is {
  schemaVersion: 1;
  checkedAt: string;
  listSha256: string;
  grants: GrantStatusRow[];
} {
  const body = value as Record<string, unknown> | null;
  return (
    !!body &&
    typeof body === "object" &&
    Object.keys(body).sort().join() ===
      "checkedAt,grants,listSha256,schemaVersion" &&
    body.schemaVersion === 1 &&
    time(body.checkedAt) &&
    typeof body.listSha256 === "string" &&
    /^[0-9a-f]{64}$/.test(body.listSha256) &&
    Array.isArray(body.grants) &&
    body.grants.every(
      (row: GrantStatusRow) =>
        !!row &&
        Object.keys(row).sort().join() === "cases,endsAt,id,kind,status" &&
        /^[a-z0-9][a-z0-9-]{2,39}$/.test(row.id) &&
        typeof row.kind === "string" &&
        STATUSES.includes(row.status) &&
        Number.isSafeInteger(row.cases) &&
        row.cases >= 0 &&
        (row.endsAt === null || time(row.endsAt)),
    )
  );
}

async function workerRelease(signal?: AbortSignal) {
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
    throw new Error("The check didn't finish. Try again.");
  return { commit: identity.commit, versionId: identity.versionId };
}

/** Reads each reviewed grant's status for a Templ operator's session. */
export async function checkGrants(
  principal: ChatPrincipalId,
  signal?: AbortSignal,
): Promise<GrantStatusRecord> {
  const revision = communitySessionRevision();
  const current = () => {
    if (
      communitySessionRevision() !== revision ||
      peekCommunitySession()?.principalId !== principal
    )
      throw new Error("Your sign-in changed. Sign in again.");
  };
  current();
  const release = await workerRelease(signal);
  const body = await communityFetch<unknown>(
    "/operator/grants",
    undefined,
    signal,
  );
  current();
  if (!validGrantStatus(body))
    throw new Error("The check didn't finish. Try again.");
  // A deploy during the check would mix two releases in one record.
  const after = await workerRelease(signal);
  if (after.commit !== release.commit || after.versionId !== release.versionId)
    throw new Error("The worker changed during the check. Check again.");
  return {
    schemaVersion: 1,
    kind: "product-grant-status",
    communityOrigin: COMMUNITY_API,
    release,
    checkedAt: body.checkedAt,
    listSha256: body.listSha256,
    grants: body.grants,
  };
}
