import { exportPublic, type EndpointKeys } from "@templ/e2ee/client";
import { openCustomerDeviceStore } from "@templ/e2ee/device-store";
import { base64url, decoded, object, utf8, OWN_SUPPORT_ENDPOINT, type OwnSupportEncryptionProfile } from "@templ/e2ee/protocol";
import { sha256 } from "@templ/e2ee/verify";
import { ownDeviceApprovalBytes, ownEnrollmentBytes, parseOwnEnrollmentChallenge, type OwnEnrollmentChallenge } from "@templ/e2ee/own-authority";
import {memberDeviceAccount} from "./member-wallet";

export type DeviceApproval = {device: {encryptionKey: string; signingKey: string}; signature: string};
const text = (tag: "p" | "h1" | "label", value: string) => {const node = document.createElement(tag); node.textContent = value; return node;};
function field(label: string, value = "", readOnly = false) {
  const line = text("label", label), input = document.createElement("textarea");
  input.value = value; input.readOnly = readOnly; input.spellcheck = false; input.maxLength = 8192; line.append(input);
  return {line, input};
}
function decode(value: string): unknown {
  if (value.length > 8192) throw new Error("This device request is too long.");
  return JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(decoded(value, 1, 6144)));
}
const encode = (value: unknown) => base64url(utf8(JSON.stringify(value)));
const fingerprint = async (challenge: OwnEnrollmentChallenge) => (await sha256(ownEnrollmentBytes(challenge))).slice(0, 16).match(/.{4}/g)!.join(" ");
function button(label: string, run: () => Promise<void>) {
  const node = document.createElement("button"); node.type = "button"; node.textContent = label;
  node.addEventListener("click", () => {node.disabled = true; void run().finally(() => {node.disabled = false;});});
  return node;
}

/** Copyable public challenge and signature; no bearer or decryption secret
 * passes through the clipboard, page URL, or the main Templ origin. */
export async function requestDeviceApproval(panel: HTMLElement, input: OwnEnrollmentChallenge, signal: AbortSignal): Promise<DeviceApproval> {
  const challenge = parseOwnEnrollmentChallenge(input), code = await fingerprint(challenge);
  if (signal.aborted) throw new Error("Your sign-in changed.");
  return new Promise((resolve, reject) => {
    const box = document.createElement("section");
    const link = field("Open this link on a device that could already read this chat", `${OWN_SUPPORT_ENDPOINT.clientOrigin}/#approve=${encode(challenge)}`, true);
    const reply = field("Paste that device's approval"), status = text("p", ""); status.setAttribute("role", "status");
    const finish = (error?: Error, result?: DeviceApproval) => {
      clearTimeout(timeout); signal.removeEventListener("abort", abort); box.remove();
      if (error) reject(error); else resolve(result!);
    };
    const abort = () => finish(new Error("Your sign-in changed."));
    const timeout = setTimeout(() => finish(new Error("The device request expired. Open the chat again to retry.")), Math.max(1, challenge.expiresAt - Date.now()));
    box.append(text("h1", "Approve this device"), text("p", `Compare this code on both devices: ${code}`),
      text("p", "Approve only your own device. The approval gives it access to this chat. If you have no approved device left, start a separate new request."),
      link.line, reply.line, button("Use approval", async () => {
        try {
          parseOwnEnrollmentChallenge(challenge);
          const raw = object(decode(reply.input.value.trim()), ["request", "device", "signature"]), device = object(raw.device, ["encryptionKey", "signingKey"]);
          if (raw.request !== await sha256(ownEnrollmentBytes(challenge)) || typeof raw.signature !== "string" ||
            typeof device.encryptionKey !== "string" || typeof device.signingKey !== "string") throw new Error("Use the approval for this device request.");
          decoded(raw.signature, 64); decoded(device.encryptionKey, 65); decoded(device.signingKey, 65);
          if (signal.aborted) throw new Error("Your sign-in changed.");
          finish(undefined, {device: device as DeviceApproval["device"], signature: raw.signature});
        } catch {status.textContent = "That approval could not be checked. Copy the complete approval from the other device.";}
      }), button("Cancel", async () => finish(new Error("Device approval was cancelled."))), status);
    panel.append(box); signal.addEventListener("abort", abort, {once: true});
  });
}

export async function showDeviceApproval(panel: HTMLElement, profile: OwnSupportEncryptionProfile, value: string, signal: AbortSignal) {
  const challenge = parseOwnEnrollmentChallenge(decode(value)), code = await fingerprint(challenge);
  // Same principal namespace as the original device, even after a native
  // email resume rotates its session. The private key stays in IndexedDB.
  const mapped = challenge.kind === "member" ? memberDeviceAccount(profile, challenge.principal, challenge.case) : undefined;
  const account = mapped?.account ?? await sha256(utf8(`templ:own-client:v1:${challenge.kind}:${challenge.principal}`));
  const store = await openCustomerDeviceStore(profile, account, crypto.randomUUID());
  let keys: EndpointKeys | undefined;
  try {keys = await store.keys();} finally {store.close();}
  if (signal.aborted) return;
  if (!keys) throw new Error("This browser has no device key for that chat. Use a device that already read it.");
  const status = text("p", ""); status.setAttribute("role", "status");
  const label = text("label", `I am linking my own device and both show ${code}`), confirm = document.createElement("input");
  confirm.type = "checkbox"; label.prepend(confirm);
  const approve = button("Approve device", async () => {
    try {
      if (!confirm.checked) {status.textContent = "Compare both codes and confirm this is your own device."; return;}
      parseOwnEnrollmentChallenge(challenge);
      if (signal.aborted) return;
      const signature = base64url(new Uint8Array(await crypto.subtle.sign({name: "ECDSA", hash: "SHA-256"}, keys!.signing.privateKey, await ownDeviceApprovalBytes(challenge))));
      const device = {encryptionKey: await exportPublic(keys!.encryption.publicKey), signingKey: await exportPublic(keys!.signing.publicKey)};
      if (signal.aborted) return;
      const response = field("Copy this approval back to your new device", encode({request: await sha256(ownEnrollmentBytes(challenge)), device, signature}), true);
      panel.replaceChildren(text("h1", "Device approval ready"), response.line,
        text("p", "This approval works only for the displayed request, expires with it, and contains no private key."));
    } catch {status.textContent = "This request expired or could not be approved. Create a new request on the new device.";}
  });
  panel.replaceChildren(text("h1", "Approve another device"), text("p", "This grants a new device access to your encrypted chat. Approve only a request you just started on that device."), label, approve, status);
}
