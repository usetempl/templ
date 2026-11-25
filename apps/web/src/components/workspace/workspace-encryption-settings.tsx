"use client";

import { useEffect, useRef, useState } from "react";
import { decoded, object, OWN_SUPPORT_ENDPOINT, parseCustomerProfile } from "@templ/e2ee/protocol";
import type { CustomerEncryptionProfile } from "@templ/e2ee/protocol";
import { chatMutation } from "@/lib/chat-api";
import { communityFetch, roomPath } from "@/lib/community-client";
import { Card, Spinner } from "@/components/ui/ui";
import type { WorkspaceContext } from "./support-workspace";
import styles from "./workspace.module.css";
import layout from "./workspace-settings.module.css";

type Policy = {
  revision: number;
  newCases: "legacy" | "encrypted";
  profile?: CustomerEncryptionProfile;
};
type Settings = Policy & { available: boolean; custody: string };
type Approval = {
  on: boolean;
  revision: number;
  profile: CustomerEncryptionProfile;
  signature: string;
};

export function WorkspaceEncryptionSettings({ context }: { context: WorkspaceContext }) {
  const { room, id, account } = context;
  const own = id === OWN_SUPPORT_ENDPOINT.workspace;
  const readPolicy = own || !!context.status?.encryption || context.state?.features?.supportEncryption === true;
  const path = roomPath(room, "conversations/encryption");
  const lifetime = useRef<AbortController>(null);
  const selection = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const saving = useRef(false);
  const [settings, setSettings] = useState<Settings>();
  const [chosen, setChosen] = useState<Policy["newCases"]>();
  const [approval, setApproval] = useState<Approval>();
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!readPolicy) return;
    const controller = new AbortController();
    lifetime.current = controller;
    void communityFetch<Settings>(path, undefined, controller.signal).then(
      (state) => { if (!controller.signal.aborted) setSettings(state); },
      () => { if (!controller.signal.aborted) setError("Encryption settings could not load."); },
    );
    return () => controller.abort();
  }, [path, account, attempt, readPolicy]);

  function select(file?: File) {
    const active = lifetime.current?.signal;
    const selected = ++selection.current;
    setApproval(undefined);
    setConfirmed(false);
    setNotice("");
    setError("");
    if (!file || !settings || !active || !chosen || chosen === settings.newCases) return;
    void (async () => {
      if (file.size > 16_384) throw new Error();
      // Only public profile fields and the policy signature can leave this
      // browser. Key backups are never valid approval files.
      const value = object(JSON.parse(await file.text()), ["on", "revision", "profile", "signature"]);
      const profile = parseCustomerProfile(value.profile);
      if (
        typeof value.on !== "boolean" ||
        value.on !== (chosen === "encrypted") ||
        value.on === (settings.newCases === "encrypted") ||
        value.revision !== settings.revision + 1 ||
        profile.workspace !== id ||
        (settings.profile && settings.profile.rootKey !== profile.rootKey) ||
        typeof value.signature !== "string"
      ) throw new Error();
      decoded(value.signature, 64);
      if (!active.aborted && selected === selection.current)
        setApproval({on: value.on, revision: value.revision, profile, signature: value.signature});
    })().catch(() => {
      if (!active.aborted && selected === selection.current)
        setError("Choose the signed public approval for this workspace and the mode you selected.");
    });
  }

  async function apply() {
    const active = lifetime.current?.signal;
    if (!active || active.aborted || !approval || !confirmed || saving.current) return;
    saving.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await chatMutation<Policy>(account, path, {...approval, confirmed: true}, undefined, active);
      if (active.aborted) return;
      if (result.revision !== approval.revision || result.newCases !== (approval.on ? "encrypted" : "legacy"))
        throw new Error("Refresh encryption settings to check the result.");
      setSettings(before => before && {...before, ...result});
      setChosen(undefined);
      setApproval(undefined);
      setConfirmed(false);
      if (fileInput.current) fileInput.current.value = "";
      setNotice(approval.on ? "Saved. New chats use end-to-end encryption." : "Saved. New chats use Standard.");
      context.reload();
    } catch (reason) {
      if (!active.aborted) setError(reason instanceof Error ? reason.message : "The change could not be confirmed.");
    } finally {
      saving.current = false;
      if (!active.aborted) setBusy(false);
    }
  }

  const savedMode = readPolicy ? settings?.newCases : context.status && (context.status.encryption ? "encrypted" : "legacy");
  const selectedMode = chosen ?? savedMode;
  const canChange = !!settings && (settings.available || settings.newCases === "encrypted") &&
    (own || settings.custody === "customer");
  function choose(mode: Policy["newCases"]) {
    select();
    setChosen(mode);
    if (fileInput.current) fileInput.current.value = "";
  }
  if (!context.status?.encryption && !settings?.profile && !(settings && settings.revision > 0)) return null;
  return (
    <Card id="case-encryption" title="Chat encryption">
      <div className={layout.panelBody}>
        {!savedMode && !error && <p role="status"><Spinner /> Reading the default for new chats…</p>}
        {savedMode && (
          <>
            <p tabIndex={-1} data-section-focus>Current default for new chats: <strong>{savedMode === "encrypted" ? "End-to-end encrypted" : "Standard"}</strong>.</p>
            <p>Existing chats keep their original mode. Reading encrypted history still requires an approved device or a workspace recovery key.</p>
            <fieldset className={styles.stack}>
              <legend>Mode for new chats</legend>
              <label className={layout.modeChoice}>
                <input type="radio" name="new-chat-mode" checked={selectedMode === "legacy"} disabled={!canChange || busy} onChange={() => choose("legacy")} />
                <span><strong>Standard</strong><small>The visitor and staff with case access can read messages. The support server can read them. Your AI can read a case when its AI mode allows it.</small></span>
              </label>
              <label className={layout.modeChoice}>
                <input type="radio" name="new-chat-mode" checked={selectedMode === "encrypted"} disabled={!settings?.available || !canChange || busy} onChange={() => choose("encrypted")} />
                <span><strong>End-to-end encrypted</strong><small>The visitor and approved team devices read messages with their keys. The relay stores encrypted text.</small></span>
              </label>
            </fieldset>
            {!canChange && <p>Changes to chat encryption are unavailable under this workspace’s current policy.</p>}
            {canChange && <p>A new visitor’s first encrypted send can take about a minute while their device gets its keys.</p>}
            {canChange && chosen && chosen !== savedMode && (own ? <>
              <p>Use Templ Support’s key service to approve this change. Its approved devices and workspace backup provide access to encrypted history.</p>
              <a className="button" href={`${OWN_SUPPORT_ENDPOINT.clientOrigin}/#encryption-setup`} target="_blank" rel="noopener noreferrer">
                Open Encryption setup
              </a>
              <button className="button secondary" disabled={busy} onClick={() => { select(); setChosen(undefined); setSettings(undefined); setAttempt(value => value + 1); }}>Refresh default</button>
            </> : <>
            <p>Your workspace keeps its keys and recovery backup. Create a signed approval for {chosen === "encrypted" ? "end-to-end encryption" : "Standard"} with your workspace key service. Upload only the public approval file.</p>
            <label>
              Signed public approval
              <input ref={fileInput} type="file" accept=".json,application/json"
                disabled={busy} onChange={event => select(event.currentTarget.files?.[0])} />
            </label>
            {approval && (
              <label>
                <input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.currentTarget.checked)} />
                {approval.on ? " I have backed up my workspace keys and understand that Templ cannot recover these messages." : " I want new chats to use Standard."}
              </label>
            )}
            <button className="button" type="button" disabled={busy || !approval || !confirmed} onClick={() => void apply()}>
              {busy ? "Saving…" : "Save default for new chats"}
            </button>
            </>)}
          </>
        )}
        {notice && <p role="status">{notice}</p>}
        {error && <>
          <p role="alert">{error}</p>
          <button type="button" className="button secondary" onClick={() => {
            select();
            setSettings(undefined);
            setAttempt(value => value + 1);
          }}>Refresh settings</button>
        </>}
      </div>
    </Card>
  );
}
