import {ownSetupDigest, ownSetupExpectedBytes, parseOwnSetupStatus, verifyOwnSetupAuthorization, verifyOwnStopAuthorization, type OwnSetupAuthorization, type OwnStopAuthorization, type OwnSetupStatus} from "@templ/e2ee/own-setup";
import {OWN_SETUP_SNAPSHOT_LIMIT, verifyOwnSetupSnapshot} from "@templ/e2ee/own-setup-snapshot";
import type {OwnSupportEncryptionProfile} from "@templ/e2ee/protocol";

/** This screen never signs a policy, grants a role or approves a device. */
export async function showEncryptionSetup(input: {
  panel: HTMLElement; profile: OwnSupportEncryptionProfile; principal: string; signal: AbortSignal;
  request: <T>(path: string, body?: object) => Promise<T>; back: () => void;
}) {
  const {panel, request, signal} = input;
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
    const value = document.createElement(tag); if (text) value.textContent = text; return value;
  };
  let state = parseOwnSetupStatus(await request("/native/team/conversations/encryption/setup"));
  if (signal.aborted) return;
  if (state.principal !== input.principal) throw new Error("Your sign-in changed. Open setup again.");
  let approval: OwnSetupAuthorization | OwnStopAuthorization | undefined, selection = 0;
  const status = element("p"), result = element("p"), details = element("p"); result.setAttribute("role", "status");
  const fileLabel = element("label", "Approval file"), file = element("input"); file.type = "file"; file.accept = ".json,application/json";
  fileLabel.append(file);
  const confirmLabel = element("label", "I have reviewed this change."), confirm = element("input"); confirm.type = "checkbox"; confirmLabel.prepend(confirm);
  const apply = element("button", "Apply approval"); apply.type = "button"; apply.disabled = true;
  const download = element("button", "Download setup state"); download.type = "button";
  const back = element("button", "Back"); back.type = "button";
  const current = () => !signal.aborted && panel.contains(status);
  const describe = (value: OwnSetupStatus) => {
    status.textContent = value.newCases === "encrypted" ? "New Templ support chats require encryption." : "Encrypted support is not enabled for new chats.";
  };
  const refresh = async () => {
    const next = parseOwnSetupStatus(await request("/native/team/conversations/encryption/setup"));
    if (next.principal !== input.principal) throw new Error("Your sign-in changed. Open setup again.");
    if (current()) {state = next; describe(state);}
    return next;
  };
  const clear = () => {selection++; approval = undefined; file.value = ""; confirm.checked = false; apply.disabled = true; details.textContent = "";};
  signal.addEventListener("abort", clear, {once: true});
  back.addEventListener("click", () => {clear(); input.back();}, {signal});
  download.addEventListener("click", () => {
    download.disabled = true;
    void (async () => {
      const value = await request<unknown>("/setup/team/state");
      const text = JSON.stringify(value);
      if (new TextEncoder().encode(text).length > OWN_SETUP_SNAPSHOT_LIMIT) throw new Error("Setup state is too large. Contact the workspace operator.");
      const snapshot = await verifyOwnSetupSnapshot(value, input.profile.rootKey);
      if (snapshot.status.principal !== input.principal || snapshot.profile.signature !== input.profile.signature) throw new Error("The setup state changed. Try again.");
      if (!current()) return;
      const url = URL.createObjectURL(new Blob([text], {type: "application/json"})), link = element("a");
      link.href = url; link.download = "templ-encryption-setup-state.json"; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      result.textContent = "Setup state downloaded. It expires in one minute and contains no private key.";
    })().catch(() => {if (current()) result.textContent = "Setup state could not be downloaded. Refresh and try again.";})
      .finally(() => {download.disabled = false;});
  }, {signal});
  file.addEventListener("change", () => {
    const selected = file.files?.[0], operation = ++selection; approval = undefined; confirm.checked = false; apply.disabled = true; details.textContent = "";
    void (async () => {
      if (!selected || selected.size > 16_384) throw new Error("Choose the bounded approval file from your workspace operator.");
      const raw: unknown = JSON.parse(await selected.text());
      const value = raw !== null && typeof raw === "object" && "action" in raw && raw.action === "stop"
        ? await verifyOwnStopAuthorization(raw, input.profile.rootKey)
        : await verifyOwnSetupAuthorization(raw, input.profile.rootKey, Date.now(), true);
      const latest = await refresh();
      if (!current() || operation !== selection || file.files?.[0] !== selected) return;
      if (value.profile.signature !== input.profile.signature) throw new Error("This approval belongs to another setup.");
      if (value.action === "stop") {
        if (latest.newCases === "legacy") {clear(); result.textContent = "New chats already use ordinary support. Existing encrypted chats keep their protection."; return;}
        if (latest.profileSignature !== value.profile.signature || latest.policyRevision + 1 !== value.revision)
          throw new Error("The workspace changed. Download fresh setup state.");
        approval = value;
        details.textContent = "Use ordinary support for new chats. Templ can read those new messages. Existing encrypted chats keep their protection.";
        apply.textContent = "Stop new encrypted chats";
        result.textContent = "This approval has no time expiry. Only a current manager can use it, while its policy revision is next.";
        return;
      }
      const digest = await ownSetupDigest(value);
      if (!current() || operation !== selection || file.files?.[0] !== selected) return;
      if (value.principal !== input.principal) throw new Error("This approval belongs to another account.");
      if (latest.appliedDigest === digest) {clear(); result.textContent = "This approval has already been applied."; return;}
      if (value.expiresAt <= Date.now() || !latest.available || JSON.stringify(ownSetupExpectedBytes(value.expected)) !== JSON.stringify(ownSetupExpectedBytes(latest)))
        throw new Error("This approval expired or the workspace changed. Download fresh setup state.");
      approval = value;
      details.textContent = value.action === "prepare"
        ? "Prepare one designated test chat. Other new chats keep their current protection. This does not approve a device."
        : "Require encryption for new Templ support chats. A visitor’s first message can take about a minute while their device gets its keys. Only approved recipients can decrypt new chats. Existing chats keep their original format.";
      apply.textContent = value.action === "prepare" ? "Prepare test chat" : "Enable encrypted support";
      result.textContent = `Approval expires at ${new Date(value.expiresAt).toLocaleTimeString()}.`;
    })().catch(error => {if (current() && operation === selection) {clear(); result.textContent = error instanceof Error ? error.message : "The approval could not be verified.";}});
  }, {signal});
  confirm.addEventListener("change", () => {apply.disabled = !approval || !confirm.checked;}, {signal});
  apply.addEventListener("click", () => {
    if (!approval || !confirm.checked) return;
    apply.disabled = true; file.disabled = true; confirm.disabled = true; const selected = approval, operation = selection;
    void (async () => {
      if (selected.action === "stop") {
        const latest = await refresh();
        if (!current() || operation !== selection) return;
        if (latest.newCases === "encrypted") {
          if (latest.profileSignature !== selected.profile.signature || latest.policyRevision + 1 !== selected.revision)
            throw new Error("The workspace changed.");
          await request("/native/team/conversations/encryption", {on: false, revision: selected.revision,
            profile: selected.profile, signature: selected.signature, confirmed: true, expectedPrincipalId: input.principal});
        }
        const next = await refresh();
        if (!current() || operation !== selection) return;
        clear();
        result.textContent = next.newCases === "legacy"
          ? "New chats use ordinary support. Existing encrypted chats keep their protection."
          : "The workspace changed again. Its current protection is shown above. Download fresh setup state.";
        return;
      }
      const response = await request<{applied: boolean; replayed: boolean; status: unknown}>("/native/team/conversations/encryption/setup",
        {authorization: selected, confirmed: true, expectedPrincipalId: input.principal});
      if (!current() || operation !== selection) return;
      const next = parseOwnSetupStatus(response.status);
      const digest = await ownSetupDigest(selected);
      if (!current() || operation !== selection) return;
      if (!response.applied || next.principal !== input.principal || next.appliedDigest !== digest) throw new Error("Read the current setup before trying again.");
      state = next; clear(); describe(state);
      result.textContent = response.replayed
        ? "This approval was already applied. The current protection is shown above. Download fresh setup state before another test."
        : next.newCases === "encrypted" ? "Encrypted support is enabled for new Templ chats." : "The designated test chat is prepared. Device approval is still required, and the test approval has an expiry.";
    })().catch(async () => {
      if (selected.action === "stop" && current() && operation === selection) {
        try {
          const next = await refresh();
          if (!current() || operation !== selection) return;
          if (next.newCases === "legacy") {clear(); result.textContent = "New chats use ordinary support. Existing encrypted chats keep their protection."; return;}
          if (next.policyRevision + 1 !== selected.revision || next.profileSignature !== selected.profile.signature) {
            clear(); result.textContent = "The workspace changed. Its current protection is shown above. Download fresh setup state."; return;
          }
        } catch { /* Keep the exact approval for a retry; never invent a revision. */ }
      }
      if (current() && operation === selection) {result.textContent = "The result could not be confirmed. Retry this same approval to check its outcome."; apply.disabled = false;}
    }).finally(() => {if (current()) {file.disabled = false; confirm.disabled = false;}});
  }, {signal});
  panel.replaceChildren(element("h1", "Encryption setup"), status,
    element("p", "This key service belongs to Templ’s own support workspace. Other workspaces control their own keys and backups."),
    element("p", "Keep the workspace key backups. If every usable key and backup is lost, old encrypted messages cannot be recovered."),
    download, fileLabel, details, confirmLabel, apply, back, result);
  describe(state);
}
