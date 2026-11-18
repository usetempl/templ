/** Public-key-only relay state. Call each operation inside the native case's
 * storage transaction; native authorization and quota/billing callbacks run
 * there too. This module has no endpoint/private-key/HPKE dependency. */
import {
  EncryptionProtocolError,
  E2EE_LIMITS,
  base64url,
  certificateBytes,
  caseOf,
  opaqueId,
  parseCertificate,
  parseEncryptionProfile,
  parseEncryptedRecord,
  utf8,
  type EncryptionProfile,
  type EndpointCertificate,
  type EncryptedRecord,
  type E2eeAudience,
  type E2eeCase,
  type E2eeScope,
  type ValidationReceipt,
} from "./protocol";
import {
  encryptedRecordDigest,
  recipientRosterDigest,
  verifyCertificate,
  verifyEncryptionProfile,
  verifySignature,
  verifySubmission,
} from "./verify";

export interface RelayStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  list<T>(options: {
    prefix: string;
    startAfter?: string;
    limit: number;
  }): Promise<Map<string, T>>;
  delete(key: string): Promise<boolean>;
}
export type RelayEndpoint = {
  principal: string;
  certificate: EndpointCertificate;
  revoked: boolean;
};
export type RelayCaseState = {
  v: 1;
  case: E2eeCase;
  profile: EncryptionProfile;
  policyRevision: number;
  epoch: number;
  authorizationRevision: number;
  endpoints: RelayEndpoint[];
  activeRecipients: string[];
  nativeAuthorizationRevision: number;
  accepted: number;
  fences: number;
  deleted: boolean;
  acceptedByAudience: Record<E2eeAudience, number>;
};
export type StoredEncryptedRecord = {
  v: 1;
  sequence: number;
  acceptedAt: number;
  record: EncryptedRecord;
  receipt: ValidationReceipt;
};
export type RelayOutcome =
  | {
      state: "accepted";
      digest: string;
      principal: string;
      sequence: number;
      storageSequence: number;
    }
  | { state: "fenced"; principal: string };
type PublicOutcome =
  | { state: "accepted"; sequence: number }
  | { state: "fenced" };
export type RelayAuthority = {
  principal: string;
  now: number;
  authorizationRevision: number;
  /** Fresh native role/case/AI-mode checks, never an endpoint's claim. */
  canRead: (
    principal: string,
    certificate: EndpointCertificate,
  ) => Promise<boolean>;
  /** Always false for Templ-hosted AI, native AI or platform operators. */
  customerEndpoint: (principal: string) => Promise<boolean>;
  /** Checks bans, mute, stop, handoff, plan, capacity and current case.
   * Writes the native case ledger/usage exactly once in the same transaction. */
  accept: (
    record: EncryptedRecord,
    receipt: ValidationReceipt,
  ) => Promise<void>;
};

const prefix = (c: E2eeCase) =>
  `support-encrypted-v1:${c.conversation}:${String(c.caseSeq).padStart(8, "0")}:`;
export const encryptedCaseStateKey = (c: E2eeCase) => `${prefix(c)}state`;
/** Content-free deletion decisions survive restoration of older ciphertext. */
export const encryptedCaseDeletionKey = (c: E2eeCase) =>
  `support-encrypted-deleted-v1:${c.conversation}:${String(c.caseSeq).padStart(8, "0")}`;
const rowKey = (c: E2eeCase, sequence: number) =>
  `${prefix(c)}row:${String(sequence).padStart(16, "0")}`;
const viewKey = (c: E2eeCase, audience: E2eeAudience, sequence: number) =>
  `${prefix(c)}view:${audience}:${String(sequence).padStart(16, "0")}`;
/** Native internal read. The caller must already authorize this case and
 * audience. Never expose this helper as an unauthenticated route. */
export async function readEncryptedAudienceRecord(storage: Pick<RelayStorage, "get">, c: E2eeCase, audience: E2eeAudience, sequence: number) {
  if (!Number.isSafeInteger(sequence) || sequence < 1) return undefined;
  const position = await storage.get<number>(viewKey(c, audience, sequence));
  if (!Number.isSafeInteger(position) || position! < 1) return undefined;
  const row = await storage.get<StoredEncryptedRecord>(rowKey(c, position!));
  if (!row || row.sequence !== sequence || row.record.scope.audience !== audience ||
      row.record.scope.conversation !== c.conversation || row.record.scope.caseSeq !== c.caseSeq) return undefined;
  return row;
}
const outcomeKey = (c: E2eeCase, id: string) =>
  `${prefix(c)}outcome:${opaqueId(id)}`;
export const encryptedOutcomePrefix = (c: Pick<E2eeCase, "conversation">) =>
  `support-encrypted-outcome-v1:${c.conversation}:`;
const checkpointPrefix = (c: E2eeCase) =>
  `${encryptedOutcomePrefix(c)}${String(c.caseSeq).padStart(8, "0")}:`;
export const encryptedOutcomeCheckpointKey = (c: E2eeCase, id: string) =>
  `${checkpointPrefix(c)}outcome:${opaqueId(id)}`;
export const encryptedOutcomeCoverageKey = (c: E2eeCase) =>
  `${checkpointPrefix(c)}coverage`;
export type RelayOutcomeCoverage = {
  v: 1;
  case: E2eeCase;
  accepted: number;
  acceptedByAudience: Record<E2eeAudience, number>;
  fences: number;
};
/** Native point-in-time recovery preserves these metadata-only decisions.
 * They prevent an older case image from turning an accepted send into absent. */
export async function encryptedOutcomeCheckpoint(
  storage: RelayStorage,
  c: E2eeCase,
  id: string,
) {
  return (
    (await storage.get<RelayOutcome>(encryptedOutcomeCheckpointKey(c, id))) ??
    (await storage.get<RelayOutcome>(outcomeKey(c, id)))
  );
}
const noAccess = (): never => {
  throw new EncryptionProtocolError("encryption-integrity");
};
export function enrollmentProofBytes(
  certificate: EndpointCertificate,
  principal: string,
): Uint8Array {
  // A certificate cannot be taken from a directory and rebound to another
  // native account, even by someone with a newly granted Templ role.
  return utf8(
    JSON.stringify([
      "templ:e2ee:enroll:v1",
      base64url(certificateBytes(certificate)),
      certificate.signature,
      principal,
    ]),
  );
}
export async function createRelayCase(
  storage: RelayStorage,
  input: {
    case: E2eeCase;
    profile: unknown;
    pinnedRoot: string;
    policyRevision: number;
  },
): Promise<RelayCaseState> {
  if (await storage.get(encryptedCaseDeletionKey(input.case)))
    return noAccess();
  const profile = await verifyEncryptionProfile(
    input.profile,
    input.pinnedRoot,
  );
  if (
    profile.workspace !== input.case.workspace ||
    profile.environment !== input.case.environment ||
    !Number.isSafeInteger(input.policyRevision) ||
    input.policyRevision < 1
  )
    return noAccess();
  const prior = await storage.get<RelayCaseState>(
    encryptedCaseStateKey(input.case),
  );
  if (prior) {
    if (
      prior.deleted ||
      prior.policyRevision !== input.policyRevision ||
      prior.profile.signature !== profile.signature
    )
      return noAccess();
    return prior;
  }
  // An older restored case image cannot create a fresh sequence space over
  // delivery decisions that were already acknowledged on the current timeline.
  if (await storage.get(encryptedOutcomeCoverageKey(input.case)))
    return noAccess();
  const state: RelayCaseState = {
    v: 1,
    case: caseOf(input.case),
    profile,
    policyRevision: input.policyRevision,
    epoch: 1,
    authorizationRevision: 0,
    nativeAuthorizationRevision: -1,
    endpoints: [],
    activeRecipients: [],
    accepted: 0,
    fences: 0,
    deleted: false,
    acceptedByAudience: { conversation: 0, team: 0, "ai-draft": 0 },
  };
  await storage.put(encryptedCaseStateKey(input.case), state);
  await storage.put(encryptedOutcomeCoverageKey(input.case), {
    v: 1,
    case: caseOf(input.case),
    accepted: 0,
    fences: 0,
    acceptedByAudience: { conversation: 0, team: 0, "ai-draft": 0 },
  } satisfies RelayOutcomeCoverage);
  return state;
}
export class EncryptedCaseRelay {
  constructor(
    private storage: RelayStorage,
    private state: RelayCaseState,
    private authority: RelayAuthority,
  ) {}
  private async save() {
    await this.storage.put(encryptedCaseStateKey(this.state.case), this.state);
  }
  private async reconcileCounters() {
    const coverage = await this.storage.get<RelayOutcomeCoverage>(
      encryptedOutcomeCoverageKey(this.state.case),
    );
    if (
      !coverage ||
      coverage.v !== 1 ||
      JSON.stringify(coverage.case) !== JSON.stringify(this.state.case) ||
      ![
        coverage.accepted,
        coverage.fences,
        ...Object.values(coverage.acceptedByAudience ?? {}),
      ].every((n) => Number.isSafeInteger(n) && n >= 0) ||
      !["conversation", "team", "ai-draft"].every((a) =>
        Number.isSafeInteger(coverage.acceptedByAudience?.[a as E2eeAudience]),
      )
    )
      return noAccess();
    this.state.accepted = Math.max(this.state.accepted, coverage.accepted);
    this.state.fences = Math.max(this.state.fences, coverage.fences);
    for (const audience of ["conversation", "team", "ai-draft"] as const)
      this.state.acceptedByAudience[audience] = Math.max(
        this.state.acceptedByAudience[audience],
        coverage.acceptedByAudience[audience],
      );
  }
  private async saveCounters() {
    await this.storage.put(encryptedOutcomeCoverageKey(this.state.case), {
      v: 1,
      case: this.state.case,
      accepted: this.state.accepted,
      fences: this.state.fences,
      acceptedByAudience: this.state.acceptedByAudience,
    } satisfies RelayOutcomeCoverage);
  }
  private async caller(): Promise<RelayEndpoint> {
    if (
      this.state.deleted ||
      (await this.storage.get(encryptedCaseDeletionKey(this.state.case))) ||
      !(await this.authority.customerEndpoint(this.authority.principal))
    )
      return noAccess();
    for (const caller of this.state.endpoints) {
      if (caller.principal === this.authority.principal && !caller.revoked &&
          caller.certificate.issuedAt <= this.authority.now && caller.certificate.expiresAt > this.authority.now &&
          await this.authority.canRead(caller.principal, caller.certificate)) return caller;
    }
    return noAccess();
  }
  /** Enrollment needs the customer's signed approval AND this key's proof
   * of possession bound to the currently authenticated native account. */
  async enroll(value: unknown, proof: string): Promise<void> {
    if (
      this.state.deleted ||
      (await this.storage.get(encryptedCaseDeletionKey(this.state.case))) ||
      !(await this.authority.customerEndpoint(this.authority.principal))
    )
      return noAccess();
    const certificate = parseCertificate(value);
    await verifyCertificate(
      this.state.profile,
      certificate,
      this.authority.now,
    );
    if (
      JSON.stringify(caseOf(certificate)) !== JSON.stringify(this.state.case) ||
      certificate.kind === "customer-service" ||
      !(await this.authority.canRead(this.authority.principal, certificate)) ||
      !(await verifySignature(
        certificate.signingKey,
        proof,
        enrollmentProofBytes(certificate, this.authority.principal),
      ))
    )
      return noAccess();
    const previousCount = this.state.endpoints.length;
    this.state.endpoints = this.state.endpoints.filter(
      (e) => e.certificate.expiresAt > this.authority.now,
    );
    const existing = this.state.endpoints.find(
      (e) => e.certificate.id === certificate.id,
    );
    if (existing) {
      if (
        existing.revoked ||
        existing.principal !== this.authority.principal ||
        existing.certificate.signature !== certificate.signature
      )
        return noAccess();
      if (this.state.endpoints.length !== previousCount) {
        await this.reconcile();
        // Even if a prior directory already removed these active IDs, persist
        // expiry pruning before returning an identical enrollment response.
        await this.save();
      }
      return;
    }
    // A restore can invalidate every enrolled grant. Reconcile before checking
    // active capacity so an independently reapproved device can recover access.
    await this.reconcile();
    if (
      this.state.endpoints.length >= 128 ||
      this.state.endpoints.filter((e) => !e.revoked).length >=
        E2EE_LIMITS.recipients - 1
    )
      throw new EncryptionProtocolError();
    this.state.endpoints.push({
      principal: this.authority.principal,
      certificate,
      revoked: false,
    });
    await this.reconcile();
  }
  /** Losing native access takes effect before directory delivery or commit.
   * Removed/expired certificates never become valid again after a restore
   * or re-promotion; the customer must approve a fresh certificate. */
  private async reconcile(): Promise<RelayEndpoint[]> {
    if (this.state.deleted) return noAccess();
    const current: RelayEndpoint[] = [];
    for (const endpoint of this.state.endpoints) {
      if (endpoint.revoked) continue;
      const permitted =
        (await this.authority.customerEndpoint(endpoint.principal)) &&
        (await this.authority.canRead(
          endpoint.principal,
          endpoint.certificate,
        ));
      if (!permitted) endpoint.revoked = true;
      else if (endpoint.certificate.expiresAt > this.authority.now)
        current.push(endpoint);
    }
    const ids = current.map((e) => e.certificate.id).sort();
    const rosterChanged =
      JSON.stringify(ids) !== JSON.stringify(this.state.activeRecipients);
    if (
      rosterChanged ||
      this.state.nativeAuthorizationRevision !==
        this.authority.authorizationRevision
    ) {
      this.state.activeRecipients = ids;
      this.state.nativeAuthorizationRevision =
        this.authority.authorizationRevision;
      // Native permission revisions also advance for private conversation
      // activity. Expose a new encryption epoch only for a changed roster.
      // Current authority is independently rechecked before every operation.
      if (rosterChanged) {
        this.state.epoch++;
        this.state.authorizationRevision++;
      }
      await this.save();
    }
    return current;
  }
  async directory(audience: E2eeAudience): Promise<{
    scope: E2eeScope;
    recipients: EndpointCertificate[];
    profile: EncryptionProfile;
  }> {
    const caller = await this.caller();
    if (!caller.certificate.audiences.includes(audience)) return noAccess();
    const recipients = (await this.reconcile())
      .map((e) => e.certificate)
      .filter((c) => c.audiences.includes(audience));
    if (!recipients.some((c) => c.id === caller.certificate.id))
      return noAccess();
    return {
      profile: parseEncryptionProfile(this.state.profile),
      recipients,
      scope: {
        ...this.state.case,
        audience,
        epoch: this.state.epoch,
        authorizationRevision: this.state.authorizationRevision,
        policyRevision: this.state.policyRevision,
        rosterDigest: await recipientRosterDigest(
          this.state.profile,
          recipients,
        ),
      },
    };
  }
  /** Original accepted outcomes are checked before receipt/certificate expiry
   * or epoch validation. Current case authority is still mandatory. */
  async submit(
    recordValue: unknown,
    receiptValue: unknown,
  ): Promise<StoredEncryptedRecord> {
    await this.caller();
    const record = parseEncryptedRecord(recordValue);
    const old = await encryptedOutcomeCheckpoint(
      this.storage,
      this.state.case,
      record.id,
    );
    if (old) {
      if (
        old.principal !== this.authority.principal ||
        old.state === "fenced" ||
        old.digest !== (await encryptedRecordDigest(record))
      )
        return noAccess();
      const accepted = await this.storage.get<StoredEncryptedRecord>(
        rowKey(this.state.case, old.storageSequence),
      );
      if (
        !accepted ||
        accepted.sequence !== old.sequence ||
        accepted.record.id !== record.id ||
        (await encryptedRecordDigest(accepted.record)) !== old.digest
      )
        return noAccess();
      return accepted;
    }
    const endpoint = this.state.endpoints.find(
      (e) =>
        e.certificate.id === record.sender &&
        e.principal === this.authority.principal &&
        !e.revoked,
    );
    if (
      !endpoint ||
      endpoint.certificate.signature !== record.certificate.signature
    )
      return noAccess();
    const directory = await this.directory(record.scope.audience);
    const requiredIds = [
      this.state.profile.recoveryRecipient,
      ...directory.recipients.map((c) => c.id),
    ].sort();
    if (
      JSON.stringify(requiredIds) !==
      JSON.stringify(record.recipients.map((r) => r.id))
    )
      throw new EncryptionProtocolError("encryption-scope-changed");
    const verified = await verifySubmission({
      profile: this.state.profile,
      pinnedRoot: this.state.profile.rootKey,
      record,
      receipt: receiptValue,
      scope: directory.scope,
      actor: endpoint.certificate.actor,
      now: this.authority.now,
    });
    await this.reconcileCounters();
    await this.authority.accept(verified.record, verified.receipt);
    const storageSequence = this.state.accepted + 1;
    const sequence = this.state.acceptedByAudience[record.scope.audience] + 1;
    const accepted: StoredEncryptedRecord = {
      v: 1,
      sequence,
      acceptedAt: this.authority.now,
      record: verified.record,
      receipt: verified.receipt,
    };
    await this.storage.put(rowKey(this.state.case, storageSequence), accepted);
    await this.storage.put(
      viewKey(this.state.case, record.scope.audience, sequence),
      storageSequence,
    );
    const outcome: RelayOutcome = {
      state: "accepted",
      principal: this.authority.principal,
      sequence,
      storageSequence,
      digest: verified.digest,
    };
    await this.storage.put(outcomeKey(this.state.case, record.id), outcome);
    await this.storage.put(
      encryptedOutcomeCheckpointKey(this.state.case, record.id),
      outcome,
    );
    this.state.accepted = storageSequence;
    this.state.acceptedByAudience[record.scope.audience] = sequence;
    await this.saveCounters();
    await this.save();
    return accepted;
  }
  async outcome(id: string): Promise<PublicOutcome | { state: "absent" }> {
    await this.caller();
    const outcome = await encryptedOutcomeCheckpoint(
      this.storage,
      this.state.case,
      id,
    );
    if (outcome && outcome.principal !== this.authority.principal)
      return noAccess();
    return !outcome
      ? { state: "absent" }
      : outcome.state === "accepted"
        ? { state: "accepted", sequence: outcome.sequence }
        : { state: "fenced" };
  }
  /** Fence under the same transaction lock as submit. A lost response is
   * resolved before a replacement is ever encrypted with a new ID. */
  async fence(id: string): Promise<PublicOutcome> {
    const outcome = await this.outcome(id);
    if (outcome.state !== "absent") return outcome;
    await this.reconcileCounters();
    if (this.state.fences >= 256) throw new EncryptionProtocolError();
    const fence: RelayOutcome = {
      state: "fenced",
      principal: this.authority.principal,
    };
    await this.storage.put(outcomeKey(this.state.case, id), fence);
    await this.storage.put(
      encryptedOutcomeCheckpointKey(this.state.case, id),
      fence,
    );
    this.state.fences++;
    await this.saveCounters();
    await this.save();
    return { state: "fenced" };
  }
  async history(
    after = 0,
    limit = 50,
    audience: E2eeAudience = "conversation",
  ): Promise<StoredEncryptedRecord[]> {
    return (await this.historyPage(after, limit, audience)).records;
  }
  async historyPage(
    after = 0,
    limit = 50,
    audience: E2eeAudience = "conversation",
  ): Promise<{ records: StoredEncryptedRecord[]; nextAfter: number | null }> {
    const caller = await this.caller();
    if (!caller.certificate.audiences.includes(audience)) return noAccess();
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new EncryptionProtocolError();
    const index = await this.storage.list<number>({
      prefix: `${prefix(this.state.case)}view:${audience}:`,
      startAfter: viewKey(this.state.case, audience, after),
      limit,
    });
    const records = await Promise.all(
      [...index.values()].map((sequence) =>
        this.storage.get<StoredEncryptedRecord>(
          rowKey(this.state.case, sequence),
        ),
      ),
    );
    if (records.some((row) => !row || row.record.scope.audience !== audience))
      return noAccess();
    const rows = records as StoredEncryptedRecord[];
    return { records: rows, nextAfter: rows.at(-1)?.sequence ?? null };
  }
  async revoke(id: string): Promise<void> {
    await this.caller();
    const endpoint = this.state.endpoints.find(
      (e) => e.certificate.id === opaqueId(id),
    );
    if (!endpoint || endpoint.principal !== this.authority.principal)
      return noAccess();
    endpoint.revoked = true;
    await this.reconcile();
    await this.save();
  }
}

/** Content/key packages are pruned through the same native legal-hold and
 * retention transaction as their case. Keep the state tombstone until the
 * native case itself is removed, so delayed operations cannot resurrect it. */
export async function deleteEncryptedCaseData(
  storage: RelayStorage,
  ref: E2eeCase,
  budget: number,
  preserveDeletion = true,
): Promise<number> {
  if (budget < 1) return 0;
  const state = await storage.get<RelayCaseState>(encryptedCaseStateKey(ref));
  if (
    preserveDeletion &&
    (state || (await storage.get(encryptedOutcomeCoverageKey(ref))))
  )
    await storage.put(encryptedCaseDeletionKey(ref), true);
  if (state && !state.deleted) {
    state.deleted = true;
    state.endpoints = [];
    state.activeRecipients = [];
    await storage.put(encryptedCaseStateKey(ref), state);
  }
  const rows = await storage.list({
    prefix: prefix(ref),
    limit: Math.min(budget + 1, 128),
  });
  let removed = 0;
  for (const [key] of rows) {
    if (key === encryptedCaseStateKey(ref)) continue;
    if (removed >= budget) break;
    if (await storage.delete(key)) removed++;
  }
  if (removed < budget && rows.size < 128) {
    const checkpoints = await storage.list({
      prefix: checkpointPrefix(ref),
      limit: Math.min(budget - removed, 128),
    });
    for (const key of checkpoints.keys())
      if (await storage.delete(key)) removed++;
  }
  return removed;
}
