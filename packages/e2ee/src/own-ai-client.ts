/** Approved endpoint for Templ's own AI. This bundle is never loaded by the
 * message relay, another customer or their hosted AI instance. */
import { connectCustomerCase, type EncryptedOutboxEntry, type EncryptedSupportTransport } from "./transport";
import { exportPublic, type EndpointKeys } from "./client";
import { sign } from "./endpoint-crypto";
import { ownEnrollmentBytes, type OwnEnrollmentChallenge } from "./own-support-authority";
import { ownAiVerifierBytes, type OwnAiContext, type OwnAiDraftVerification } from "./own-ai-protocol";
import { verifyEncryptionProfile, verifySignature, sha256, encryptedRecordDigest } from "./verify";
import { base64url, decoded, utf8, object, parseCase, OWN_SUPPORT_ENDPOINT, OWN_SUPPORT_AI_PRINCIPAL,
  type E2eeCase, type OwnSupportEncryptionProfile, type EndpointCertificate, type OwnAiValidation } from "./protocol";
import type { StoredEncryptedRecord } from "./relay";
import { stripCitationMarkers } from "@templ/chat/support-citations";

type Sealed = {v: 1; nonce: string; ciphertext: string};
type Turn = {
  v: 1; case: E2eeCase; stateDigest: string; latestSequence: number; latestDigest: string;
  stage: "working" | "prepared" | "done" | "retired"; createdAt: number; draftId: string; publicId: string;
  memberAt: number | null;
  content?: {text: string; replyTo: string; verification: OwnAiDraftVerification};
  outbox: Record<string, EncryptedOutboxEntry>;
  draft?: OwnAiValidation["draft"];
};
type Request = <T>(path: string, body?: object) => Promise<T>;
export type OwnAiDecision = {text: string; sent: string; provenance: unknown;
  disposition: OwnAiValidation["disposition"]; handoff?: OwnAiValidation["handoff"]; summary?: string};
const refuse = (): never => {throw Object.assign(new Error("Encrypted AI support is unavailable."), {status: 409, reason: "encrypted-ai-unavailable"});};
const base = (ref: E2eeCase) => `/conversations/${ref.conversation}/encryption/${ref.caseSeq}`;
const aad = (ref: E2eeCase, root: string) => utf8(JSON.stringify(["templ:own-support:ai-state:v1", root, ref]));
async function keyPair(raw: unknown, name: "ECDH" | "ECDSA"): Promise<CryptoKeyPair> {
  const value = object(raw, ["publicKey", "privateKey"]);
  const algorithm = {name, namedCurve: "P-256"};
  const publicKey = await crypto.subtle.importKey("raw", Uint8Array.from(decoded(String(value.publicKey), 65)), algorithm, true, name === "ECDH" ? [] : ["verify"]);
  const privateKey = await crypto.subtle.importKey("pkcs8", Uint8Array.from(decoded(String(value.privateKey), 100, 1024)), algorithm, false, name === "ECDH" ? ["deriveBits"] : ["sign"]);
  if (name === "ECDSA") {
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    if (!await verifySignature(String(value.publicKey), await sign(privateKey, challenge), challenge)) return refuse();
  } else {
    // An ECDH round trip proves the private/public halves match.
    const peer = await crypto.subtle.generateKey(algorithm, false, ["deriveBits"]);
    const [one, two] = await Promise.all([
      crypto.subtle.deriveBits({name, public: peer.publicKey}, privateKey, 256),
      crypto.subtle.deriveBits({name, public: publicKey}, peer.privateKey, 256),
    ]);
    if (base64url(new Uint8Array(one)) !== base64url(new Uint8Array(two))) return refuse();
    new Uint8Array(one).fill(0); new Uint8Array(two).fill(0);
  }
  return {publicKey, privateKey};
}
export async function createOwnAiClient(input: {
  workspace: string; principal: string; secrets: string; request: Request;
  read: (ref: E2eeCase) => Promise<unknown>;
  write: (ref: E2eeCase, value: Sealed | null, retired?: boolean) => Promise<void>;
  listPending?: () => E2eeCase[];
  listRetired?: () => E2eeCase[];
  /** Atomically retain the handled member time and remove the transient copy. */
  finishRetired?: (ref: E2eeCase, sequence: number, memberAt: number | null) => Promise<void>;
  /** The native endpoint paces private drafts and public messages alike. */
  beforeSend?: () => Promise<void>;
  /** This callback runs the existing source/grounding verifier using the
   * supplied snapshot. It must not send a plaintext search to the relay. */
  decide: (context: OwnAiContext, messages: {role: "member" | "team"; text: string}[],
    shared: unknown) => Promise<OwnAiDecision>;
}) {
  if (input.workspace !== OWN_SUPPORT_ENDPOINT.workspace || input.principal !== OWN_SUPPORT_AI_PRINCIPAL ||
      input.secrets.length > 12000) return refuse();
  const config = object(JSON.parse(input.secrets), ["v", "workspace", "principal", "rootKey", "encryption", "signing", "verifier", "stateKey"]);
  if (config.v !== 1 || config.workspace !== input.workspace || config.principal !== input.principal) return refuse();
  const pinnedRoot = String(config.rootKey);
  decoded(pinnedRoot, 65);
  const keys: EndpointKeys = {encryption: await keyPair(config.encryption, "ECDH"), signing: await keyPair(config.signing, "ECDSA")};
  const verifier = await keyPair(config.verifier, "ECDSA");
  if (await exportPublic(verifier.publicKey) === await exportPublic(keys.signing.publicKey)) return refuse();
  const rawState = decoded(String(config.stateKey), 32);
  const stateKey = await crypto.subtle.importKey("raw", Uint8Array.from(rawState), "AES-GCM", false, ["encrypt", "decrypt"]);
  rawState.fill(0);
  const beforeSend = input.beforeSend ?? (() => new Promise<void>(resolve => setTimeout(resolve, 5_000)));
  const pending = (): never => {throw Object.assign(new Error("Encrypted reply outcome is pending."), {status: 503});};
  async function read(ref: E2eeCase): Promise<Turn | undefined> {
    const raw = await input.read(ref);
    if (raw === undefined || raw === null) return undefined;
    const sealed = object(raw, ["v", "nonce", "ciphertext"]);
    if (sealed.v !== 1) return refuse();
    let bytes: Uint8Array | undefined;
    try {
      bytes = new Uint8Array(await crypto.subtle.decrypt({name: "AES-GCM", iv: Uint8Array.from(decoded(String(sealed.nonce), 12)),
        additionalData: Uint8Array.from(aad(ref, pinnedRoot))}, stateKey, Uint8Array.from(decoded(String(sealed.ciphertext), 17, 180000))));
      const turn = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes)) as Turn;
      if (turn.v !== 1 || JSON.stringify(parseCase(turn.case)) !== JSON.stringify(ref) ||
          !["working", "prepared", "done", "retired"].includes(turn.stage) || !/^[a-f0-9]{64}$/.test(turn.stateDigest) ||
          !turn.outbox || Object.keys(turn.outbox).length > 2) return refuse();
      return turn;
    } catch {return refuse();} finally {bytes?.fill(0);}
  }
  async function save(turn: Turn) {
    const bytes = utf8(JSON.stringify(turn));
    if (bytes.length > 170000) return refuse();
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    try {
      const ciphertext = new Uint8Array(await crypto.subtle.encrypt({name: "AES-GCM", iv: nonce,
        additionalData: Uint8Array.from(aad(turn.case, pinnedRoot))}, stateKey, bytes));
      await input.write(turn.case, {v: 1, nonce: base64url(nonce), ciphertext: base64url(ciphertext)}, turn.stage === "retired");
    } finally {bytes.fill(0);}
  }
  let retiredCursor = 0;
  async function sweep(except?: E2eeCase) {
    // Withdrawn cases leave the live queue. Retire their claimed inference
    // separately, keeping exact uncertain ciphertext envelopes for resolution.
    for (const other of (input.listPending?.() ?? []).slice(0, 4)) {
      if (JSON.stringify(other) === JSON.stringify(except)) continue;
      try {await input.request(`${base(other)}/ai-context`);}
      catch (error) {
        if (![403, 404, 409, 410].includes(Number((error as {status?: number})?.status))) continue;
        const prior = await read(other);
        if (!prior) continue;
        prior.stage = "retired"; delete prior.content;
        await save(prior);
      }
    }
    if (!input.finishRetired) return;
    const all = input.listRetired?.() ?? [];
    for (let count = 0; count < Math.min(4, all.length); count++) {
      const ref = parseCase(all[(retiredCursor + count) % all.length]);
      if (ref.workspace !== input.workspace || ref.environment !== "production") return refuse();
      const prior = await read(ref);
      if (!prior || prior.stage !== "retired") continue;
      try {
        for (const entry of Object.values(prior.outbox)) {
          if (entry.state === "accepted" || entry.state === "fenced") continue;
          const digest = await encryptedRecordDigest(entry.record);
          const result = await input.request<{state: "accepted" | "fenced"; id: string; digest: string}>("/conversations/encryption/settle-ai",
            {encryptedRecord: entry.record, validationReceipt: entry.receipt});
          if (!["accepted", "fenced"].includes(result.state) || result.id !== entry.record.id || result.digest !== digest) return refuse();
          prior.outbox[entry.record.id] = {...entry, state: result.state};
          await save(prior);
        }
        await input.finishRetired(ref, prior.latestSequence, prior.memberAt);
      } catch {
        // An error never proves a terminal outcome. Keep this encrypted copy
        // and continue the bounded sweep so one failure cannot starve others.
      }
    }
    retiredCursor = all.length ? (retiredCursor + 4) % all.length : 0;
  }
  async function work(raw: E2eeCase, memberAt: number | null = null) {
    const ref = parseCase(raw);
    if (ref.workspace !== input.workspace || ref.environment !== "production") return refuse();
    await sweep(ref);
    let turn = await read(ref);
    const descriptor = await input.request<{mode: string; profile: OwnSupportEncryptionProfile}>(base(ref));
    const profile = await verifyEncryptionProfile(descriptor.profile, pinnedRoot);
    if (descriptor.mode !== "encrypted" || profile.custody !== "templ-own-support") return refuse();
    const callKeys = <T>(operation: string, value: unknown) => input.request<T>(`/keys/team/${operation}`, {case: ref, value});
    let publicDraft: OwnAiValidation["draft"] = turn?.draft;
    const connection = await connectCustomerCase({
      profile, pinnedRoot, principal: input.principal, account: input.principal, revision: () => 1,
      keys, kind: "ai", existing: ref, request: input.request,
      issueCertificate: async value => {
        const challenge = await callKeys<OwnEnrollmentChallenge>("challenge", {encryptionKey: value.encryptionKey, signingKey: value.signingKey});
        if (challenge.kind !== "ai" || challenge.principal !== input.principal ||
            challenge.authorizationGrant !== value.authorizationGrant || JSON.stringify(parseCase(challenge.case)) !== JSON.stringify(ref)) return refuse();
        return callKeys<EndpointCertificate>("enroll", {challenge: challenge.id, possession: await sign(keys.signing.privateKey, ownEnrollmentBytes(challenge))});
      },
      outbox: {
        get: async id => turn?.outbox[id],
        put: async entry => {
          if (!turn || ![turn.draftId, turn.publicId].includes(entry.record.id)) return refuse();
          turn.outbox[entry.record.id] = entry; await save(turn);
        },
      },
      validate: record => callKeys("validate", {record, ...(record.purpose === "team-message" ? {draft: publicDraft} : {})}),
      recover: async (row, identity) => callKeys("recover", {certificate: identity.certificate,
        sequence: row.sequence, recordDigest: await encryptedRecordDigest(row.record), audience: row.record.scope.audience}),
    });
    const transport = connection.transport;
    if (turn && turn.stage === "done") return {state: "done" as const, sequence: turn.latestSequence, memberAt: turn.memberAt};
    const readContext = async () => {
      const context = await input.request<OwnAiContext>(`${base(ref)}/ai-context`);
      const {stateDigest, ...unsigned} = context;
      if (context.v !== 1 || JSON.stringify(context.case) !== JSON.stringify(ref) ||
          stateDigest !== await sha256(utf8(JSON.stringify(unsigned)))) return refuse();
      return context;
    };
    let interrupted = turn?.stage === "retired";
    // Resolve any exact saved envelope before looking at newer authority.
    // A lost acknowledgement never causes a second model call or record ID.
    if (turn) for (const entry of Object.values(turn.outbox)) {
      if (entry.state === "accepted" || entry.state === "fenced") continue;
      if (entry.receipt.expiresAt > Date.now() && !interrupted) {
        await beforeSend();
        const result = await transport.retry(entry.record.id);
        if (result.state === "accepted") continue;
        const outcome = await input.request<{state: string}>(`${base(ref)}/outcome?id=${entry.record.id}`);
        if (outcome.state === "accepted") {
          if (await transport.fence(entry.record.id) !== "accepted") return refuse();
          continue;
        }
        // A retryable failure proves neither rejection nor changed authority.
        // Keep the original envelope and durable inference claim intact.
        if ((await readContext()).stateDigest === turn.stateDigest) return pending();
      }
      if (await transport.fence(entry.record.id) !== "accepted") interrupted = true;
    }
    if (turn?.content && turn.outbox[turn.draftId]?.state === "accepted" &&
        (!['answer', 'clarify', 'greeting'].includes(turn.content.verification.disposition) || turn.outbox[turn.publicId]?.state === "accepted")) {
      turn.stage = "done"; await save(turn);
      return {state: "done" as const, sequence: turn.latestSequence, memberAt: turn.memberAt};
    }
    const context = await readContext(), {stateDigest} = context;
    if (!context.latest.member) {
      if (turn) {turn.stage = "done"; await save(turn);}
      return {state: "done" as const, sequence: turn?.latestSequence ?? context.latest.sequence, memberAt: turn?.memberAt ?? memberAt};
    }
    if (turn && (interrupted || turn.stateDigest !== stateDigest ||
        turn.outbox[turn.draftId]?.receipt.expiresAt <= Date.now())) {
      // A newer member message must get its own turn. For the same message,
      // leave the encrypted draft for the team and hand off without inference
      // or refreshing an expired answer approval.
      if (context.latest.sequence === turn.latestSequence && context.latest.recordDigest === turn.latestDigest)
        await input.request(`${base(ref)}/ai-handoff`, {stateDigest, latestSequence: turn.latestSequence, latestDigest: turn.latestDigest});
      turn.stage = "done"; await save(turn);
      return {state: "done" as const, sequence: turn.latestSequence, memberAt: turn.memberAt};
    }
    if (!turn) {
      const messages: {role: "member" | "team"; text: string}[] = [];
      let shared: unknown = null, after = 0, latest: StoredEncryptedRecord | undefined;
      for (;;) {
        const page = await transport.history(after, "conversation");
        for (const item of page.rows) {
          const content = object(item.content, ["text"], ["replyTo", "context", "contextConsent"]);
          if (typeof content.text !== "string" || messages.length >= 200) return refuse();
          messages.push({role: item.row.record.purpose === "member-message" ? "member" : "team", text: content.text});
          if (item.row.record.purpose === "member-message" && content.context !== undefined) shared = content.context;
          latest = item.row;
        }
        if (page.nextAfter === null) break;
        if (page.nextAfter <= after) return refuse(); after = page.nextAfter;
      }
      if (!latest || latest.sequence !== context.latest.sequence || await encryptedRecordDigest(latest.record) !== context.latest.recordDigest) return refuse();
      turn = {v: 1, case: ref, stateDigest, latestSequence: context.latest.sequence, latestDigest: context.latest.recordDigest,
        stage: "working", createdAt: Date.now(), memberAt, draftId: crypto.randomUUID(), publicId: crypto.randomUUID(), outbox: {}};
      // The durable claim precedes every provider call. A process loss here
      // produces a private handoff on restart, never another inference.
      await save(turn);
      const decision = await input.decide(context, messages, shared);
      await prepare(turn, profile, decision);
    } else if (turn.stage === "working") {
      await prepare(turn, profile, {text: "The AI response was interrupted. A person needs to review this request.",
        sent: "The AI response was interrupted. A person needs to review this request.", provenance: null,
        disposition: "handoff", handoff: "unsure"});
    }
    if (!turn.content) return refuse();
    if (!turn.outbox[turn.draftId]) await send(transport, turn.draftId, {
      content: turn.content, purpose: "draft", audience: "ai-draft", id: turn.draftId,
    });
    if (turn.outbox[turn.draftId]?.state !== "accepted") return refuse();
    if (["answer", "clarify", "greeting"].includes(turn.content.verification.disposition)) {
      if (!publicDraft) {
        const result = await input.request<{state: string; sequence?: number}>(`${base(ref)}/outcome?id=${turn.draftId}`);
        if (result.state !== "accepted" || !Number.isSafeInteger(result.sequence) || result.sequence! < 1) return refuse();
        const page = await input.request<{records: StoredEncryptedRecord[]}>(`${base(ref)}/history?audience=ai-draft&after=${result.sequence! - 1}&limit=1`);
        const accepted = page.records?.[0];
        if (page.records?.length !== 1 || accepted.sequence !== result.sequence || accepted.record.id !== turn.draftId ||
            await encryptedRecordDigest(accepted.record) !== await encryptedRecordDigest(turn.outbox[turn.draftId].record)) return refuse();
        publicDraft = {sequence: accepted.sequence, recordDigest: await encryptedRecordDigest(accepted.record)};
        turn.draft = publicDraft; await save(turn);
      }
      if (!turn.outbox[turn.publicId]) await send(transport, turn.publicId, {
        content: {text: turn.content.text, replyTo: String(turn.latestSequence)}, purpose: "team-message", audience: "conversation", id: turn.publicId,
      });
      if (turn.outbox[turn.publicId]?.state !== "accepted") return refuse();
    }
    turn.stage = "done"; await save(turn);
    return {state: "done" as const, sequence: turn.latestSequence, memberAt: turn.memberAt};
  }
  async function prepare(turn: Turn, profile: OwnSupportEncryptionProfile, decision: OwnAiDecision) {
    if (stripCitationMarkers(decision.sent).text !== decision.text) return refuse();
    const verification: OwnAiDraftVerification = {v: 1, stateDigest: turn.stateDigest, sent: decision.sent,
      provenance: decision.provenance, disposition: decision.disposition,
      ...(decision.handoff ? {handoff: decision.handoff} : {}), ...(decision.summary ? {summary: decision.summary} : {}), proof: ""};
    const content = {text: decision.text, replyTo: String(turn.latestSequence), verification};
    verification.proof = await sign(verifier.privateKey, ownAiVerifierBytes(profile,
      {scope: turn.case, id: turn.draftId}, content));
    turn.content = content; turn.stage = "prepared"; await save(turn);
  }
  async function send(transport: EncryptedSupportTransport, id: string, value: Parameters<EncryptedSupportTransport["send"]>[0]) {
    await beforeSend();
    const result = await transport.send(value);
    if (result.state !== "accepted") return pending();
    return id;
  }
  return {work, sweep, clear: (ref: E2eeCase) => input.write(parseCase(ref), null)};
}
