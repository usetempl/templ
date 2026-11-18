/** The workspace's optional finance address: one mailbox outside the team
 * that gets the billing alerts and the monthly statement email. A billing
 * manager names it; the mailbox's owner proves it by handing back a
 * six-digit code sent there. It never signs in, never sees a thread and
 * gets amounts and counts only, never message text, a member or a wallet.
 *
 * The address is stored sealed (AES-GCM under WEBHOOK_SECRET_KEY, bound to
 * the room). Request paths only queue; the room alarm sends, reserving
 * each send in the daily email ledger every Templ email shares. */
import { customerBillingManagedByTempl } from "./customer-debt-access";
import type { ProductFinanceEmailView } from "@templ/chat/product-catalog";
import {
  alertKeyConfigured,
  confirmationCode,
  keyedHex,
  openAlertSecret,
  sameText,
  sealAlertSecret,
  sha256Hex,
  type AlertCryptoEnv,
  type AlertSecretBox,
} from "./alert-crypto";
import { HttpError } from "./common";
import {
  deliverEmail,
  emailUnavailable,
  normalizeEmail,
  reserveSupportEmail,
  type EmailEnv,
} from "./email-delivery";
import { maskEmail } from "./email-alerts";
import { wakeRoomAt } from "./room-alarm";
import { supportNotificationsConfigured } from "./support-notifications";

type Storage = Pick<
  DurableObjectTransaction,
  "get" | "put" | "delete" | "list" | "getAlarm" | "setAlarm"
>;
export type FinanceEmailEnv = Partial<EmailEnv> & AlertCryptoEnv;

export const FINANCE_EMAIL_KEY = "product-finance-email-v1";
/** `product-finance-out-v1:<at pad 16>:<id>` → a queued email. */
export const FINANCE_OUT_PREFIX = "product-finance-out-v1:";
export const FINANCE_EMAIL_LIMITS = {
  codeTtlMs: 15 * 60_000,
  resendMs: 60_000,
  attempts: 5,
  /** Queued emails at most; later ones wait for the queue to drain. */
  queued: 100,
  sendAttempts: 5,
} as const;
const pad16 = (value: number) => String(Math.max(0, Math.floor(value))).padStart(16, "0");

type FinanceRecord = {
  v: 1;
  box: AlertSecretBox;
  masked: string;
  status: "pending" | "verified";
  codeHash: string | null;
  codeExpiresAt: number | null;
  codeSentAt: number;
  attempts: number;
  verifiedAt: number | null;
};
type Outgoing = {
  id: string;
  subject: string;
  text: string;
  /** A code email goes out while its address is still pending. */
  code?: true;
  attempts: number;
};

const aad = (room: string) => `product-finance-email:${room}:1`;
const codeHash = (env: AlertCryptoEnv, room: string, code: string) =>
  keyedHex(env.WEBHOOK_SECRET_KEY!, `finance-code:${room}:${code}`);

function configured(env: FinanceEmailEnv) {
  return supportNotificationsConfigured(env) && alertKeyConfigured(env);
}

async function readRecord(storage: Pick<Storage, "get">) {
  const value = await storage.get<FinanceRecord>(FINANCE_EMAIL_KEY);
  return value?.v === 1 ? value : null;
}

/** The masked address and whether it is proven, or null. */
export async function financeEmailView(
  storage: Pick<Storage, "get">,
): Promise<ProductFinanceEmailView> {
  const record = await readRecord(storage);
  return record ? { email: record.masked, status: record.status } : null;
}

async function dropQueue(storage: Storage) {
  for (;;) {
    const rows = await storage.list({ prefix: FINANCE_OUT_PREFIX, limit: 128 });
    if (!rows.size) return;
    await storage.delete([...rows.keys()]);
  }
}

async function enqueue(storage: Storage, now: number, email: Omit<Outgoing, "attempts">) {
  const queued = await storage.list({
    prefix: FINANCE_OUT_PREFIX,
    limit: FINANCE_EMAIL_LIMITS.queued,
  });
  if (queued.size >= FINANCE_EMAIL_LIMITS.queued) return false;
  await storage.put(`${FINANCE_OUT_PREFIX}${pad16(now)}:${email.id}`, {
    ...email,
    attempts: 0,
  } satisfies Outgoing);
  await wakeRoomAt(storage, now + 1_000);
  return true;
}

/** Names, replaces or removes (`email: null`) the finance address. A new
 * address waits for its code; nothing else goes there until then. */
export async function setFinanceEmail(
  storage: Storage,
  env: FinanceEmailEnv,
  input: { room: string; email: unknown; now: number },
): Promise<ProductFinanceEmailView> {
  if (input.email === null) {
    await storage.delete(FINANCE_EMAIL_KEY);
    await dropQueue(storage);
    return null;
  }
  if (!configured(env)) throw emailUnavailable();
  const email = normalizeEmail(input.email);
  const current = await readRecord(storage);
  if (current && input.now - current.codeSentAt < FINANCE_EMAIL_LIMITS.resendMs)
    throw new HttpError(429, "Wait a minute before sending another code.", 60);
  const code = confirmationCode();
  const record: FinanceRecord = {
    v: 1,
    box: await sealAlertSecret(env, aad(input.room), { email }),
    masked: maskEmail(email)!,
    status: "pending",
    codeHash: await codeHash(env, input.room, code),
    codeExpiresAt: input.now + FINANCE_EMAIL_LIMITS.codeTtlMs,
    codeSentAt: input.now,
    attempts: 0,
    verifiedAt: null,
  };
  await dropQueue(storage);
  await storage.put(FINANCE_EMAIL_KEY, record);
  await enqueue(storage, input.now, {
    id: `code-${input.now}`,
    subject: "Your Templ billing email code",
    text: `A Templ workspace billing manager wants to send alerts and monthly statements to this address.\n\nIf you expected this, give them this code: ${code}\n\nIt expires in 15 minutes. If you didn't expect it, ignore this email. Nothing else comes here without the code.`,
    code: true,
  });
  return { email: record.masked, status: "pending" };
}

/** Proves the pending address with the code its owner handed back. */
export async function verifyFinanceEmail(
  storage: Storage,
  env: FinanceEmailEnv,
  input: { room: string; code: unknown; now: number },
): Promise<ProductFinanceEmailView> {
  const record = await readRecord(storage);
  if (!record || record.status !== "pending" || !record.codeHash)
    throw new HttpError(409, "Send a code first.");
  if (
    record.attempts >= FINANCE_EMAIL_LIMITS.attempts ||
    record.codeExpiresAt === null ||
    record.codeExpiresAt <= input.now
  )
    throw new HttpError(401, "That code is invalid or expired. Send a new code.");
  if (!alertKeyConfigured(env)) throw emailUnavailable();
  const code = typeof input.code === "string" ? input.code.trim() : "";
  const matches =
    /^\d{6}$/.test(code) &&
    sameText(await codeHash(env, input.room, code), record.codeHash);
  if (!matches) {
    record.attempts++;
    await storage.put(FINANCE_EMAIL_KEY, record);
    throw new HttpError(401, "That code is invalid or expired. Send a new code.");
  }
  record.status = "verified";
  record.codeHash = null;
  record.codeExpiresAt = null;
  record.verifiedAt = input.now;
  await storage.put(FINANCE_EMAIL_KEY, record);
  return { email: record.masked, status: "verified" };
}

/** Queues an email to the proven finance address; nothing while none is
 * proven. `id` makes a repeat of the same email a no-op at the provider. */
export async function queueFinanceEmail(
  storage: Storage,
  now: number,
  email: { id: string; subject: string; text: string },
) {
  const native = await storage.get<{ room?: { id?: string } }>("native-room");
  if (customerBillingManagedByTempl(native?.room?.id ?? "")) return false;
  const record = await readRecord(storage);
  if (record?.status !== "verified") return false;
  return enqueue(storage, now, email);
}

/** Sends queued finance emails, a few per run. Returns when to run again,
 * or null. */
export async function deliverFinanceEmails(
  storage: Storage,
  env: FinanceEmailEnv,
  input: { room: string; now: number; fetcher?: typeof fetch },
): Promise<number | null> {
  const rows = await storage.list<Outgoing>({ prefix: FINANCE_OUT_PREFIX, limit: 5 });
  if (!rows.size) return null;
  const batchFull = rows.size === 5;
  if (customerBillingManagedByTempl(input.room)) {
    for (const [key, email] of rows) {
      if (email.code) continue;
      await storage.delete(key);
      rows.delete(key);
    }
    if (!rows.size) return batchFull ? input.now + 1_000 : null;
  }
  const record = await readRecord(storage);
  if (!record || !configured(env)) {
    // No address, or no sender: nothing here can go out.
    if (!record) await dropQueue(storage);
    return null;
  }
  let to: string;
  try {
    to = (await openAlertSecret<{ email: string }>(env, aad(input.room), record.box)).email;
  } catch {
    await dropQueue(storage);
    return null;
  }
  let retryAt: number | null = null;
  for (const [key, email] of rows) {
    if (!email.code && record.status !== "verified") {
      await storage.delete(key);
      continue;
    }
    const id = await sha256Hex(`${input.room}:${email.id}:${to}`);
    try {
      await reserveSupportEmail(env as EmailEnv, `finance:${id}`);
    } catch {
      email.attempts++;
      if (email.attempts >= FINANCE_EMAIL_LIMITS.sendAttempts) await storage.delete(key);
      else await storage.put(key, email);
      retryAt = input.now + 60_000;
      continue;
    }
    await deliverEmail(env as EmailEnv, input.fetcher ?? fetch, {
      to,
      subject: email.subject,
      text: email.code
        ? email.text
        : `${email.text}\n\nA workspace billing manager chose this address for Templ billing emails. Ask them to remove it on the Plan tab to stop these emails.`,
      idempotencyKey: `templ-finance/${id}`,
    });
    await storage.delete(key);
  }
  if (batchFull) return input.now + 1_000;
  return retryAt;
}
