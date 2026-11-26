import {
  detectKeySecret,
  hasRecoveryPhraseShape,
  detectKeySecretValue,
  solanaSecretCandidates,
} from "@templ/chat/support-safety-hex";
import type { SupportSelectedWallet } from "./support-widget";
import type { SupportContextInput } from "@templ/chat/support";

const thread = /^tc-[0-9a-f]{32}$/;

function unsafe(value: unknown): boolean {
  return typeof value === "string"
    ? hasRecoveryPhraseShape(value) ||
        detectKeySecret(value) !== null ||
        solanaSecretCandidates(value).length > 0
    : Array.isArray(value) &&
        value.length === 64 &&
        value.every(
          (byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255,
        )
      ? true
      : !!value &&
        typeof value === "object" &&
        Object.entries(value).some(
          ([key, item]) =>
            unsafe(key) ||
            unsafe(item) ||
            detectKeySecretValue(key, item) !== null,
        );
}

export function canPersist(value: unknown): boolean {
  return !unsafe(value);
}

/** A retained context must be an object within the size limit. The service
 * checks its fields. An invalid draft is discarded by the caller. */
function pendingContext(value: unknown): SupportContextInput | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error();
  const kept = JSON.stringify(value);
  if (kept.length > 4000) throw new Error();
  return JSON.parse(kept);
}

/** Validate a retained attempt before the widget restores its retry controls. */
export function pending(input: unknown) {
  if (!input || typeof input !== "object") return;
  const value = input as {
    id: string;
    text: string;
    target: string | null;
    newCaseFrom?: string;
    context?: unknown;
    wallet?: SupportSelectedWallet;
    sent?: unknown;
    serverId?: unknown;
  };
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value.id,
    ) &&
    typeof value.text === "string" &&
    !!value.text.trim() &&
    value.text.length <= 2000 &&
    (value.target === null || thread.test(value.target)) &&
    (value.newCaseFrom === undefined ||
      (value.target === null && thread.test(value.newCaseFrom))) &&
    Number.parseInt(value.id.slice(0, 8) + value.id.slice(9, 13), 16) >
      Date.now() - 7 * 86400000 + 60000
  )
    return {
      id: value.id,
      text: value.text,
      target: value.target,
      newCaseFrom: value.newCaseFrom,
      context: pendingContext(value.context),
      wallet: value.wallet,
      sent: value.sent === true,
      serverId: typeof value.serverId === "string" ? value.serverId : undefined,
    };
}

/** Keeps key-like values in memory until the server can check them. */
export function save(
  key: string,
  value: {
    text: string;
    pending?: unknown;
    newCaseFrom?: string;
    savedAt?: number;
    transactionHash?: string;
  },
) {
  if ((!value.text && !value.pending) || unsafe(value))
    localStorage.removeItem(key);
  else localStorage.setItem(key, JSON.stringify(value));
}

/** Screens old device drafts before any text or pending send returns. */
export function read(key: string) {
  const value = JSON.parse(localStorage.getItem(key) ?? "null");
  if (
    !value ||
    typeof value.text !== "string" ||
    value.text.length > 2000 ||
    !Number.isSafeInteger(value.savedAt) ||
    value.savedAt < Date.now() - 7 * 86400000 ||
    unsafe(value)
  ) {
    localStorage.removeItem(key);
    return;
  }
  if (
    typeof value.transactionHash !== "string" ||
    value.transactionHash.length > 300
  )
    delete value.transactionHash;
  if (typeof value.newCaseFrom !== "string" || !thread.test(value.newCaseFrom))
    delete value.newCaseFrom;
  return value;
}

/** Restore saved fields only while the visitor has not started a new draft. */
export function restoreInputs(
  saved: { text: string; transactionHash?: string },
  draft: HTMLTextAreaElement,
  transaction: HTMLInputElement,
  notice: HTMLElement,
) {
  if (draft.value) return false;
  draft.value = saved.text;
  if (saved.transactionHash !== undefined) transaction.value = saved.transactionHash;
  if (draft.value) notice.textContent = "Draft restored from this device.";
  return true;
}
