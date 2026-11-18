/** Runs only at Templ's separately deployed support endpoint. It has no
 * customer-workspace mode and never accepts a native resume token as recovery. */
import { verifyMessage } from "viem";
import { issueCustomerCertificate } from "./customer";
import {
  EncryptionProtocolError,
  OWN_SUPPORT_ENDPOINT,
  OWN_SUPPORT_AI_PRINCIPAL,
  caseOf,
  decoded,
  object,
  opaqueId,
  parseCase,
  utf8,
  type E2eeCase,
  type EndpointCertificate,
  type OwnSupportEncryptionProfile,
} from "./protocol";
import {
  sha256,
  verifyCertificate,
  verifyEncryptionProfile,
  verifySignature,
} from "./verify";

/** Admission margin for a retained history read; existing signed expiries never move. */
export const OWN_SUPPORT_READ_WINDOW_MS = 15 * 60_000;

export type OwnNativeAuthority = {
  case: E2eeCase;
  principal: string;
  kind: "member" | "team" | "ai";
  authorizationGrant: string;
  /** True only before the first native case message has been accepted. */
  provisional: boolean;
  /** Currently proven native wallet aliases. A separate signed challenge
   * establishes first team-device approval; a session alone is insufficient. */
  wallets: readonly `0x${string}`[];
};
export type OwnDeviceKeys = { encryptionKey: string; signingKey: string };
type Device = OwnDeviceKeys & {
  v: 1;
  id: string;
  actor: string;
  kind: "member" | "team" | "ai";
  principal: string;
  revoked: boolean;
  approvedAt: number;
  approvedWallet?: `0x${string}`;
};
export type OwnEnrollmentChallenge = {
  v: 1;
  id: string;
  case: E2eeCase;
  principal: string;
  kind: "member" | "team" | "ai";
  authorizationGrant: string;
  device: OwnDeviceKeys;
  expiresAt: number;
};
export interface OwnAuthorityStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
}
export class OwnDeviceApprovalRequired extends Error {
  constructor(readonly kind: "member" | "team") {
    super(kind === "team" ? "Approve this device with your team wallet." :
      "Approve this device from one that can already read the chat.");
  }
}
const refused = (): never => {
  throw new EncryptionProtocolError("encryption-integrity");
};
const scopeKey = (c: E2eeCase) => `${c.conversation}:${c.caseSeq}`;
const fingerprint = (keys: OwnDeviceKeys) =>
  sha256(
    utf8(
      JSON.stringify([
        "templ:own-support:device:v1",
        keys.encryptionKey,
        keys.signingKey,
      ]),
    ),
  );
const deviceKey = async (keys: OwnDeviceKeys) =>
  `device:${await fingerprint(keys)}`;
const sameCase = (a: E2eeCase, b: E2eeCase) =>
  JSON.stringify(caseOf(a)) === JSON.stringify(caseOf(b));

/** Public pairing material. It never contains a session, credential or key. */
export function parseOwnEnrollmentChallenge(value: unknown, now = Date.now()): OwnEnrollmentChallenge {
  const raw = object(value, ["v", "id", "case", "principal", "kind", "authorizationGrant", "device", "expiresAt"]);
  const scope = parseCase(raw.case), device = object(raw.device, ["encryptionKey", "signingKey"]);
  if (raw.v !== 1 || scope.environment !== OWN_SUPPORT_ENDPOINT.environment ||
      scope.workspace !== OWN_SUPPORT_ENDPOINT.workspace ||
      typeof raw.principal !== "string" || !/^[\w:-]{1,128}$/.test(raw.principal) ||
      !["member", "team"].includes(String(raw.kind)) ||
      typeof raw.authorizationGrant !== "string" || !/^[a-f0-9]{64}$/.test(raw.authorizationGrant) ||
      typeof raw.expiresAt !== "number" || !Number.isSafeInteger(raw.expiresAt) ||
      raw.expiresAt <= now || raw.expiresAt > now + 5 * 60_000 ||
      typeof device.encryptionKey !== "string" || typeof device.signingKey !== "string") return refused();
  opaqueId(raw.id);
  decoded(device.encryptionKey, 65); decoded(device.signingKey, 65);
  return raw as OwnEnrollmentChallenge;
}

export function ownEnrollmentBytes(
  challenge: OwnEnrollmentChallenge,
): Uint8Array {
  return utf8(
    JSON.stringify([
      "templ:own-support:enroll:v1",
      OWN_SUPPORT_ENDPOINT.serviceOrigin,
      challenge.v,
      challenge.id,
      challenge.case.environment,
      challenge.case.workspace,
      challenge.case.conversation,
      challenge.case.caseSeq,
      challenge.principal,
      challenge.kind,
      challenge.authorizationGrant,
      challenge.device.encryptionKey,
      challenge.device.signingKey,
      challenge.expiresAt,
    ]),
  );
}
export async function ownWalletApprovalText(challenge: OwnEnrollmentChallenge) {
  return [
    "Approve this device for Templ encrypted support.",
    `Service: ${OWN_SUPPORT_ENDPOINT.serviceOrigin}`,
    `Workspace: ${challenge.case.workspace}`,
    `Device request: ${challenge.id}`,
    `Expires: ${new Date(challenge.expiresAt).toISOString()}`,
    `Scope: ${await sha256(ownEnrollmentBytes(challenge))}`,
    "This approves a support device. It does not send a transaction.",
  ].join("\n");
}
export async function ownDeviceApprovalBytes(
  challenge: OwnEnrollmentChallenge,
) {
  return utf8(
    JSON.stringify([
      "templ:own-support:approve-device:v1",
      OWN_SUPPORT_ENDPOINT.serviceOrigin,
      await sha256(ownEnrollmentBytes(challenge)),
    ]),
  );
}
export async function ownDeviceRevocationBytes(
  challenge: OwnEnrollmentChallenge,
  target: OwnDeviceKeys,
) {
  return utf8(
    JSON.stringify([
      "templ:own-support:revoke-device:v1",
      OWN_SUPPORT_ENDPOINT.serviceOrigin,
      await sha256(ownEnrollmentBytes(challenge)),
      await fingerprint(target),
    ]),
  );
}

/** Each method runs inside the endpoint's storage transaction. Native
 * authorization is freshly read by the server adapter before entering it. */
export class OwnSupportAuthority {
  constructor(
    private storage: OwnAuthorityStorage,
    private profile: OwnSupportEncryptionProfile,
    private rootSigningKey: CryptoKey,
    /** Reviewed deployment pins, never caller-supplied enrollment fields. */
    private approvedAi?: OwnDeviceKeys,
  ) {}
  private async current(native: OwnNativeAuthority) {
    const profile = await verifyEncryptionProfile(
      this.profile,
      this.profile.rootKey,
    );
    if (
      profile.custody !== "templ-own-support" ||
      native.case.workspace !== OWN_SUPPORT_ENDPOINT.workspace ||
      native.case.environment !== OWN_SUPPORT_ENDPOINT.environment ||
      !/^[a-f0-9]{64}$/.test(native.authorizationGrant) ||
      !["member", "team", "ai"].includes(native.kind) ||
      !native.principal
    )
      return refused();
    parseCase(native.case);
    if (native.kind === "ai" && native.principal !== OWN_SUPPORT_AI_PRINCIPAL) return refused();
  }
  /** Native delivery still checks current case access for every recipient.
   * This independent check enforces the endpoint's own device approvals. */
  async approved(
    certificate: EndpointCertificate,
    native?: OwnNativeAuthority,
    now = Date.now(),
  ) {
    await verifyCertificate(this.profile, certificate, now);
    if (native) await this.current(native);
    if (certificate.kind === "ai" && (!this.approvedAi ||
        certificate.encryptionKey !== this.approvedAi.encryptionKey ||
        certificate.signingKey !== this.approvedAi.signingKey)) return false;
    const device = await this.storage.get<Device>(await deviceKey(certificate));
    if (
      !device ||
      device.revoked ||
      device.id !== certificate.grant ||
      device.actor !== certificate.actor ||
      device.kind !== certificate.kind ||
      (native &&
        (device.principal !== native.principal ||
          native.kind !== certificate.kind ||
          native.authorizationGrant !== certificate.authorizationGrant ||
          !sameCase(native.case, certificate)))
    )
      return false;
    if (
      certificate.kind === "member" &&
      (await this.storage.get(`member:${scopeKey(certificate)}`)) !==
        certificate.actor
    )
      return false;
    return true;
  }
  /** Reserves control capacity for an already approved identity/device pair.
   * This does not approve enrollment or replace key possession. */
  async knownDevice(native: OwnNativeAuthority, keys: OwnDeviceKeys) {
    await this.current(native);
    const device = await this.storage.get<Device>(await deviceKey(keys));
    return Boolean(
      device &&
      !device.revoked &&
      device.kind === native.kind &&
      (device.principal === native.principal ||
        (native.kind === "member" &&
          (await this.storage.get(`member:${scopeKey(native.case)}`)) ===
            device.actor)),
    );
  }
  async knownEnrollment(
    native: OwnNativeAuthority,
    challengeId: string,
    now = Date.now(),
  ) {
    await this.current(native);
    const challenge = await this.storage.get<OwnEnrollmentChallenge>(
      `challenge:${await sha256(utf8(native.principal))}`,
    );
    return Boolean(
      challenge &&
      challenge.id === challengeId &&
      challenge.expiresAt > now &&
      challenge.principal === native.principal &&
      challenge.kind === native.kind &&
      challenge.authorizationGrant === native.authorizationGrant &&
      sameCase(challenge.case, native.case) &&
      (await this.knownDevice(native, challenge.device)),
    );
  }
  async challenge(
    native: OwnNativeAuthority,
    value: unknown,
    now = Date.now(),
  ) {
    await this.current(native);
    const raw = object(value, ["encryptionKey", "signingKey"]);
    const device: OwnDeviceKeys = {
      encryptionKey: String(raw.encryptionKey),
      signingKey: String(raw.signingKey),
    };
    decoded(device.encryptionKey, 65);
    decoded(device.signingKey, 65);
    // Check valid curve points before retaining a challenge.
    await Promise.all([
      crypto.subtle.importKey(
        "raw",
        decoded(device.encryptionKey, 65),
        { name: "ECDH", namedCurve: "P-256" },
        false,
        [],
      ),
      crypto.subtle.importKey(
        "raw",
        decoded(device.signingKey, 65),
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      ),
    ]);
    const bucket = Math.floor(now / 60_000);
    const rateKey = `enroll-rate:${await sha256(utf8(native.principal))}`;
    const rate = await this.storage.get<{ bucket: number; count: number }>(
      rateKey,
    );
    const count = rate?.bucket === bucket ? rate.count + 1 : 1;
    if (count > 10) return refused();
    await this.storage.put(rateKey, { bucket, count });
    const challenge: OwnEnrollmentChallenge = {
      v: 1,
      id: crypto.randomUUID(),
      case: caseOf(native.case),
      principal: native.principal,
      kind: native.kind,
      authorizationGrant: native.authorizationGrant,
      device,
      expiresAt: now + 5 * 60_000,
    };
    // One outstanding challenge per native identity bounds idle metadata.
    const key = `challenge:${await sha256(utf8(native.principal))}`;
    await this.storage.put(key, challenge);
    return challenge;
  }
  async enroll(
    native: OwnNativeAuthority,
    input: {
      challenge: string;
      possession: string;
      walletApproval?: { address: `0x${string}`; signature: `0x${string}` };
      deviceApproval?: { device: OwnDeviceKeys; signature: string };
    },
    now = Date.now(),
  ): Promise<EndpointCertificate> {
    await this.current(native);
    const challengeKey = `challenge:${await sha256(utf8(native.principal))}`;
    const challenge =
      await this.storage.get<OwnEnrollmentChallenge>(challengeKey);
    if (
      !challenge ||
      challenge.id !== opaqueId(input.challenge) ||
      challenge.expiresAt <= now ||
      challenge.principal !== native.principal ||
      challenge.kind !== native.kind ||
      !sameCase(challenge.case, native.case) ||
      challenge.authorizationGrant !== native.authorizationGrant ||
      !(await verifySignature(
        challenge.device.signingKey,
        input.possession,
        ownEnrollmentBytes(challenge),
      ))
    )
      return refused();
    const key = await deviceKey(challenge.device);
    if (native.kind === "ai" && (!this.approvedAi ||
        challenge.device.encryptionKey !== this.approvedAi.encryptionKey ||
        challenge.device.signingKey !== this.approvedAi.signingKey ||
        input.deviceApproval || input.walletApproval)) return refused();
    let device = await this.storage.get<Device>(key);
    const binding = `member:${scopeKey(native.case)}`;
    const memberActor =
      native.kind === "member"
        ? await this.storage.get<string>(binding)
        : undefined;
    const identityKey = `principal:${await sha256(utf8(native.principal))}:${native.kind}`;
    const identityKnown = Boolean(await this.storage.get(identityKey));
    const walletApproved = async (expected?: `0x${string}`) => {
      const approval = input.walletApproval;
      return Boolean(
        approval &&
        (!expected ||
          approval.address.toLowerCase() === expected.toLowerCase()) &&
        native.wallets.some(
          (wallet) => wallet.toLowerCase() === approval.address.toLowerCase(),
        ) &&
        (await verifyMessage({
          address: approval.address,
          message: await ownWalletApprovalText(challenge),
          signature: approval.signature,
        })),
      );
    };
    if (device) {
      if (device.revoked || device.kind !== native.kind) return refused();
      if (device.principal !== native.principal && native.kind === "team" && device.approvedWallet && !input.walletApproval)
        throw new OwnDeviceApprovalRequired("team");
      if (
        device.principal !== native.principal &&
        !(native.kind === "member" && memberActor === device.actor) &&
        !(
          native.kind === "team" &&
          device.approvedWallet &&
          (await walletApproved(device.approvedWallet))
        )
      )
        return refused();
    }
    if (!device) {
      let actor: string | undefined;
      let approvedWallet: `0x${string}` | undefined;
      if (native.kind === "ai") {
        // Deployment approval and fresh key possession are both mandatory.
        // A native bot session cannot enroll replacement keys.
        actor = await this.storage.get<string>("own-ai-actor:v1");
      } else if (input.deviceApproval) {
        const approved = await this.storage.get<Device>(
          await deviceKey(input.deviceApproval.device),
        );
        if (
          !approved ||
          approved.revoked ||
          approved.kind !== native.kind ||
          (approved.principal !== native.principal &&
            memberActor !== approved.actor) ||
          !(await verifySignature(
            approved.signingKey,
            input.deviceApproval.signature,
            await ownDeviceApprovalBytes(challenge),
          ))
        )
          return refused();
        actor = approved.actor;
        approvedWallet = approved.approvedWallet;
      } else if (native.kind === "team") {
        if (!input.walletApproval) throw new OwnDeviceApprovalRequired("team");
        if (!(await walletApproved())) return refused();
        approvedWallet = input.walletApproval!.address;
      } else if (!native.provisional || memberActor || identityKnown) {
        // Native guest credentials, login recovery and email resume links do
        // not replace approval from a device already trusted by this service.
        throw new OwnDeviceApprovalRequired("member");
      }
      const walletKey = approvedWallet
        ? `team-wallet:${approvedWallet.toLowerCase()}`
        : undefined;
      const walletActor = walletKey
        ? await this.storage.get<string>(walletKey)
        : undefined;
      if (walletActor && actor && walletActor !== actor) return refused();
      actor ??=
        walletActor ??
        [...crypto.getRandomValues(new Uint8Array(32))]
          .map((v) => v.toString(16).padStart(2, "0"))
          .join("");
      const indexKey = `devices:${actor}`;
      const devices = (await this.storage.get<string[]>(indexKey)) ?? [];
      if (devices.length >= 31) return refused();
      device = {
        v: 1,
        id: crypto.randomUUID(),
        actor,
        kind: native.kind,
        principal: native.principal,
        ...challenge.device,
        revoked: false,
        approvedAt: now,
        ...(approvedWallet ? { approvedWallet } : {}),
      };
      await this.storage.put(key, device);
      await this.storage.put(indexKey, [...devices, key]);
      if (walletKey) await this.storage.put(walletKey, actor);
      if (native.kind === "ai") await this.storage.put("own-ai-actor:v1", actor);
    }
    // A native account can inherit several guest cases. Keep each case's
    // independent actor; a native identity link never merges their keys.
    await this.storage.put(identityKey, true);
    if (device.principal !== native.principal) {
      device.principal = native.principal;
      await this.storage.put(key, device);
    }
    if (native.kind === "member") {
      if (memberActor && memberActor !== device.actor) return refused();
      await this.storage.put(binding, device.actor);
    }
    // No long-lived service bearer is produced. Every renewal proves the
    // device key and obtains the current native grant again.
    await this.storage.delete(challengeKey);
    const grant = device.id;
    // Fresh possession and current native authority are still required on
    // every connection. Reusing their certificate avoids changing the native
    // roster (and invalidating an exact pending envelope) on a reconnect.
    const certificateKey = `certificate:${await fingerprint(device)}:${scopeKey(native.case)}`;
    const previous = await this.storage.get<EndpointCertificate>(certificateKey);
    if (previous && previous.expiresAt > now + OWN_SUPPORT_READ_WINDOW_MS &&
        previous.authorizationGrant === native.authorizationGrant &&
        previous.grant === grant && previous.actor === device.actor &&
        previous.kind === native.kind && sameCase(previous, native.case) &&
        previous.encryptionKey === device.encryptionKey && previous.signingKey === device.signingKey) {
      await verifyCertificate(this.profile, previous, now);
      return previous;
    }
    const certificate = await issueCustomerCertificate({
      profile: this.profile,
      rootSigningKey: this.rootSigningKey,
      approve: async () => ({
        source: "existing-device",
        grant,
        certificate: {
          v: 1,
          ...caseOf(native.case),
          id: crypto.randomUUID(),
          actor: device!.actor,
          kind: native.kind,
          audiences:
            native.kind === "member" ? ["conversation"] : native.kind === "ai"
              ? ["conversation", "ai-draft"] : ["conversation", "team", "ai-draft"],
          ...challenge.device,
          issuedAt: now,
          expiresAt: now + 60 * 60_000,
          grant,
          authorizationGrant: native.authorizationGrant,
        },
      }),
    });
    await this.storage.put(certificateKey, certificate);
    return certificate;
  }
  /** Commit this local denial and outbox before attempting native publication.
   * This is a pending request, never an acknowledgment of native revocation. */
  async requestRevocation(
    native: OwnNativeAuthority,
    input: {
      challenge: string;
      target: OwnDeviceKeys;
      signature: string;
    },
    now = Date.now(),
  ) {
    await this.current(native);
    const challengeKey = `challenge:${await sha256(utf8(native.principal))}`;
    const challenge =
      await this.storage.get<OwnEnrollmentChallenge>(challengeKey);
    if (
      !challenge ||
      challenge.id !== opaqueId(input.challenge) ||
      challenge.expiresAt <= now ||
      challenge.principal !== native.principal ||
      challenge.kind !== native.kind ||
      !sameCase(challenge.case, native.case) ||
      challenge.authorizationGrant !== native.authorizationGrant
    )
      return refused();
    const source = await this.storage.get<Device>(
      await deviceKey(challenge.device),
    );
    const targetKey = await deviceKey(input.target);
    const target = await this.storage.get<Device>(targetKey);
    if (
      !source ||
      source.revoked ||
      !target ||
      source.actor !== target.actor ||
      source.principal !== native.principal ||
      source.kind !== native.kind ||
      !(await verifySignature(
        source.signingKey,
        input.signature,
        await ownDeviceRevocationBytes(challenge, input.target),
      ))
    )
      return refused();
    await this.storage.put(targetKey, { ...target, revoked: true });
    const indexKey = `devices:${target.actor}`;
    const active = (await this.storage.get<string[]>(indexKey)) ?? [];
    await this.storage.put(
      indexKey,
      active.filter((key) => key !== targetKey),
    );
    await this.storage.put(`revocation-pending:${target.id}`, {
      v: 1,
      device: target.id,
      requestedAt: now,
    });
    await this.storage.delete(challengeKey);
    return { state: "pending" as const, device: target.id };
  }
}
