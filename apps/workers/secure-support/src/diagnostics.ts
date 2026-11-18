import {EncryptionProtocolError} from "@templ/e2ee/protocol";

const phases = ["profile", "native-authorization", "vault-load", "vault-restore",
  "journal-start", "journal-read", "device-approval", "validation-directory", "validation-approval",
  "validation-record", "validation-final", "recovery-approval", "recovery-read", "recovery-recipient",
  "recovery-record", "recovery-wrap", "recovery-final", "journal-finish"] as const;
export type OwnKeyPhase = typeof phases[number];
type NativeRoute = "case" | "directory" | "history" | "enroll" | "other";
type NativeFailure = "http" | "timeout" | "network" | "response-format";
export class OwnNativeUnavailable extends EncryptionProtocolError {
  constructor(readonly route: NativeRoute, readonly failure: NativeFailure, readonly status?: number) {
    super("encryption-scope-changed");
  }
}
export function nativeRoute(path: string): NativeRoute {
  if (/\/directory(?:\?|$)/.test(path)) return "directory";
  if (/\/history(?:\?|$)/.test(path)) return "history";
  if (path.endsWith("/enroll")) return "enroll";
  if (/\/encryption\/[1-9][0-9]*$/.test(path)) return "case";
  return "other";
}
/** Fixed diagnostic enums only. Never serialize an exception, request,
 * response body, principal, case identifier, certificate or key material. */
export function ownKeyFailure(operation: string, phase: OwnKeyPhase, error: unknown) {
  if (!["challenge", "enroll", "revoke-device", "validate", "recover"].includes(operation)) return;
  const base = {event: "own-support-key-failure", operation, phase: phases.includes(phase) ? phase : "unknown"};
  if (error instanceof OwnNativeUnavailable) return {...base, kind: "native",
    route: ["case", "directory", "history", "enroll", "other"].includes(error.route) ? error.route : "other",
    failure: ["http", "timeout", "network", "response-format"].includes(error.failure) ? error.failure : "other",
    ...(Number.isInteger(error.status) && error.status! >= 100 && error.status! <= 599 ? {status: error.status} : {})};
  if (error instanceof EncryptionProtocolError &&
      ["invalid-encrypted-data", "customer-custody-required", "encryption-integrity", "encryption-scope-changed"].includes(error.code))
    return {...base, kind: "protocol", reason: error.code};
  return {...base, kind: "unexpected"};
}
