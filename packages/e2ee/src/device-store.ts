/** Browser storage for the customer-controlled client. There is deliberately
 * no localStorage, Templ-domain fallback or private-key serialization. */
import {
  base64url,
  decoded,
  digestValue,
  EncryptionProtocolError,
  object,
  opaqueId,
  parseEncryptionProfile,
  parseEncryptedRecord,
  parseValidationReceipt,
  utf8,
  type EncryptionProfile,
} from "./protocol";
import type { EndpointKeys } from "./client";
import type { EncryptedOutbox, EncryptedOutboxEntry } from "./transport";

export async function openCustomerDeviceStore(
  profile: EncryptionProfile,
  account: string,
  draftId: string,
): Promise<
  EncryptedOutbox & {
    keys(): Promise<EndpointKeys | undefined>;
    /** Atomically returns the established device when another tab won. */
    saveKeys(keys: EndpointKeys): Promise<EndpointKeys>;
    close(): void;
    draft(): Promise<unknown | undefined>;
    saveDraft(value: unknown): Promise<void>;
    pending(): Promise<EncryptedOutboxEntry[]>;
    settle(id: string, draft: unknown): Promise<void>;
  }
> {
  parseEncryptionProfile(profile);
  if (
    globalThis.location?.origin !== profile.clientOrigin ||
    typeof indexedDB === "undefined"
  )
    throw new EncryptionProtocolError("customer-custody-required");
  digestValue(account);
  opaqueId(draftId);
  const prefix = `${profile.custody === "customer" ? "" : "templ-own-support:"}${profile.workspace}:${account}:${profile.rootKey}:`;
  const draftName = `draft:${draftId}`;
  const pendingPrefix = `${prefix}pending:${draftId}:`;
  const request = indexedDB.open("templ-customer-e2ee-v1", 1);
  request.onupgradeneeded = () => request.result.createObjectStore("records");
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(new EncryptionProtocolError("encryption-integrity"));
  });
  const read = <T>(key: string) =>
    new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction("records", "readonly"),
        request = tx.objectStore("records").get(prefix + key);
      tx.oncomplete = () => resolve(request.result as T | undefined);
      tx.onerror = tx.onabort = () =>
        reject(new EncryptionProtocolError("encryption-integrity"));
    });
  const write = (key: string, value: unknown) =>
    new Promise<void>((resolve, reject) => {
      const tx = db.transaction("records", "readwrite");
      tx.objectStore("records").put(value, prefix + key);
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () =>
        reject(new EncryptionProtocolError("encryption-integrity"));
    });
  const draftAad = utf8(`templ:e2ee:local-draft:v1:${prefix}${draftName}`);
  const localDraftKey = async () => {
    const existing = await read<CryptoKey>("draft-key");
    if (existing) return existing;
    const candidate = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    // Two tabs opening together choose one persisted key in a serialized
    // IndexedDB transaction, rather than overwriting each other's key.
    return new Promise<CryptoKey>((resolve, reject) => {
      const tx = db.transaction("records", "readwrite"),
        store = tx.objectStore("records"),
        get = store.get(prefix + "draft-key");
      let selected: CryptoKey;
      get.onsuccess = () => {
        selected = get.result ?? candidate;
        if (!get.result) store.put(selected, prefix + "draft-key");
      };
      tx.oncomplete = () => resolve(selected);
      tx.onerror = tx.onabort = () =>
        reject(new EncryptionProtocolError("encryption-integrity"));
    });
  };
  let drafts: Promise<void> = Promise.resolve();
  const serializeDraft = (value: unknown) => {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string" || utf8(serialized).byteLength > 16_384)
      throw new EncryptionProtocolError();
    return serialized;
  };
  const sealDraft = async (serialized: string) => {
    const nonce = crypto.getRandomValues(new Uint8Array(12)),
      bytes = utf8(serialized);
    try {
      const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: "AES-GCM", iv: nonce, additionalData: draftAad },
          await localDraftKey(),
          bytes,
        ),
      );
      return { nonce: base64url(nonce), ciphertext: base64url(ciphertext) };
    } finally {
      bytes.fill(0);
    }
  };
  return {
    keys: () => read<EndpointKeys>("device"),
    async saveKeys(keys) {
      if (
        keys.encryption.privateKey.extractable ||
        keys.signing.privateKey.extractable
      )
        throw new EncryptionProtocolError("customer-custody-required");
      return new Promise<EndpointKeys>((resolve, reject) => {
        const tx = db.transaction("records", "readwrite"),
          records = tx.objectStore("records"),
          get = records.get(prefix + "device");
        let selected: EndpointKeys;
        get.onsuccess = () => {
          selected = get.result ?? keys;
          if (!get.result) records.put(selected, prefix + "device");
        };
        tx.oncomplete = () => resolve(selected);
        tx.onerror = tx.onabort = () => reject(new EncryptionProtocolError("encryption-integrity"));
      });
    },
    get: (id) => read<EncryptedOutboxEntry>(`outbox:${opaqueId(id)}`),
    async put(input) {
      const row = object(
        input,
        ["v", "state", "record", "receipt", "route"],
        ["reservation"],
      );
      if (
        row.v !== 1 ||
        !["ready", "unknown", "accepted", "fenced"].includes(
          String(row.state),
        ) ||
        typeof row.route !== "string" ||
        !/^\/conversations\/(?:ask|tc-[a-f0-9]{32}\/messages)$/.test(row.route)
      )
        throw new EncryptionProtocolError();
      const record = parseEncryptedRecord(row.record),
        receipt = parseValidationReceipt(row.receipt);
      if (row.reservation !== undefined) opaqueId(row.reservation);
      const value = {
        v: 1,
        state: row.state,
        record,
        receipt,
        route: row.route,
        ...(row.reservation ? { reservation: row.reservation } : {}),
      };
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("records", "readwrite"),
          records = tx.objectStore("records");
        records.put(value, `${prefix}outbox:${record.id}`);
        // Keep the checkpoint until the UI's encrypted draft update commits
        // with its removal, including the ACK-before-draft-clear crash window.
        records.put(value, `${pendingPrefix}${record.id}`);
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () =>
          reject(new EncryptionProtocolError("encryption-integrity"));
      });
    },
    async pending() {
      return new Promise<EncryptedOutboxEntry[]>((resolve, reject) => {
        const tx = db.transaction("records", "readonly"),
          get = tx
            .objectStore("records")
            .getAll(
              IDBKeyRange.bound(pendingPrefix, `${pendingPrefix}\uffff`),
              32,
            );
        tx.oncomplete = () => resolve(get.result);
        tx.onerror = tx.onabort = () =>
          reject(new EncryptionProtocolError("encryption-integrity"));
      });
    },
    async draft() {
      const stored = await read<{ nonce: string; ciphertext: string }>(
        draftName,
      );
      if (!stored) return undefined;
      let bytes: Uint8Array | undefined;
      try {
        bytes = new Uint8Array(
          await crypto.subtle.decrypt(
            {
              name: "AES-GCM",
              iv: decoded(stored.nonce, 12),
              additionalData: draftAad,
            },
            await localDraftKey(),
            decoded(stored.ciphertext, 17, 16_400),
          ),
        );
        return JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        );
      } catch {
        throw new EncryptionProtocolError("encryption-integrity");
      } finally {
        bytes?.fill(0);
      }
    },
    async saveDraft(value) {
      const serialized = serializeDraft(value);
      const run = drafts.then(async () =>
        write(draftName, await sealDraft(serialized)),
      );
      drafts = run.catch(() => {});
      await run;
    },
    async settle(id, value) {
      opaqueId(id);
      const serialized = serializeDraft(value);
      const run = drafts.then(async () => {
        const packet = await sealDraft(serialized);
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction("records", "readwrite"),
            records = tx.objectStore("records"),
            get = records.get(`${pendingPrefix}${id}`);
          get.onsuccess = () => {
            const pending = get.result as EncryptedOutboxEntry | undefined;
            if (!pending) return; // A repeated UI acknowledgment cannot erase a newer draft.
            if (pending.state !== "accepted" && pending.state !== "fenced") {
              tx.abort();
              return;
            }
            records.put(packet, prefix + draftName);
            records.delete(`${pendingPrefix}${id}`);
            if (pending.state === "fenced")
              records.delete(`${prefix}outbox:${id}`);
          };
          tx.oncomplete = () => resolve();
          tx.onerror = tx.onabort = () =>
            reject(new EncryptionProtocolError("encryption-integrity"));
        });
      });
      drafts = run.catch(() => {});
      await run;
    },
    close: () => db.close(),
  };
}
