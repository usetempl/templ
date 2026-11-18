/** Encrypted case routing. The relay handles public keys and opaque records
 * only. Customer services and clients live on independently owned origins. */
import { canManageWorkspace } from "@templ/chat/moderation-permissions";
import { PRODUCT_LIMITS } from "@templ/chat/plans";
import { actsAs } from "./service-principals";
import { identityRequest } from "./account-identity";
import { ENCRYPTION_ACCESS_REVISION, nativeEncryptionGrant } from "./support-encryption-access";
import { OWN_AUTHORITY_CHECKPOINT, OWN_DEVICE_REVOKED, revokeOwnDevice, type OwnAuthorityCheckpoint } from "./own-encryption-control";
import { nativeTelegramGrantKey } from "./native-telegram-access";
import { requireWorkspaceAdminHeaders } from "./privileged-auth";
import { featureOn } from "./workspace-flags";
import { PERMISSION_REVISION_KEY } from "./room-events";
import { HttpError, json, roomKey } from "./common";
import { templAiPrincipal } from "./templ-ai-principal";
import { templStaffAccount } from "./templ-staff";
import { isOperatorAdmin } from "./operator-admin";
import { principalList } from "./principal";
import { uuidv7 } from "./uuidv7";
import type {
  ConversationContext,
  TeamConversationRecord,
} from "./team-conversations";
import {
  EncryptionProtocolError,
  OWN_SUPPORT_ENDPOINT,
  OWN_SUPPORT_AI_PRINCIPAL,
  caseOf,
  object,
  opaqueId,
  parseCertificate,
  parseEncryptedRecord,
  type CustomerEncryptionProfile,
  type EncryptionProfile,
  type E2eeAudience,
  type E2eeCase,
  type EncryptedRecord,
  type ValidationReceipt,
} from "@templ/e2ee/protocol";
import { verifyCustomerProfile, verifyEncryptionProfile, verifySignature } from "@templ/e2ee/verify";
import {
  createRelayCase,
  deleteEncryptedCaseData,
  EncryptedCaseRelay,
  encryptedCaseStateKey,
  encryptedCaseDeletionKey,
  encryptedOutcomeCheckpoint,
  encryptedOutcomeCoverageKey,
  encryptedOutcomePrefix,
  type RelayCaseState,
  type RelayOutcomeCoverage,
  type RelayStorage,
} from "@templ/e2ee/relay";
import { ownAiContext, abandonOwnAiTurn, OWN_AI_CONTROL_PREFIX } from "./support-own-ai";
import { readAiState } from "./support-workflow";
import { ownContact } from "./support-own-contact";
import { settleOwnAiEnvelope } from "./support-own-ai-settlement";
import {OWN_QUALIFICATION_KEY, checkedOwnQualification, ownQualificationAllows, forgetOwnQualification, type OwnQualification} from "./support-own-qualification";
import {wakeRoomAt} from "./room-alarm";
import {ownSetupDigest, ownSetupExpected, ownSetupExpectedBytes, verifyOwnSetupAuthorization, type OwnSetupStatus, type OwnSetupGrant, type OwnSetupRelease} from "@templ/e2ee/own-setup";
import {requireOwnEncryptionReleasePair} from "./release-activation";

export const ENCRYPTION_POLICY_KEY = "support-encryption-policy-v1";
export const OWN_SETUP_KEY = "support-encryption-own-setup-v1";
export const OWN_SETUP_RELEASE_KEY = "support-encryption-own-setup-release-v1";
type OwnSetupState = {v: 1; revision: number; digest: string; action: "prepare" | "activate"; actor: string; changedAt: number};
const RESERVATIONS = "support-encryption-reservations-v1";
const RESERVED_CASE = "support-encryption-reserved-case-v1:";
const RESERVE_MS = 5 * 60_000;
const OPENING_FENCE = "support-encryption-opening-fence-v1:";
const OPENING_FENCE_COUNT = "support-encryption-opening-fence-count-v1";
export const ENCRYPTION_DELETION_REVISION = "support-encryption-deletion-revision-v1";
async function deletedEncryption(storage: Pick<Storage, "get" | "put">) {
  const prior = await storage.get<number>(ENCRYPTION_DELETION_REVISION) ?? 0;
  if (!Number.isSafeInteger(prior) || prior < 0 || prior >= Number.MAX_SAFE_INTEGER)
    throw new EncryptionProtocolError("encryption-integrity");
  await storage.put(ENCRYPTION_DELETION_REVISION, prior + 1);
}
type Policy = {
  v: 1;
  revision: number;
  on: boolean;
  profile: EncryptionProfile;
  changedAt: number;
  actor: string;
};
type Reservation = {
  id: string;
  principal: string;
  case: E2eeCase;
  policyRevision: number;
  profileSignature: string;
  until: number;
  initialAiMode?: "off";
  ownRelease?: OwnSetupRelease;
};
type Storage = DurableObjectTransaction;
export type EncryptionNativeHooks = {
  /** Existing authorization is required before any case metadata is read. */
  authorize: (
    id: string,
  ) => Promise<{ record: TeamConversationRecord; role: "member" | "team" }>;
  mine: () => Promise<TeamConversationRecord | null>;
  targetCase: (
    record: TeamConversationRecord | null,
  ) => Promise<{ seq: number; newCase: boolean; currentSeq?: number }>;
  accept: (
    reservation: Reservation | null,
    record: EncryptedRecord,
    receipt: ValidationReceipt,
  ) => Promise<void>;
  /** This version qualifies human text, context, notes and endpoint export.
   * An enabled incompatible channel prevents new-case activation. */
  compatible: (profile: EncryptionProfile) => Promise<boolean>;
};
const unavailable = () =>
  new HttpError(
    409,
    "Open this case on its secure support page.",
    undefined,
    "encrypted-client-required",
  );
const missing = () => new HttpError(404, "Case not found.");
/** A distinct room route makes old object code refuse instead of linking an
 * encrypted guest through the legacy collision path during a rollback. */
export async function requireOwnWidgetWallet(storage: Storage, env: ConversationContext["mediaEnv"], workspace: string, origin: string) {
  if (workspace !== OWN_SUPPORT_ENDPOINT.workspace || env.TEMPL_SUPPORT_WORKSPACE !== workspace ||
      env.APP_ORIGIN !== "https://usetempl.com" || origin !== OWN_SUPPORT_ENDPOINT.clientOrigin ||
      env.CONVERSATIONS_ENABLED !== "true" || env.SUPPORT_WORKFLOW_ENABLED !== "true" ||
      !await featureOn(env, storage, "supportEncryption")) throw unavailable();
  const policy = await storage.get<Policy>(ENCRYPTION_POLICY_KEY);
  const admitted = await storage.get<{profileSignature: string; release: OwnSetupRelease}>(OWN_SETUP_RELEASE_KEY);
  if (!policy?.on || policy.profile.custody !== "templ-own-support" || policy.profile.workspace !== workspace ||
      policy.profile.environment !== "production" || policy.profile.rootKey !== env.OWN_SUPPORT_ENCRYPTION_ROOT ||
      policy.profile.clientOrigin !== origin || !admitted || admitted.profileSignature !== policy.profile.signature) throw unavailable();
  await requireOwnEncryptionReleasePair(env, admitted.release);
}
const environment = (context: ConversationContext) =>
  context.appOrigin === "https://usetempl.com"
    ? ("production" as const)
    : context.appOrigin === "https://templ.vip"
      ? ("staging" as const)
      : ("local" as const);
export const encryptionPolicyBytes = (
  profile: EncryptionProfile,
  revision: number,
  on: boolean,
) =>
  new TextEncoder().encode(
    JSON.stringify([
      profile.custody === "customer" ? "templ:e2ee:workspace-policy:v1" : "templ:e2ee:own-support-policy:v1",
      profile.workspace,
      profile.environment,
      profile.signature,
      revision,
      on,
    ]),
  );

export async function encryptedCaseExists(
  storage: Pick<Storage, "get">,
  conversation: string,
  seq: number,
): Promise<boolean> {
  return Boolean(
    await storage.get(
      encryptedCaseStateKey({
        environment: "local",
        workspace: "",
        conversation,
        caseSeq: seq,
      }),
    ),
  );
}
export async function encryptedCaseView(
  storage: Pick<Storage, "get">,
  conversation: string,
  seq: number,
) {
  const state = await storage.get<RelayCaseState>(
    encryptedCaseStateKey({
      environment: "local",
      workspace: "",
      conversation,
      caseSeq: seq,
    }),
  );
  return state && !state.deleted && state.accepted > 0
    ? {
        mode: "encrypted" as const,
        custody: state.profile.custody,
        caseSeq: seq,
        clientOrigin: state.profile.clientOrigin,
      }
    : undefined;
}
export async function newCaseEncryptionView(storage: Pick<Storage, "get">) {
  const policy = await storage.get<Policy>(ENCRYPTION_POLICY_KEY);
  return policy?.on
    ? {
        mode: "encrypted" as const,
        custody: policy.profile.custody,
        clientOrigin: policy.profile.clientOrigin,
        policyRevision: policy.revision,
      }
    : undefined;
}
/** Invoked only after native retention/hold checks authorize the deletion. */
export async function deleteCaseEncryption(
  storage: Storage,
  conversation: string,
  seq: number,
  budget: number,
) {
  const ref: E2eeCase = { environment: "local", workspace: "", conversation, caseSeq: seq };
  const cleared = budget > 0 ? await forgetOwnQualification(storage, Date.now(), ref) : 0;
  if (budget > 0 && await storage.get(encryptedCaseStateKey(ref)) &&
      !await storage.get(encryptedCaseDeletionKey(ref))) await deletedEncryption(storage);
  const removed = cleared + await deleteEncryptedCaseData(
    storage as RelayStorage,
    ref,
    budget - cleared,
  );
  if (removed >= budget) return removed;
  const controls = await storage.list({prefix: `${OWN_AI_CONTROL_PREFIX}${conversation}:${seq}:`, limit: budget - removed});
  for (const key of controls.keys()) await storage.delete(key);
  return removed + controls.size;
}
export async function deleteThreadEncryption(
  storage: Storage,
  conversation: string,
  budget: number,
) {
  if (budget <= 0) return 0;
  const cleared = await forgetOwnQualification(storage, Date.now(), {conversation});
  return cleared + await deleteThreadEncryptionData(storage, conversation, budget - cleared);
}
async function deleteThreadEncryptionData(storage: Storage, conversation: string, budget: number) {
  if (budget <= 0) return 0;
  const controls = await storage.list({prefix: `${OWN_AI_CONTROL_PREFIX}${conversation}:`, limit: budget});
  for (const key of controls.keys()) await storage.delete(key);
  if (controls.size >= budget) return controls.size;
  budget -= controls.size;
  const rows = await storage.list({
    prefix: `support-encrypted-v1:${conversation}:`,
    limit: budget,
  });
  if (rows.size || controls.size) await deletedEncryption(storage);
  for (const key of rows.keys()) await storage.delete(key);
  if (rows.size < budget) {
    const checkpoints = await storage.list({
      prefix: encryptedOutcomePrefix({ conversation }),
      limit: budget - rows.size,
    });
    for (const key of checkpoints.keys()) await storage.delete(key);
    if (rows.size + checkpoints.size >= budget)
      return controls.size + rows.size + checkpoints.size;
    const reservations = await storage.list({
      prefix: `${RESERVED_CASE}${conversation}:`,
      limit: budget - rows.size - checkpoints.size,
    });
    for (const key of reservations.keys()) await storage.delete(key);
    return controls.size + rows.size + checkpoints.size + reservations.size;
  }
  return controls.size + rows.size;
}

/** The policy check runs before every legacy opening write. A stale client
 * cannot send a plaintext first message after the owner enables encryption. */
export async function requireLegacyCase(
  storage: Storage,
  context: ConversationContext,
  hooks: EncryptionNativeHooks,
): Promise<void> {
  if (context.method !== "POST" || context.body.encryptedRecord !== undefined)
    return;
  const match =
    /^\/conversations\/(?:ask|start|(tc-[a-f0-9]{32})\/([^/]+))/.exec(
      context.pathname,
    );
  if (!match) return;
  if (
    ["encryption", "resolve", "stop", "claim", "release", "typing"].includes(
      match[2],
    )
  )
    return;
  const record = match[1]
    ? (await hooks.authorize(match[1])).record
    : await hooks.mine();
  const target = await hooks.targetCase(record);
  // These Own actions change consent or workflow metadata, never content or
  // a key grant. Their existing native permission checks still run below.
  if (record && match[2] === "workflow" && ["guest-email", "ai-mode", "handoff", "ask-person"].includes(String(context.body.action)) &&
      environment(context) === "production" && roomKey(context.room) === `room:${OWN_SUPPORT_ENDPOINT.workspace}`) {
    const retained = await storage.get<RelayCaseState>(encryptedCaseStateKey({
      environment: "production", workspace: OWN_SUPPORT_ENDPOINT.workspace,
      conversation: record.id, caseSeq: target.currentSeq ?? target.seq,
    }));
    if (retained && !retained.deleted && retained.profile.custody === "templ-own-support" &&
        retained.profile.rootKey === context.mediaEnv.OWN_SUPPORT_ENCRYPTION_ROOT) {
      if (context.body.expectedCaseSeq !== undefined) {
        if (context.body.expectedCaseSeq !== retained.case.caseSeq) throw new EncryptionProtocolError("encryption-scope-changed");
        delete context.body.expectedCaseSeq;
      }
      return;
    }
  }
  if (record && (await encryptedCaseExists(storage, record.id, target.seq)))
    throw unavailable();
  // A stale legacy composer must not turn a finished encrypted request into
  // a plaintext new case after a policy change. A separately qualified,
  // explicit protection-change flow is required before allowing that boundary.
  if (
    record &&
    target.newCase &&
    target.currentSeq &&
    (await encryptedCaseExists(storage, record.id, target.currentSeq))
  )
    throw new HttpError(
      409,
      "Support protection changed. Keep your draft and open the customer's secure support page.",
      undefined,
      "encryption-protection-changed",
    );
}

/** Call at the actual new-case admission boundary, after accepted retries.
 * An old conversation URL can open a new case too. Retained legacy replies
 * and notes do not open one and must remain available. */
export async function requireLegacyOpening(storage: Storage): Promise<void> {
  if ((await storage.get<Policy>(ENCRYPTION_POLICY_KEY))?.on)
    throw unavailable();
}

export async function supportEncryptionRoute(
  storage: Storage,
  context: ConversationContext,
  hooks: EncryptionNativeHooks,
): Promise<Response | null> {
  const path = context.pathname;
  const encryptionPath = /^\/conversations\/encryption(?:\/(prepare|revoke-device|settle-ai|qualify|setup))?$/.exec(
    path,
  );
  const casePath =
    /^\/conversations\/(tc-[a-f0-9]{32})\/encryption\/([1-9][0-9]{0,7})(?:\/(enroll|directory|history|outcome|fence|revoke|ai-context|ai-handoff|control|contact))?$/.exec(
      path,
    );
  const encryptedWrite =
    context.body.encryptedRecord !== undefined &&
    /^\/conversations\/(?:ask|tc-[a-f0-9]{32}\/(?:messages|workflow))$/.test(
      path,
    );
  if (!encryptionPath && !casePath && !encryptedWrite) return null;
  if (
    context.body.confirmed !== undefined &&
    typeof context.body.confirmed !== "boolean"
  )
    throw new EncryptionProtocolError();
  if (!context.viewer.principalId) throw missing();
  const principal = context.viewer.principalId;
  const { expectedPrincipalId, ...wireBody } = context.body;
  if (expectedPrincipalId !== undefined && expectedPrincipalId !== principal)
    throw missing();
  const workspace = roomKey(context.room).slice(5),
    env = environment(context);
  const policy = await storage.get<Policy>(ENCRYPTION_POLICY_KEY);
  if (encryptionPath?.[1] === "settle-ai") {
    if (context.method !== "POST") throw missing();
    return json(await settleOwnAiEnvelope(storage as RelayStorage, context, policy?.profile, wireBody));
  }
  const requestedOwn = encryptionPath?.[1] === "setup" || (policy?.profile ?? context.body.profile as EncryptionProfile | undefined)?.custody === "templ-own-support";
  const own = requestedOwn && workspace === OWN_SUPPORT_ENDPOINT.workspace &&
    env === OWN_SUPPORT_ENDPOINT.environment && Boolean(context.mediaEnv.OWN_SUPPORT_ENCRYPTION_ROOT);
  const ownAi = (actor: string) => own && actor === OWN_SUPPORT_AI_PRINCIPAL && context.registeredBots?.includes(OWN_SUPPORT_AI_PRINCIPAL);
  const aliasCache = new Map<string, Promise<typeof context.aliases>>();
  const nativeAliases = (actor: string): Promise<typeof context.aliases> => {
    if (actor === principal) return Promise.resolve(context.aliases);
    if (!actor.startsWith("account:"))
      return Promise.resolve([actor as typeof principal]);
    let read = aliasCache.get(actor);
    if (!read) {
      read = identityRequest(context.mediaEnv, {
        op: "read",
        principalId: actor,
      }).then((identity) => identity.servicePrincipals);
      aliasCache.set(actor, read);
    }
    return read;
  };
  const nativeGrant = async (actor: string, member?: string) => {
    const aliases = await nativeAliases(actor);
    return nativeEncryptionGrant(storage, {
      environment: env,
      workspace,
      principal: actor,
      aliases,
      ...(member
        ? { member }
        : context.manager && actsAs(aliases, context.manager)
          ? { manager: context.manager }
          : {}),
    });
  };
  const actorIsTempl = async (actor: string) => {
    const aliases = await nativeAliases(actor);
    return (
      Boolean(await templAiPrincipal(context.room, aliases)) ||
      (await templStaffAccount(storage, aliases, context.mediaEnv)) ||
      isOperatorAdmin(context.mediaEnv, actor as typeof principal, aliases) ||
      aliases.some((id) =>
        principalList(context.mediaEnv.FOUNDER_PRINCIPALS).includes(id),
      )
    );
  };
  const unsupportedEndpoint = async (actor: string) =>
    (!own && await actorIsTempl(actor)) ||
    (!ownAi(actor) && (await nativeAliases(actor)).some(
      (id) =>
        context.bots?.includes(id) || context.registeredBots?.includes(id),
    )) ||
    (
      await Promise.all(
        (await nativeAliases(actor)).map((id) =>
          storage.get(nativeTelegramGrantKey(id)),
        ),
      )
    ).some((value) => value !== undefined);
  if ((context.isBot && !ownAi(principal)) || (await unsupportedEndpoint(principal))) throw missing();
  const active = await featureOn(
    context.mediaEnv,
    storage,
    "supportEncryption",
  );
  if (own) await forgetOwnQualification(storage, context.now);
  const qualification = own ? await storage.get<OwnQualification>(OWN_QUALIFICATION_KEY) : undefined;
  const releaseFor = async (profile: EncryptionProfile) => {
    const value = await storage.get<{profileSignature: string; release: OwnSetupRelease}>(OWN_SETUP_RELEASE_KEY);
    if (!value || profile.custody !== "templ-own-support" || value.profileSignature !== profile.signature) throw unavailable();
    await requireOwnEncryptionReleasePair(context.mediaEnv, value.release);
    return value.release;
  };
  const unusedQualification = async (grant: OwnSetupGrant) => {
    if (qualification?.grant?.clientId === grant.clientId ||
        ((await storage.get<Reservation[]>(RESERVATIONS)) ?? []).some(item => item.id === grant.clientId) ||
        await storage.get(`conversation-v1:${grant.case.conversation}`) ||
        await storage.get(encryptedCaseStateKey(grant.case)) || await storage.get(encryptedCaseDeletionKey(grant.case)) ||
        await storage.get(OPENING_FENCE + grant.clientId)) throw unavailable();
  };
  if (encryptionPath?.[1] === "setup") {
    if (!own || !canManageWorkspace(context.viewer, context.isBot) ||
      (policy && (policy.profile.custody !== "templ-own-support" || policy.profile.rootKey !== context.mediaEnv.OWN_SUPPORT_ENCRYPTION_ROOT))) throw missing();
    const previous = await storage.get<OwnSetupState>(OWN_SETUP_KEY);
    const status: OwnSetupStatus = {v: 1, principal, available: active, newCases: policy?.on ? "encrypted" : "legacy",
      profileSignature: policy?.profile.signature ?? null, policyRevision: policy?.revision ?? 0,
      qualificationRevision: qualification?.revision ?? 0, setupRevision: previous?.revision ?? 0, appliedDigest: previous?.digest ?? null,
      permissionRevision: await storage.get<number>(ENCRYPTION_ACCESS_REVISION) ?? 0,
      deletionRevision: await storage.get<number>(ENCRYPTION_DELETION_REVISION) ?? 0,
      authority: await storage.get<OwnAuthorityCheckpoint>(OWN_AUTHORITY_CHECKPOINT) ?? null};
    if (context.method === "GET") return json(status);
    if (context.method !== "POST" || expectedPrincipalId !== principal) throw missing();
    requireWorkspaceAdminHeaders(context.headers, context.viewer.isManager, context.body.confirmed, context.now);
    const body = object(wireBody, ["confirmed", "authorization"]);
    const approved = await verifyOwnSetupAuthorization(body.authorization, context.mediaEnv.OWN_SUPPORT_ENCRYPTION_ROOT!, context.now, true);
    if (approved.principal !== principal) throw missing();
    const digest = await ownSetupDigest(approved);
    // Resolve a lost acknowledgement without writing, even if the approval has
    // expired or a later policy control changed the current admission mode.
    if (previous?.digest === digest && previous.revision === approved.expected.setupRevision + 1)
      return json({applied: true, replayed: true, status});
    if (approved.expiresAt <= context.now || (approved.grant && approved.grant.until <= context.now) || !active ||
      JSON.stringify(ownSetupExpectedBytes(approved.expected)) !== JSON.stringify(ownSetupExpectedBytes(ownSetupExpected(status))) ||
      (policy && approved.profile.signature !== policy.profile.signature) ||
      (approved.action === "prepare" && policy?.on) || !(await hooks.compatible(approved.profile))) throw unavailable();
    if (approved.grant) await unusedQualification(approved.grant);
    await requireOwnEncryptionReleasePair(context.mediaEnv, approved.release);
    const nextPolicy = status.policyRevision + 1, nextQualification = status.qualificationRevision + 1, nextSetup = status.setupRevision + 1;
    if (![nextPolicy, nextQualification, nextSetup].every(Number.isSafeInteger)) throw unavailable();
    await storage.put(ENCRYPTION_POLICY_KEY, {v: 1, revision: nextPolicy, on: approved.action === "activate", profile: approved.profile,
      actor: principal, changedAt: context.now} satisfies Policy);
    await storage.put(OWN_QUALIFICATION_KEY, {v: 1, revision: nextQualification, grant: approved.grant, policyRevision: nextPolicy,
      profileSignature: approved.profile.signature, actor: principal, changedAt: context.now, ownRelease: approved.release} satisfies OwnQualification);
    await storage.put(OWN_SETUP_RELEASE_KEY, {profileSignature: approved.profile.signature, release: approved.release});
    await storage.put(OWN_SETUP_KEY, {v: 1, revision: nextSetup, digest, action: approved.action, actor: principal, changedAt: context.now} satisfies OwnSetupState);
    if (approved.grant) await wakeRoomAt(storage, approved.grant.until);
    context.pendingAudit.push({actor: principal, action: "support.settings", channelId: "support", target: `own-encryption-setup:${nextSetup}:${approved.action}`});
    return json({applied: true, replayed: false, status: {...status, newCases: approved.action === "activate" ? "encrypted" : "legacy",
      profileSignature: approved.profile.signature, policyRevision: nextPolicy, qualificationRevision: nextQualification, setupRevision: nextSetup, appliedDigest: digest}});
  }
  if (encryptionPath?.[1] === "qualify") {
    if (!own || !policy || policy.profile.rootKey !== context.mediaEnv.OWN_SUPPORT_ENCRYPTION_ROOT || !active || !canManageWorkspace(context.viewer, context.isBot)) throw missing();
    if (context.method === "GET") return json({revision: qualification?.revision ?? 0, grant: qualification?.grant ?? null});
    if (context.method !== "POST") throw missing();
    requireWorkspaceAdminHeaders(context.headers, context.viewer.isManager, context.body.confirmed, context.now);
    const next = await checkedOwnQualification(wireBody, policy, qualification, context.now);
    const ownRelease = await releaseFor(policy.profile);
    if (next.grant) await unusedQualification(next.grant);
    await storage.put(OWN_QUALIFICATION_KEY, {v: 1, ...next, policyRevision: policy.revision,
      profileSignature: policy.profile.signature, actor: principal, changedAt: context.now, ownRelease} satisfies OwnQualification);
    if (next.grant) await wakeRoomAt(storage, next.grant.until);
    context.pendingAudit.push({actor: principal, action: "support.settings", channelId: "support",
      target: `own-encryption-qualification:${next.revision}:${next.grant ? "prepare" : "revoke"}`});
    return json({revision: next.revision, grant: next.grant});
  }
  if (encryptionPath && !encryptionPath[1]) {
    if (context.method === "GET") {
      if (!active && !policy)
        return json({
          v: 1,
          available: false,
          newCases: "legacy",
          custody: "customer",
          templKeyAccess: false,
        });
      return json({
        v: 1,
        available: active,
        newCases: policy?.on ? "encrypted" : "legacy",
        custody: policy?.profile.custody ?? "customer",
        templKeyAccess: policy?.profile.custody === "templ-own-support",
        profile: policy?.profile,
        revision: policy?.revision ?? 0,
        capabilities: ["human-text-v1"],
      });
    }
    if (
      context.method !== "POST" ||
      !canManageWorkspace(context.viewer, context.isBot)
    )
      throw missing();
    requireWorkspaceAdminHeaders(
      context.headers,
      context.viewer.isManager,
      context.body.confirmed,
      context.now,
    );
    const body = object(wireBody, [
      "confirmed",
      "on",
      "revision",
      "profile",
      "signature",
    ]);
    if (
      typeof body.on !== "boolean" ||
      body.revision !== (policy?.revision ?? 0) + 1
    )
      throw new HttpError(409, "Refresh encryption settings before saving.");
    const profile = own
      ? await verifyEncryptionProfile(body.profile, context.mediaEnv.OWN_SUPPORT_ENCRYPTION_ROOT!)
      : await verifyCustomerProfile(body.profile, policy?.profile.rootKey ?? (body.profile as CustomerEncryptionProfile)?.rootKey);
    if (
      profile.workspace !== workspace ||
      profile.environment !== env ||
      (profile.custody === "templ-own-support" && !own) ||
      (policy && profile.custody !== policy.profile.custody) ||
      (policy &&
        profile.signature !== policy.profile.signature &&
        profile.revision !== policy.profile.revision + 1)
    )
      throw new EncryptionProtocolError("customer-custody-required");
    if (body.on && (!active || !(await hooks.compatible(profile))))
      throw new HttpError(409,
        "This workspace's selected support channels are not ready for encrypted cases.",
        undefined, "encryption-incompatible");
    if (body.on && own) await releaseFor(profile);
    if (
      !(await verifySignature(
        profile.rootKey,
        String(body.signature),
        encryptionPolicyBytes(profile, body.revision as number, body.on),
      ))
    )
      throw new EncryptionProtocolError("encryption-integrity");
    await storage.put(ENCRYPTION_POLICY_KEY, {
      v: 1,
      revision: body.revision,
      on: body.on,
      profile,
      actor: principal,
      changedAt: context.now,
    } satisfies Policy);
    context.pendingAudit.push({
      actor: principal,
      action: "support.settings",
      channelId: "support",
      target: `${profile.custody === "customer" ? "customer-keys" : "own-support-keys"}:${body.on ? "on" : "off"}`,
    });
    return json({
      revision: body.revision,
      newCases: body.on ? "encrypted" : "legacy",
      profile,
    });
  }
  let reservation: Reservation | null = null;
  let state: RelayCaseState | undefined;
  if (encryptionPath?.[1] === "revoke-device") {
    if (context.method !== "POST" || !own || policy?.profile.custody !== "templ-own-support" ||
        policy.profile.rootKey !== context.mediaEnv.OWN_SUPPORT_ENCRYPTION_ROOT)
      throw missing();
    const body = object(wireBody, ["device", "at", "signature"], ["confirmed"]);
    return json(await revokeOwnDevice(storage, policy.profile.rootKey,
      {device: body.device, at: body.at, signature: body.signature}, context.now));
  }
  if (encryptionPath?.[1] === "prepare") {
    const id = opaqueId(context.body.clientId);
    const qualified = ownQualificationAllows(qualification, policy, {id, principal, initialAiMode: context.body.initialAiMode as "off" | undefined}, context.now);
    if (
      context.method !== "POST" ||
      !policy || (!policy.on && !qualified) ||
      !active ||
      !(await hooks.compatible(policy.profile))
    )
      throw unavailable();
    const ownRelease = own ? await releaseFor(policy.profile) : undefined;
    object(wireBody, ["clientId"], ["confirmed", "initialAiMode"]);
    if (context.body.initialAiMode !== undefined && (!own || context.body.initialAiMode !== "off"))
      throw new EncryptionProtocolError("encryption-scope-changed");
    const record = await hooks.mine(),
      target = await hooks.targetCase(record);
    if (qualified && (record || target.seq !== 1 || !target.newCase)) throw unavailable();
    if (
      !target.newCase &&
      record &&
      !(await encryptedCaseExists(storage, record.id, target.seq))
    )
      return json({ v: 1, mode: "legacy" });
    const previous = (await storage.get<Reservation[]>(RESERVATIONS)) ?? [];
    const all = previous.filter((r) => r.until > context.now);
    let fencedOpenings = (await storage.get<number>(OPENING_FENCE_COUNT)) ?? 0;
    for (const expired of previous.filter((r) => r.until <= context.now)) {
      const abandoned = await storage.get<RelayCaseState>(
        encryptedCaseStateKey(expired.case),
      );
      const known = await encryptedOutcomeCheckpoint(
        storage as RelayStorage,
        expired.case,
        expired.id,
      );
      const coverage = await storage.get<RelayOutcomeCoverage>(
        encryptedOutcomeCoverageKey(expired.case),
      );
      if (
        abandoned?.accepted === 0 &&
        known?.state !== "accepted" &&
        coverage?.accepted === 0
      ) {
        // Prove no opening was accepted and fence its exact ID atomically,
        // before removing the abandoned endpoint directory.
        if (!(await storage.get(OPENING_FENCE + expired.id))) {
          await storage.put(OPENING_FENCE + expired.id, expired);
          await storage.put(OPENING_FENCE_COUNT, ++fencedOpenings);
        }
        const currentKey = `${RESERVED_CASE}${expired.case.conversation}:${expired.case.caseSeq}`;
        const current = await storage.get<Reservation>(currentKey);
        if (
          current?.id === expired.id &&
          !all.some(
            (r) =>
              r.case.conversation === expired.case.conversation &&
              r.case.caseSeq === expired.case.caseSeq,
          )
        ) {
          await deleteEncryptedCaseData(
            storage as RelayStorage,
            expired.case,
            512,
            false,
          );
          await storage.delete(encryptedCaseStateKey(expired.case));
          await storage.delete(currentKey);
        }
      }
    }
    if (await storage.get(OPENING_FENCE + id)) throw unavailable();
    reservation =
      all.find((r) => r.id === id && r.principal === principal) ?? null;
    if (reservation) {
      if (qualified && !ownQualificationAllows(qualification, policy, reservation, context.now)) throw unavailable();
      if (
        reservation.policyRevision !== policy.revision ||
        reservation.profileSignature !== policy.profile.signature ||
        reservation.initialAiMode !== context.body.initialAiMode
      )
        throw new EncryptionProtocolError("encryption-scope-changed");
    } else {
      if (
        fencedOpenings + all.length >= PRODUCT_LIMITS.supportRetainedRecords ||
        all.length >= 128 ||
        all.filter((r) => r.principal === principal).length >= 2
      )
        throw new HttpError(
          429,
          "Finish your pending request before starting another.",
        );
      const conversation =
        qualified ? qualification!.grant!.case.conversation : record?.id ?? `tc-${uuidv7(context.now).replace(/-/g, "")}`;
      if (qualified && (await storage.get(`conversation-v1:${conversation}`) ||
          await storage.get(encryptedCaseDeletionKey(qualification!.grant!.case)))) throw unavailable();
      reservation = {
        id,
        principal,
        case: {
          environment: env,
          workspace,
          conversation,
          caseSeq: target.seq,
        },
        policyRevision: policy.revision,
        profileSignature: policy.profile.signature,
        until: context.now + RESERVE_MS,
        ...(ownRelease ? {ownRelease} : {}),
        ...(context.body.initialAiMode === "off" ? {initialAiMode: "off" as const} : {}),
      };
      all.push(reservation);
      await storage.put(RESERVATIONS, all);
      await storage.put(
        `${RESERVED_CASE}${conversation}:${target.seq}`,
        reservation,
      );
    }
    state = await createRelayCase(storage as RelayStorage, {
      case: reservation.case,
      profile: policy.profile,
      pinnedRoot: policy.profile.rootKey,
      policyRevision: policy.revision,
    });
    const authorizationGrant = await nativeGrant(principal, record?.member ?? principal);
    return json({
      v: 1,
      mode: "encrypted",
      reservation: reservation.id,
      case: state.case,
      profile: state.profile,
      authorizationGrant,
      policyRevision: state.policyRevision,
    });
  }
  const parsedRecord = encryptedWrite
    ? parseEncryptedRecord(context.body.encryptedRecord)
    : null;
  const ref: E2eeCase = parsedRecord
    ? caseOf(parsedRecord.scope)
    : {
        environment: env,
        workspace,
        conversation: casePath![1],
        caseSeq: Number(casePath![2]),
      };
  if (ref.workspace !== workspace || ref.environment !== env) throw missing();
  if (await storage.get(encryptedCaseDeletionKey(ref))) throw missing();
  const terminalId = encryptedWrite
    ? parsedRecord!.id
    : casePath?.[3] === "outcome"
      ? context.query.get("id")
      : casePath?.[3] === "fence"
        ? context.body.id
        : null;
  if (typeof terminalId === "string") {
    const terminal = await storage.get<Reservation>(
      OPENING_FENCE + opaqueId(terminalId),
    );
    if (terminal) {
      if (encryptedWrite) throw unavailable();
      if (
        terminal.principal !== principal ||
        JSON.stringify(terminal.case) !== JSON.stringify(ref)
      )
        throw missing();
      if (await storage.get(`conversation-v1:${ref.conversation}`))
        await hooks.authorize(ref.conversation);
      if (casePath?.[3] === "fence" && context.method === "POST")
        object(wireBody, ["id"], ["confirmed"]);
      else if (casePath?.[3] !== "outcome" || context.method !== "GET")
        throw missing();
      const known = await encryptedOutcomeCheckpoint(
        storage as RelayStorage,
        ref,
        terminalId,
      );
      if (known?.state === "accepted") {
        if (known.principal !== principal) throw missing();
        return json({ state: "accepted", sequence: known.sequence });
      }
      return json({ state: "fenced" });
    }
  }
  state = await storage.get<RelayCaseState>(encryptedCaseStateKey(ref));
  if (!state || state.deleted) throw missing();
  reservation =
    (await storage.get<Reservation>(
      `${RESERVED_CASE}${ref.conversation}:${ref.caseSeq}`,
    )) ?? null;
  const existing = await hooks.authorize(ref.conversation).catch(() => null);
  // A retained reservation never bypasses the current native thread owner,
  // deletion marker or permissions. Resolution-only enrollment is for an
  // opening that never created a native thread.
  const deniedNative =
    !existing && (await storage.get(`conversation-v1:${ref.conversation}`));
  if (deniedNative) throw missing();
  const preparing =
    state.accepted === 0 &&
    reservation &&
    reservation.until > context.now &&
    policy && (policy.on || ownQualificationAllows(qualification, policy, reservation, context.now)) &&
    reservation.policyRevision === policy.revision &&
    reservation.profileSignature === policy.profile.signature;
  const resolving =
    state.accepted === 0 &&
    reservation?.principal === principal &&
    casePath &&
    [undefined, "enroll", "directory", "history", "fence", "outcome"].includes(
      casePath[3],
    );
  if (!existing && !preparing && !resolving) throw missing();
  if (casePath && !casePath[3] && context.method === "GET") {
    if (
      !existing &&
      reservation?.principal !== principal &&
      !(
        await Promise.all(
          context.aliases.map((id) => context.isSupportStaff?.(id)),
        )
      ).some(Boolean)
    )
      throw missing();
    const member = existing?.role === "member" ? existing.record.member :
      !existing && reservation?.principal === principal ? principal : undefined;
    const authorizationGrant = await nativeGrant(principal, member);
    const coverage = own ? await storage.get<RelayOutcomeCoverage>(encryptedOutcomeCoverageKey(ref)) : undefined;
    return json({
      v: 1,
      mode: "encrypted",
      case: state.case,
      profile: state.profile,
      policyRevision: state.policyRevision,
      capabilities: ["human-text-v1"],
      authorizationGrant,
      ...(own ? {enrollment: {
        principal, kind: member ? "member" : ownAi(principal) ? "ai" : "team", authorizationGrant,
        provisional: Boolean(preparing && reservation?.principal === principal && coverage?.accepted === 0),
        wallets: context.aliases.filter((id) => /^0x[a-f0-9]{40}$/.test(id)),
      }} : {}),
    });
  }
  const canRead = async (
    actor: string,
    certificate: ReturnType<typeof parseCertificate>,
  ) => {
    if (await unsupportedEndpoint(actor)) return false;
    if (own && await storage.get(OWN_DEVICE_REVOKED + certificate.grant)) return false;
    const aliases = await nativeAliases(actor);
    if (certificate.kind === "ai") {
      if (!ownAi(actor) || !existing || certificate.audiences.includes("team")) return false;
      const {effective} = await readAiState(storage, existing.record);
      return effective.mode !== "off" && certificate.authorizationGrant === await nativeGrant(actor) &&
        (await Promise.all(aliases.map(id => context.isSupportStaff?.(id)))).some(Boolean);
    }
    if (certificate.kind === "member") {
      return (
        (((preparing || resolving) && reservation?.principal === actor) ||
          Boolean(existing && actsAs(aliases, existing.record.member))) &&
        certificate.authorizationGrant ===
          (await nativeGrant(
            actor,
            existing?.record.member ?? reservation?.principal,
          ))
      );
    }
    return (
      certificate.kind === "team" &&
      (
        await Promise.all(aliases.map((id) => context.isSupportStaff?.(id)))
      ).some(Boolean) &&
      certificate.authorizationGrant === (await nativeGrant(actor))
    );
  };
  const relay = new EncryptedCaseRelay(storage as RelayStorage, state, {
    principal,
    now: context.now,
    authorizationRevision:
      (await storage.get<number>(PERMISSION_REVISION_KEY)) ?? 0,
    canRead,
    customerEndpoint: async (actor) => !(await unsupportedEndpoint(actor)),
    accept: async (record, receipt) => {
      if (context.mediaEnv.SUPPORT_ENCRYPTION_ENABLED !== "true")
        throw new HttpError(
          503,
          "Encrypted sending is paused. Your draft stays on your device.",
        );
      if (!existing && (!preparing || !active))
        throw new EncryptionProtocolError("encryption-scope-changed");
      if (reservation && !state!.accepted && (!preparing || !active))
        throw new EncryptionProtocolError("encryption-scope-changed");
      if (own && !state!.accepted) {
        if (!reservation?.ownRelease) throw unavailable();
        await requireOwnEncryptionReleasePair(context.mediaEnv, reservation.ownRelease);
      }
      await hooks.accept(reservation, record, receipt);
      if (reservation && qualification?.grant?.clientId === reservation.id)
        await forgetOwnQualification(storage, context.now, reservation.case);
    },
  });
  if (encryptedWrite) {
    object(
      wireBody,
      ["encryptedRecord", "validationReceipt"],
      ["reservation", "confirmed"],
    );
    if (
      !parsedRecord ||
      parsedRecord.scope.caseSeq !== ref.caseSeq ||
      parsedRecord.scope.conversation !== ref.conversation
    )
      throw missing();
    const opening = path === "/conversations/ask";
    if (
      opening &&
      (parsedRecord.id !== context.body.reservation ||
        !reservation ||
        reservation.principal !== principal ||
        (context.body.reservation !== reservation.id &&
          (await relay.outcome(parsedRecord.id)).state !== "accepted"))
    )
      throw unavailable();
    if (!opening && !existing) throw missing();
    const accepted = await relay.submit(
      parsedRecord,
      context.body.validationReceipt,
    );
    return json({ v: 1, mode: "encrypted", accepted });
  }
  const action = casePath?.[3];
  if (action === "contact") {
    if (!own || !existing || existing.role !== "member" || state.profile.custody !== "templ-own-support" || state.accepted === 0 ||
        state.profile.rootKey !== context.mediaEnv.OWN_SUPPORT_ENCRYPTION_ROOT || state.profile.clientOrigin !== OWN_SUPPORT_ENDPOINT.clientOrigin) throw missing();
    let writable = active && context.headers.get("X-Conversations") === "true" && context.headers.get("X-Support-Workflow") === "true" && !context.viewer.banned && !context.viewer.mutedUntil;
    if (context.method === "POST") {
      if (!active || context.headers.get("X-Conversations") !== "true" || context.headers.get("X-Support-Workflow") !== "true") throw unavailable();
      if (context.viewer.banned || context.viewer.mutedUntil) throw missing();
      await releaseFor(state.profile);
    } else if (writable) {try {await releaseFor(state.profile);} catch {writable = false;}}
    return ownContact(storage, {...context, body: wireBody}, ref, existing.record, Boolean(writable));
  }
  if (action === "control" && context.method === "GET") {
    if (!own || !existing || context.isBot || state.profile.custody !== "templ-own-support") throw missing();
    const {effective} = await readAiState(storage, existing.record);
    return json({caseSeq: ref.caseSeq, mode: effective.mode, state: existing.record.state,
      handoff: existing.record.handoff?.reason ?? null, stopped: Boolean(existing.record.stopped)});
  }
  if (action === "ai-context" && context.method === "GET") {
    if (!ownAi(principal) || !existing || state.profile.custody !== "templ-own-support") throw missing();
    return json(await ownAiContext(storage, context, existing.record, ref));
  }
  if (action === "ai-handoff" && context.method === "POST") {
    if (!own || !existing || existing.role !== "team") throw missing();
    await abandonOwnAiTurn(storage, context, existing.record, ref, wireBody);
    return json({handedOff: true});
  }
  if (action === "enroll" && context.method === "POST") {
    object(wireBody, ["certificate", "proof"], ["confirmed"]);
    await relay.enroll(context.body.certificate, String(context.body.proof));
    return json({ enrolled: true });
  }
  if (action === "directory" && context.method === "GET") {
    const audience = context.query.get("audience") ?? "conversation";
    if (!["conversation", "team", "ai-draft"].includes(audience))
      throw new EncryptionProtocolError();
    return json(await relay.directory(audience as E2eeAudience));
  }
  if (action === "history" && context.method === "GET") {
    const audience = context.query.get("audience") ?? "conversation";
    if (!["conversation", "team", "ai-draft"].includes(audience))
      throw new EncryptionProtocolError();
    return json(
      await relay.historyPage(
        Number(context.query.get("after") ?? 0),
        Number(context.query.get("limit") ?? 50),
        audience as E2eeAudience,
      ),
    );
  }
  if (action === "outcome" && context.method === "GET")
    return json(await relay.outcome(context.query.get("id") ?? ""));
  if (action === "fence" && context.method === "POST") {
    object(wireBody, ["id"], ["confirmed"]);
    if (!existing && reservation?.id !== context.body.id) throw missing();
    return json(await relay.fence(String(context.body.id)));
  }
  if (action === "revoke" && context.method === "POST") {
    object(wireBody, ["id"], ["confirmed"]);
    await relay.revoke(String(context.body.id));
    return json({ revoked: true });
  }
  throw missing();
}
