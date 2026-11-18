/** Customer-origin transport. Native authentication is supplied by the
 * customer's app/bridge; customer key approval remains independent of it. */
import {
  decryptRecord,
  encryptRecord,
  exportPublic,
  type EndpointKeys,
} from "./client";
import { sign } from "./endpoint-crypto";
import { enrollmentProofBytes } from "./relay";
import {
  EncryptionProtocolError,
  opaqueId,
  parseEncryptedRecord,
  parseValidationReceipt,
  sameScope,
  caseOf,
  parseCase,
  type E2eeCase,
  type EncryptionProfile,
  type E2eePurpose,
  type E2eeScope,
  type EndpointCertificate,
  type EncryptedRecord,
  type ValidationReceipt,
} from "./protocol";
import {
  encryptedRecordDigest,
  verifyAcceptedRecord,
  verifyCertificate,
  verifyEncryptionProfile,
  verifySubmission,
} from "./verify";
import type { StoredEncryptedRecord } from "./relay";

export type EndpointIdentity = {
  account: string;
  revision: number;
  certificate: EndpointCertificate;
  keys: EndpointKeys;
};
export type EncryptedOutboxEntry = {
  v: 1;
  state: "ready" | "unknown" | "accepted" | "fenced";
  record: EncryptedRecord;
  receipt: ValidationReceipt;
  route: string;
  reservation?: string;
};
export interface EncryptedOutbox {
  get(id: string): Promise<EncryptedOutboxEntry | undefined>;
  put(entry: EncryptedOutboxEntry): Promise<void>;
}
export type VerifiedHistoryRow = {row: StoredEncryptedRecord; content: unknown};
export type EncryptedSendPhase = "keys" | "encrypting" | "checking" | "sending";
export type EncryptedTransportOptions = {
  profile: EncryptionProfile;
  pinnedRoot: string;
  identity: () => EndpointIdentity;
  /** Authenticated native route. No plaintext or private key is passed. */
  request: <T>(path: string, body?: object) => Promise<T>;
  /** Customer HTTPS service constructs packages and signs its receipt. */
  validate: (
    record: EncryptedRecord,
    directory: {
      profile: EncryptionProfile;
      scope: E2eeScope;
      recipients: EndpointCertificate[];
    },
  ) => Promise<{ record: EncryptedRecord; receipt: ValidationReceipt }>;
  outbox: EncryptedOutbox;
  /** Bounded independent reads; writes and native authority checks are unchanged. */
  historyConcurrency?: 1 | 2;
  /** For a new customer-approved device. Must never accept a Templ session
   * or Templ-issued email resume link as its sole recovery proof. */
  recover?: (
    row: StoredEncryptedRecord,
    identity: EndpointIdentity,
    authorizationRevision: number,
  ) => Promise<unknown>;
};
export class EncryptedSupportTransport {
  constructor(private options: EncryptedTransportOptions) {
    if (options.historyConcurrency !== undefined && ![1, 2].includes(options.historyConcurrency)) throw new EncryptionProtocolError();
  }
  get certificateExpiresAt() {
    return this.options.identity().certificate.expiresAt;
  }
  get case() {
    return caseOf(this.options.identity().certificate);
  }
  private assertCurrent(identity: EndpointIdentity) {
    const current = this.options.identity();
    if (
      current.account !== identity.account ||
      current.revision !== identity.revision ||
      current.certificate.id !== identity.certificate.id
    )
      throw new EncryptionProtocolError("encryption-scope-changed");
  }
  private base(scope: Pick<E2eeScope, "conversation" | "caseSeq">) {
    return `/conversations/${scope.conversation}/encryption/${scope.caseSeq}`;
  }
  private async directory(
    identity: EndpointIdentity,
    audience: E2eeScope["audience"],
  ) {
    const scope = identity.certificate;
    const result = await this.options.request<{
      profile: EncryptionProfile;
      scope: E2eeScope;
      recipients: EndpointCertificate[];
    }>(`${this.base(scope)}/directory?audience=${audience}`);
    this.assertCurrent(identity);
    const profile = await verifyEncryptionProfile(
      result.profile,
      this.options.pinnedRoot,
    );
    if (
      profile.signature !== this.options.profile.signature ||
      result.scope.workspace !== profile.workspace ||
      result.scope.environment !== profile.environment ||
      result.scope.conversation !== scope.conversation ||
      result.scope.caseSeq !== scope.caseSeq ||
      result.scope.audience !== audience
    )
      throw new EncryptionProtocolError("encryption-scope-changed");
    return result;
  }
  async send(input: {
    content: unknown;
    purpose: E2eePurpose;
    audience: E2eeScope["audience"];
    opening?: string;
    replyIntent?: "answer" | "update";
    id?: string;
    onPhase?: (phase: EncryptedSendPhase) => void;
  }) {
    input.onPhase?.("keys");
    const identity = this.options.identity(),
      directory = await this.directory(identity, input.audience);
    const id = opaqueId(input.opening ?? input.id ?? crypto.randomUUID());
    if (await this.options.outbox.get(id))
      throw new EncryptionProtocolError("encryption-integrity");
    this.assertCurrent(identity);
    input.onPhase?.("encrypting");
    const candidate = await encryptRecord({
      profile: this.options.profile,
      pinnedRoot: this.options.pinnedRoot,
      scope: directory.scope,
      certificate: identity.certificate,
      keys: identity.keys,
      purpose: input.purpose,
      content: input.content,
      id,
      replyIntent: input.replyIntent,
      recipients: directory.recipients
        .filter((c) => c.id !== identity.certificate.id)
        .map((certificate) => ({ certificate })),
    });
    this.assertCurrent(identity);
    input.onPhase?.("checking");
    const checked = await this.options.validate(candidate, directory);
    this.assertCurrent(identity);
    // The customer service may change packages only. It cannot silently
    // replace the author's message, intent, sender, nonce or scope.
    if (
      candidate.signature !== checked.record.signature ||
      !sameScope(candidate.scope, checked.record.scope) ||
      candidate.id !== checked.record.id
    )
      throw new EncryptionProtocolError("encryption-integrity");
    const verified = await verifySubmission({
      profile: this.options.profile,
      pinnedRoot: this.options.pinnedRoot,
      ...checked,
      scope: directory.scope,
      actor: identity.certificate.actor,
      now: Date.now(),
    });
    const entry: EncryptedOutboxEntry = {
      v: 1,
      state: "ready",
      record: verified.record,
      receipt: verified.receipt,
      route: input.opening
        ? "/conversations/ask"
        : `/conversations/${directory.scope.conversation}/messages`,
      ...(input.opening ? { reservation: input.opening } : {}),
    };
    this.assertCurrent(identity);
    await this.options.outbox.put(entry);
    this.assertCurrent(identity);
    input.onPhase?.("sending");
    return this.deliver(entry, identity);
  }
  /** Restart-safe delivery always reuses the exact saved envelope. A failed
   * transport is unknown, even when it happens after the server commits. */
  private async deliver(
    entry: EncryptedOutboxEntry,
    identity: EndpointIdentity,
  ): Promise<{ state: "accepted" | "unknown"; id: string }> {
    try {
      const answer = await this.options.request<{
        accepted: StoredEncryptedRecord;
      }>(entry.route, {
        encryptedRecord: entry.record,
        validationReceipt: entry.receipt,
        ...(entry.reservation ? { reservation: entry.reservation } : {}),
      });
      this.assertCurrent(identity);
      if (
        (await encryptedRecordDigest(answer.accepted.record)) !==
        (await encryptedRecordDigest(entry.record))
      )
        throw new EncryptionProtocolError("encryption-integrity");
      await this.options.outbox.put({ ...entry, state: "accepted" });
      return { state: "accepted", id: entry.record.id };
    } catch {
      this.assertCurrent(identity);
      await this.options.outbox.put({ ...entry, state: "unknown" });
      return { state: "unknown", id: entry.record.id };
    }
  }
  async retry(id: string) {
    const identity = this.options.identity(),
      entry = await this.options.outbox.get(opaqueId(id));
    this.assertCurrent(identity);
    if (
      !entry ||
      entry.record.certificate.actor !== identity.certificate.actor ||
      entry.record.scope.conversation !== identity.certificate.conversation ||
      entry.record.scope.caseSeq !== identity.certificate.caseSeq
    )
      throw new EncryptionProtocolError("encryption-integrity");
    if (entry.state === "fenced") return { state: "fenced" as const, id };
    return this.deliver(entry, identity);
  }
  /** Resolve/fence before allowing a changed draft, new record ID or epoch.
   * The native transaction serializes this against a delayed old send. */
  async fence(id: string): Promise<"accepted" | "fenced"> {
    const identity = this.options.identity(),
      entry = await this.options.outbox.get(opaqueId(id));
    this.assertCurrent(identity);
    if (!entry) throw new EncryptionProtocolError();
    if (entry.state === "fenced") return "fenced";
    const answer = await this.options.request<{ state: "accepted" | "fenced" }>(
      `${this.base(entry.record.scope)}/fence`,
      { id },
    );
    this.assertCurrent(identity);
    if (answer.state !== "accepted" && answer.state !== "fenced")
      throw new EncryptionProtocolError();
    await this.options.outbox.put({ ...entry, state: answer.state });
    return answer.state;
  }
  async history(after = 0, audience?: E2eeScope["audience"], limit = 50, onVerifiedRow?: (value: VerifiedHistoryRow) => void) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new EncryptionProtocolError();
    const identity = this.options.identity(), view = audience ?? "conversation";
    const own = this.options.profile.custody === "templ-own-support";
    const readPage = () => this.options.request<{
      records: StoredEncryptedRecord[];
      nextAfter: number | null;
    }>(
      `${this.base(identity.certificate)}/history?after=${after}&limit=${limit}&audience=${view}`,
    );
    // Own's native history route checks current permission independently of
    // the directory. Wait for both before decrypting or recovering any row.
    const [directory, page] = own
      ? await Promise.all([this.directory(identity, view), readPage()])
      : [await this.directory(identity, view), await readPage()];
    this.assertCurrent(identity);
    if (!Array.isArray(page.records) || page.records.length > limit) throw new EncryptionProtocolError("encryption-integrity");
    const rows: (VerifiedHistoryRow | undefined)[] = new Array(page.records.length);
    let cursor = 0, failed = false, failure: unknown;
    const readRow = async (row: StoredEncryptedRecord, index: number) => {
      const record = parseEncryptedRecord(row.record),
        receipt = parseValidationReceipt(row.receipt);
      if (
        !identity.certificate.audiences.includes(record.scope.audience) ||
        record.scope.workspace !== directory.scope.workspace ||
        record.scope.environment !== directory.scope.environment ||
        record.scope.conversation !== directory.scope.conversation ||
        record.scope.caseSeq !== directory.scope.caseSeq
      )
        throw new EncryptionProtocolError("encryption-integrity");
      let content: unknown;
      if (record.recipients.some((r) => r.id === identity.certificate.id))
        content = await decryptRecord({
          profile: this.options.profile,
          pinnedRoot: this.options.pinnedRoot,
          record,
          receipt,
          scope: record.scope,
          recipientId: identity.certificate.id,
          keys: identity.keys,
        });
      else {
        if (!this.options.recover)
          throw new EncryptionProtocolError("encryption-integrity");
        const pack = await this.options.recover(
          row,
          identity,
          directory.scope.authorizationRevision,
        );
        this.assertCurrent(identity);
        const { decryptRecoveredRecord } = await import("./client");
        content = await decryptRecoveredRecord({
          profile: this.options.profile,
          pinnedRoot: this.options.pinnedRoot,
          record,
          receipt,
          recoveredKey: pack,
          certificate: identity.certificate,
          keys: identity.keys,
          authorizationRevision: directory.scope.authorizationRevision,
        });
      }
      this.assertCurrent(identity);
      if (failed) return;
      if (!audience || record.scope.audience === audience) {
        rows[index] = {row, content};
        // A display notification never advances the page cursor or completes
        // an export. Do not let its consumer mutate the returned snapshot.
        onVerifiedRow?.(structuredClone({row, content}));
        this.assertCurrent(identity);
      }
    };
    const worker = async () => {
      while (!failed) {
        const index = cursor++;
        if (index >= page.records.length) return;
        try {this.assertCurrent(identity); await readRow(page.records[index], index);}
        catch (error) {failed = true; failure = error;}
      }
    };
    // Drain already-started reads before returning an error. Never publish a
    // late row or start another recovery after a peer failed.
    await Promise.all(Array.from({length: Math.min(this.options.historyConcurrency ?? 1, page.records.length)}, worker));
    if (failed) throw failure;
    this.assertCurrent(identity);
    // The Own native relay lists up to the requested cap. A short page has
    // reached the end of that read, even when an older relay returns its tail.
    return { rows: rows.filter((row): row is VerifiedHistoryRow => row !== undefined),
      nextAfter: own && page.records.length < limit ? null : page.nextAfter };
  }
}

/** Open only after Send, or explicitly reconnect an existing case. The
 * customer issues the device certificate through its own authentication. */
export async function connectCustomerCase(
  input: Omit<EncryptedTransportOptions, "identity"> & {
    principal: string;
    account: string;
    revision: () => number;
    keys: EndpointKeys;
    kind: "member" | "team" | "ai";
    existing?: E2eeCase;
    openingId?: string;
    /** Own members may choose a person before the first accepted message. */
    initialAiMode?: "off";
    pending?: EncryptedOutboxEntry;
    issueCertificate: (request: {
      case: E2eeCase;
      kind: "member" | "team" | "ai";
      encryptionKey: string;
      signingKey: string;
      authorizationGrant?: string;
    }) => Promise<EndpointCertificate>;
  },
): Promise<{ transport: EncryptedSupportTransport; opening?: string }> {
  const start = input.revision(),
    current = () => {
      if (input.revision() !== start)
        throw new EncryptionProtocolError("encryption-scope-changed");
    };
  if (input.pending) {
    const profile = await verifyEncryptionProfile(
      input.profile,
      input.pinnedRoot,
    );
    const record = await verifyAcceptedRecord(
      profile,
      input.pending.record,
      input.pending.receipt,
    );
    if (
      record.certificate.kind !== input.kind ||
      record.certificate.encryptionKey !==
        (await exportPublic(input.keys.encryption.publicKey)) ||
      record.certificate.signingKey !==
        (await exportPublic(input.keys.signing.publicKey))
    )
      throw new EncryptionProtocolError("encryption-integrity");
    current();
    if (input.pending.reservation) {
      // A native fence can outlive an abandoned preparation's key directory.
      // Absence/errors prove nothing about whether a send was accepted.
      let fenced = false;
      try {
        const outcome = await input.request<{ state: string }>(
          `/conversations/${record.scope.conversation}/encryption/${record.scope.caseSeq}/outcome?id=${record.id}`,
        );
        current();
        fenced = outcome.state === "fenced";
      } catch {
        current();
      }
      if (fenced) {
        await input.outbox.put({ ...input.pending, state: "fenced" });
        current();
        return {
          opening: input.pending.reservation,
          transport: new EncryptedSupportTransport({
            ...input,
            profile,
            identity: () => {
              current();
              return {
                account: input.account,
                revision: start,
                certificate: record.certificate,
                keys: input.keys,
              };
            },
          }),
        };
      }
    }
    // A restored grant or role cycle may invalidate the old author
    // certificate. Reapprove this device against current native authority,
    // without changing or resending the saved envelope.
    const refreshed = await connectCustomerCase({
      ...input,
      pending: undefined,
      existing: caseOf(record.scope),
      issueCertificate: async (request) => {
        const certificate = await input.issueCertificate(request);
        if (certificate.actor !== record.certificate.actor)
          throw new EncryptionProtocolError("encryption-integrity");
        return certificate;
      },
    });
    current();
    return {
      transport: refreshed.transport,
      ...(input.pending.reservation
        ? { opening: input.pending.reservation }
        : {}),
    };
  }
  if (!input.existing && input.kind !== "member")
    throw new EncryptionProtocolError();
  const prepared = input.existing
    ? await input.request<{
        mode: string;
        case: E2eeCase;
        profile: EncryptionProfile;
        authorizationGrant?: string;
      }>(
        `/conversations/${input.existing.conversation}/encryption/${input.existing.caseSeq}`,
      )
    : await input.request<{
        mode: string;
        case: E2eeCase;
        profile: EncryptionProfile;
        authorizationGrant?: string;
        reservation?: string;
      }>("/conversations/encryption/prepare", {
        clientId: input.openingId ?? crypto.randomUUID(),
        ...(input.initialAiMode ? {initialAiMode: input.initialAiMode} : {}),
      });
  current();
  if (prepared.mode !== "encrypted")
    throw new EncryptionProtocolError("encryption-scope-changed");
  const profile = await verifyEncryptionProfile(
      prepared.profile,
      input.pinnedRoot,
    ),
    ref = parseCase(prepared.case);
  if (
    profile.workspace !== input.profile.workspace ||
    profile.environment !== input.profile.environment ||
    profile.custody !== input.profile.custody ||
    profile.clientOrigin !== input.profile.clientOrigin ||
    profile.serviceOrigin !== input.profile.serviceOrigin ||
    ref.workspace !== profile.workspace ||
    ref.environment !== profile.environment ||
    (input.existing &&
      JSON.stringify(ref) !== JSON.stringify(caseOf(input.existing)))
  )
    throw new EncryptionProtocolError("encryption-integrity");
  const encryptionKey = await exportPublic(input.keys.encryption.publicKey),
    signingKey = await exportPublic(input.keys.signing.publicKey);
  const certificate = await input.issueCertificate({
    case: ref,
    kind: input.kind,
    encryptionKey,
    signingKey,
    ...(prepared.authorizationGrant !== undefined
      ? { authorizationGrant: prepared.authorizationGrant }
      : {}),
  });
  current();
  await verifyCertificate(profile, certificate, Date.now());
  if (
    certificate.encryptionKey !== encryptionKey ||
    certificate.signingKey !== signingKey ||
    certificate.kind !== input.kind ||
    certificate.authorizationGrant !== prepared.authorizationGrant ||
    JSON.stringify(caseOf(certificate)) !== JSON.stringify(ref)
  )
    throw new EncryptionProtocolError("encryption-integrity");
  const proof = await sign(
    input.keys.signing.privateKey,
    enrollmentProofBytes(certificate, input.principal),
  );
  current();
  await input.request(
    `/conversations/${ref.conversation}/encryption/${ref.caseSeq}/enroll`,
    { certificate, proof },
  );
  current();
  const opening = !input.existing
    ? opaqueId((prepared as { reservation?: string }).reservation)
    : undefined;
  return {
    transport: new EncryptedSupportTransport({
      ...input,
      profile,
      identity: () => {
        current();
        return {
          account: input.account,
          revision: start,
          certificate,
          keys: input.keys,
        };
      },
    }),
    ...(opening ? { opening } : {}),
  };
}
