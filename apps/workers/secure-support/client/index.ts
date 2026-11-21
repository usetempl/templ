import { stringToHex } from "viem";
import { OWN_SUPPORT_ENDPOINT, base64url, caseOf, type E2eeCase, type EndpointCertificate, type OwnSupportEncryptionProfile } from "@templ/e2ee/protocol";
import { encryptedRecordDigest, sha256, verifyEncryptionProfile } from "@templ/e2ee/verify";
import { OWN_SUPPORT_READ_WINDOW_MS, ownEnrollmentBytes, ownWalletApprovalText, type OwnEnrollmentChallenge } from "@templ/e2ee/own-authority";
import { mountCustomerSupport } from "@templ/e2ee/view";
import { openCustomerDeviceStore } from "@templ/e2ee/device-store";
import { createEndpointKeys, type EndpointKeys } from "@templ/e2ee/client";
import { connectCustomerCase } from "@templ/e2ee/transport";
import { createSupportClient, type SupportWalletProvider } from "../../../web/src/lib/support-widget";
import { diagnostics } from "../../../web/src/lib/support-widget-diagnostics";
import { APP_LABELS, appValue } from "../../../web/src/lib/support-widget-app";
import { SUPPORT_DIAGNOSTIC_FIELDS, type SupportAppContextInput, type SupportAppContext } from "@templ/chat/support-app-context";
import type { TeamConversationList } from "@templ/chat/index";
import {memberConversations, memberConversationsPath} from "../../../web/src/lib/support-widget-conversations";
import { requestDeviceApproval, showDeviceApproval } from "./device-approval";
import {showEncryptionSetup} from "./setup";
import {checkedTeamSession, signInTeam, type TeamSession} from "./team-session";
import {watchTeamWallet, type WalletSelection} from "./wallet-watch";
type TeamConnection = TeamSession & {walletSelection?: WalletSelection};
import styles from "./page.module.css";
import {conversationTools} from "./conversation";
import {createOwnRecoveryCache} from "./recovery-cache";
import {readOwnRecoveredRecord} from "./recover-read";
import {connectWidgetFrame, widgetNavigation} from "./widget-frame";
import {ownIntake} from "./intake";
import {ownContactChoice} from "./contact";
import {labelIcon, domIcon} from "./icons";
import {openingScene, sendMotion} from "./loading-scene";
import {forgetMemberWallet, memberDeviceAccount, memberWalletIntent, prepareMemberWallet, rememberMemberCase, verifyMemberWallet} from "./member-wallet";

declare const __OWN_ROOT_KEY__: string;
type Channel = "member" | "team";
const origin = OWN_SUPPORT_ENDPOINT.clientOrigin;
const main = document.querySelector<HTMLElement>("main")!;
const panel = document.querySelector<HTMLElement>("#account")!;
let revision = 1, dispose: (() => void) | undefined;
let pageLifetime = new AbortController();
const widget = widgetNavigation(new URL(location.href));
const inbox = location.pathname === "/inbox-case" && window.parent !== window;
let frameHost: Awaited<ReturnType<typeof connectWidgetFrame>> | undefined;
if (widget) document.documentElement.dataset.theme = widget.theme;
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  return result;
};
const button = (label: string, run: () => Promise<void>) => {
  const result = node("button", label);
  result.type = "button";
  result.addEventListener("click", () => {
    result.disabled = true;
    const task = run(), actionRevision = revision;
    void task.catch(error => {if (actionRevision === revision) showError(error);}).finally(() => {result.disabled = false;});
  });
  return result;
};
function showError(error: unknown) {
  if (error instanceof DOMException && error.name === "AbortError") return;
  // A failure ends opening; the mounted chat manages its own scene.
  for (const scene of document.querySelectorAll("[data-opening-scene]")) scene.remove();
  if (!main.childElementCount && !widget) {document.body.classList.remove(styles.chatPage!); panel.className = styles.account;}
  panel.querySelector("[data-opening]")?.removeAttribute("data-opening");
  const retry = panel.querySelector<HTMLButtonElement>("[data-opening-retry]");
  if (retry) retry.hidden = false;
  const message = error instanceof Error ? error.message : "The chat could not open. Try again.";
  let status = document.querySelector<HTMLElement>("#page-status");
  if (!status) {status = node("p"); status.id = "page-status"; status.setAttribute("role", "status"); panel.append(status);}
  status.classList.remove(styles.srOnly!);
  status.textContent = message;
  if (widget && !main.childElementCount && !panel.querySelector("button"))
    panel.append(button("Retry", async () => location.reload()));
}
function loadingChat(retry: () => Promise<void>, cancel: () => void = () => {frameHost?.close();}) {
  document.body.classList.add(styles.chatPage!); main.hidden = true;
  panel.className = styles.loading;
  const head = node("header"), logo = node("img"), title = node("div"), body = node("div"), status = node("p");
  logo.src = "/templ-square.svg"; logo.alt = ""; logo.width = logo.height = 32;
  title.append(node("strong", "Templ support"), node("small", "Private chat"));
  const close = button(widget ? "×" : "Back", async () => cancel()); close.setAttribute("aria-label", widget ? "Close support" : "Back");
  const bar = node("span"); bar.className = styles.openingBar!; bar.setAttribute("aria-hidden", "true");
  head.append(logo, title, close, bar);
  status.id = "page-status"; status.setAttribute("role", "status"); status.dataset.opening = "";
  status.append(domIcon("lock"), node("span", "Opening secure chat…"));
  status.className = styles.openingStatus!;
  body.className = styles.opening!;
  const retryButton = button("Retry", retry); retryButton.hidden = true; retryButton.dataset.openingRetry = "";
  const scene = openingScene(); scene.dataset.openingScene = "";
  body.append(scene, status, retryButton);
  panel.replaceChildren(head, body);
}
/** Keeps the scene in place while a chat prepares its device store before mounting. */
function openingGap() {
  const frame = node("div"), status = node("p");
  status.setAttribute("role", "status"); status.dataset.opening = ""; status.className = styles.openingStatus!;
  status.append(domIcon("lock"), node("span", "Opening secure chat…"));
  frame.className = styles.opening!; frame.dataset.openingScene = "";
  frame.append(openingScene(), status);
  main.append(frame);
}
function reset() { revision++; pageLifetime.abort(); pageLifetime = new AbortController(); guest.cancelPending(); dispose?.(); dispose = undefined; main.replaceChildren(); main.hidden = false; panel.replaceChildren(); panel.className = styles.account; document.body.classList.remove(styles.chatPage!); }
async function json<T>(path: string, body?: object, channel: Channel = "team"): Promise<T> {
  const session = guest.adopt()[0];
  const lifetime = pageLifetime.signal, controller = new AbortController();
  const abort = () => controller.abort();
  let timedOut = false;
  const timeout = setTimeout(() => {timedOut = true; controller.abort();}, 30_000);
  if (lifetime.aborted) abort(); else lifetime.addEventListener("abort", abort, {once: true});
  try {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST", cache: "no-store", signal: controller.signal,
    credentials: channel === "team" ? "same-origin" : "omit",
    headers: {"X-Templ-Secure": "1", ...(body ? {"Content-Type": "application/json"} : {}),
      ...(channel === "member" && session ? {Authorization: `Bearer ${session.token}`} : {})},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
  });
  const value = await response.json() as T & {error?: string; reason?: string};
  if (!response.ok) throw Object.assign(new Error(value.error ?? "Encrypted support is unavailable. Try again."), {reason: value.reason, status: response.status});
  return value;
  } catch (error) {
    if (timedOut) throw new Error("Encrypted support is taking too long. Try again.");
    throw error;
  } finally {clearTimeout(timeout); lifetime.removeEventListener("abort", abort);}
}
const guest = createSupportClient({workspace: OWN_SUPPORT_ENDPOINT.workspace, apiUrl: "https://api.usetempl.com"}, {
  origin,
  fetch: async (url, options) => {
    const source = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
    const prefix = `/widget/${OWN_SUPPORT_ENDPOINT.workspace}`;
    if (source.origin !== "https://api.usetempl.com" || !source.pathname.startsWith(prefix + "/"))
      throw new Error("The support address could not be verified.");
    const headers = new Headers(options?.headers);
    headers.set("X-Templ-Secure", "1");
    return fetch(`/native/member${source.pathname.slice(prefix.length)}${source.search}`, {...options, headers, credentials: "omit"});
  },
});
let guestPrincipal = guest.session?.principalId;
let expectedMemberAdoption: {revision: number; address: string} | undefined;
guest.onSessionChange(() => {
  const next = guest.session?.principalId;
  const expected = expectedMemberAdoption?.revision === revision && guest.session?.level === "signed" && guest.session.address === expectedMemberAdoption.address;
  if (guestPrincipal && next !== guestPrincipal && !expected) {
    reset();
    showError(new Error("Your sign-in changed. Open the chat again with the intended account."));
  }
  guestPrincipal = next;
});

async function personCheck(): Promise<string> {
  const frame = node("iframe");
  frame.title = "Confirm you are a person";
  frame.className = styles.check;
  frame.referrerPolicy = "no-referrer";
  frame.src = `https://api.usetempl.com/widget/${OWN_SUPPORT_ENDPOINT.workspace}/check?origin=${encodeURIComponent(origin)}`;
  panel.append(frame);
  return new Promise((resolve, reject) => {
    const signal = pageLifetime.signal;
    const done = (token?: string) => {
      clearTimeout(timeout); signal.removeEventListener("abort", aborted); window.removeEventListener("message", receive); frame.remove();
      if (token) resolve(token); else reject(new Error("The visitor check did not finish. Try again."));
    };
    const aborted = () => done();
    const receive = (event: MessageEvent) => {
      if (event.origin !== "https://api.usetempl.com" || event.source !== frame.contentWindow || event.data?.type !== "templ-check") return;
      if (event.data.state === "passed" && typeof event.data.token === "string" && /^[A-Za-z0-9._-]{1,2048}$/.test(event.data.token)) done(event.data.token);
      else if (["failed", "expired", "unsupported"].includes(event.data.state)) done();
    };
    const timeout = setTimeout(() => done(), 90_000);
    window.addEventListener("message", receive);
    signal.addEventListener("abort", aborted, {once: true});
  });
}
function route() {
  const value = new URLSearchParams(location.hash.slice(1));
  if (value.has("workspace") && value.get("workspace") !== OWN_SUPPORT_ENDPOINT.workspace)
    throw new Error("This support page belongs to Templ.");
  const conversation = value.get("conversation"), seq = Number(value.get("case"));
  return conversation && /^tc-[a-f0-9]{32}$/.test(conversation) && Number.isSafeInteger(seq) && seq > 0
    ? {environment: OWN_SUPPORT_ENDPOINT.environment, workspace: OWN_SUPPORT_ENDPOINT.workspace, conversation, caseSeq: seq} : undefined;
}
function draftId(account: string, ref?: E2eeCase) {
  const key = `templ:secure-draft-id:v1:${account}:${ref ? `${ref.conversation}:${ref.caseSeq}` : "member"}`;
  const found = localStorage.getItem(key);
  if (found && /^[0-9a-f-]{36}$/.test(found)) return found;
  const id = crypto.randomUUID(); localStorage.setItem(key, id); return id;
}
function wallet(): SupportWalletProvider {
  const provider = (window as Window & {ethereum?: SupportWalletProvider}).ethereum;
  if (!provider) throw new Error("Open this page with your team wallet to sign in.");
  return provider;
}
async function selectedWallet() {
  const provider = wallet();
  const accounts = await provider.request({method: "eth_accounts"});
  if (!Array.isArray(accounts) || typeof accounts[0] !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(accounts[0]))
    throw new Error("Select your team wallet first.");
  return {provider, address: accounts[0] as `0x${string}`};
}
async function approveWallet(challenge: OwnEnrollmentChallenge, expected: `0x${string}`) {
  return new Promise<{address: `0x${string}`; signature: `0x${string}`}>((resolve, reject) => {
    const signal = pageLifetime.signal;
    const box = node("section"), description = node("p", "Approve this device to read and answer Templ support cases. The wallet message grants device access and sends no transaction.");
    const finish = () => {signal.removeEventListener("abort", aborted); box.remove();};
    const aborted = () => {finish(); reject(new Error("Your sign-in changed."));};
    box.className = styles.approval;
    box.append(description, button("Approve device", async () => {
      try {
        const {provider, address} = await selectedWallet();
        if (address.toLowerCase() !== expected.toLowerCase()) throw new Error("Select the wallet you signed in with.");
        const signature = await provider.request({method: "personal_sign", params: [stringToHex(await ownWalletApprovalText(challenge)), address]});
        if (typeof signature !== "string" || !/^0x[a-fA-F0-9]{130}$/.test(signature)) throw new Error("The device approval did not finish.");
        if (signal.aborted) throw new Error("Your sign-in changed.");
        finish(); resolve({address, signature: signature as `0x${string}`});
      } catch (error) {finish(); reject(error);}
    }), button("Cancel", async () => {finish(); reject(new Error("Device approval was cancelled."));}));
    panel.append(box);
    signal.addEventListener("abort", aborted, {once: true});
  });
}
async function openChat(profile: OwnSupportEncryptionProfile, channel: Channel, principal: string,
  ref?: E2eeCase, team?: TeamConnection, offerDiagnostics = false, offerNotices = false,
  preparedKeys?: Promise<EndpointKeys | undefined>, selectedFromList = false) {
  reset();
  if (widget && channel !== "member") throw new Error("Open team support in its own tab.");
  if (inbox && (channel !== "team" || !ref || !team)) throw new Error("Choose an encrypted case from the workspace inbox.");
  document.body.classList.add(styles.chatPage!);
  panel.className = styles.chatStatus;
  openingGap();
  const composerOptions = node("div");
  composerOptions.className = styles.chatOptions;
  // Keep cancellation reachable before wallet, hashing, or device-store work.
  const close = button(widget ? "×" : channel === "team" ? "Sign out" : "Back", async () => {
    if (frameHost) {frameHost.close(); return;}
    if (channel === "team") await json("/native/team/auth/logout", {});
    if (inbox) {inboxAccess({status: 401}); return;}
    reset(); entry(profile);
  });
  if (widget) labelIcon(close, "close", "Close support");
  // A connected wallet is only a claim; only a signed session is verified.
  const you = channel === "team" ? "Templ team" : guest.session?.level === "signed" ? "Verified wallet" : "Anonymous User";
  const conversation = conversationTools(close, () => main.querySelector("textarea"), pageLifetime.signal, {title: "Templ", participants: [
    {name: "You", detail: you, initial: "Y"}, {name: "Templ AI", detail: "AI assistant", initial: "AI"}, {name: "Founder", detail: "Marco Worms", initial: "F"}],
    note: channel === "team"
      ? "Templ’s support workspace manages device approval and recovery. Templ AI can read messages when enabled."
      : "Messages are end-to-end encrypted for you and Templ’s support team. Templ AI can read them when enabled."});
  const headerActions = conversation.actions;
  panel.append(conversation.root);
  const current = revision;
  const teamWallet = team && (inbox ? (window as Window & {ethereum?: SupportWalletProvider}).ethereum : wallet());
  if (teamWallet) {
    const changed = () => {
      if (current !== revision) return;
      if (inbox) {inboxAccess({status: 401}); return;}
      reset(); entry(profile); showError(new Error("Your wallet changed. Sign in again to open the intended chat."));
    };
    const watching = watchTeamWallet(teamWallet, pageLifetime.signal, changed, team!.walletSelection);
    await watching.confirm(team!.address, () => {if (current !== revision) throw new DOMException("Navigation changed", "AbortError");});
  }
  const mapped = channel === "member" ? memberDeviceAccount(profile, principal, ref) : undefined;
  const account = mapped?.account ?? await sha256(new TextEncoder().encode(`templ:own-client:v1:${channel}:${principal}`));
  if (current !== revision) return;
  const id = mapped?.draftId ?? draftId(account, channel === "team" || selectedFromList ? ref : undefined);
  const device = await openCustomerDeviceStore(profile, account, id);
  if (current !== revision) {device.close(); return;}
  const request = channel === "member" ? guest.adopt()[1] : <T>(path: string, body?: object) =>
    json<T>(`/native/team${path}`, body === undefined ? undefined : {...body, expectedPrincipalId: principal});
  const callKeys = <T>(action: string, scope: E2eeCase, value: unknown) =>
    json<T>(`/keys/${channel}/${action}`, {case: scope, value}, channel);
  const readScope = {active: () => current === revision, signal: pageLifetime.signal};
  const recoveryCache = createOwnRecoveryCache({profile, ...readScope,
    recover: async (row, identity) => {
      const value = {certificate: identity.certificate, sequence: row.sequence,
        recordDigest: await encryptedRecordDigest(row.record), audience: row.record.scope.audience};
      return readOwnRecoveredRecord(() => callKeys("recover", caseOf(row.record.scope), value), readScope);
    }});
  // Legacy reader: a human-only choice already saved on this device still
  // opens its new case with AI off. Nothing writes this key any more.
  const aiEnabled = !(channel === "member" && !ref && localStorage.getItem(`templ:secure-human-only:v1:${account}:${id}`) === "yes");
  let controlsShown = false;
  let provisionalOpening: {id: string; scope: E2eeCase} | undefined;
  let prepareDraft: ((text: string, append?: boolean) => Promise<boolean>) | undefined;
  let runIdentity: ((transition: () => Promise<void>) => Promise<boolean>) | undefined;
  const retain = (selected: E2eeCase) => {
    if (current !== revision) return;
    if (channel === "member") rememberMemberCase(profile, principal, selected, account, id);
    const hash = new URLSearchParams({
      workspace: selected.workspace, conversation: selected.conversation, case: String(selected.caseSeq),
    });
    if (location.hash !== `#${hash}`)
      history.replaceState(null, "", `${location.pathname}${location.search}#${hash}`);
  };
  const list = channel === "member" ? memberConversations({
    workspace: profile.workspace,
    menu: conversation.menu,
    trigger: conversation.menuTrigger,
    actions: headerActions,
    principal: () => guest.session?.principalId,
    selected: () => ref?.conversation,
    active: () => current === revision && !document.hidden,
    load: async cursor => {
      const result = await request<TeamConversationList>(memberConversationsPath(cursor));
      return {...result, conversations: result.conversations.filter(row => row.encryption?.custody === "templ-own-support")};
    },
    open: async row => {
      if (row.id === ref?.conversation) return true;
      if (!row.encryption) return false;
      const selected = caseOf({environment: profile.environment, workspace: profile.workspace,
        conversation: row.id, caseSeq: row.encryption.caseSeq});
      return await runIdentity?.(() => openChat(profile, channel, principal, selected, undefined,
        offerDiagnostics, offerNotices, undefined, true)) ?? false;
    },
    focusChat: () => main.querySelector("textarea")?.focus(),
  }) : undefined;
  let separate: HTMLButtonElement | undefined;
  const notices = node("section"); notices.className = styles.notices; notices.hidden = true;
  notices.setAttribute("role", "region"); notices.setAttribute("aria-label", "Follow-up options");
  let notificationOpen = false;
  const sharingHost = node("div"), sharingActions = node("div");
  const share = button("Share details", async () => {
    if (current !== revision) return;
    contact?.dismiss(); notificationOpen = false;
    const back = button("Back to chat", async () => {contact?.dismiss(); notices.replaceChildren(); notices.hidden = true; main.querySelector("textarea")?.focus();});
    const heading = node("header"); heading.className = styles.followupHead;
    heading.append(node("strong", "Share details"), back);
    notices.replaceChildren(heading, node("p", "Choose what to share."), sharingHost, sharingActions);
    if (intake) notices.append(intake.element);
    notices.hidden = false;
    // Show every optional choice at once. Expanding reads local values only; nothing is ticked.
    sharingHost.querySelector<HTMLButtonElement>('[aria-label="Expand sharing choices"]')?.click();
    back.focus();
  });
  share.disabled = true;
  if (channel === "member") headerActions.append(share);
  if (channel === "member") {
    separate = labelIcon(button("New", async () => {
      contact?.dismiss(); notificationOpen = false; notices.hidden = false;
      separateRequest(profile, notices, () => {notices.replaceChildren(); notices.hidden = true; main.querySelector("textarea")?.focus();});
    }), "new", "Start a separate request");
    separate.textContent = "New conversation";
    separate.disabled = true;
    headerActions.append(separate);
  }
  const contactStatus = node("p"); contactStatus.setAttribute("role", "status"); contactStatus.className = styles.caseStatus;
  const contactStore = channel === "member" ? await openCustomerDeviceStore(profile, account, draftId(`${account}:contact`)) : undefined;
  if (current !== revision) {contactStore?.close(); device.close(); recoveryCache.close(); return;}
  const contact = contactStore ? ownContactChoice({store: contactStore, active: () => current === revision,
    request, scope: () => ref, status: contactStatus, prepare: (text, append) => prepareDraft?.(text, append) ?? Promise.resolve(false)}) : undefined;
  if (contact) composerOptions.append(contactStatus);
  const notify = button("Notify me", async () => {
    if (current !== revision) return;
    const closeNotice = () => {contact?.dismiss(); notificationOpen = false; notices.replaceChildren(); notices.hidden = true; main.querySelector("textarea")?.focus();};
    if (!notices.hidden && notificationOpen) {closeNotice(); return;}
    notificationOpen = true;
    notices.hidden = false;
    await contact?.review(notices, closeNotice);
    if (ref && offerNotices && current === revision) notices.append(button("Reply notices", async () => {
      notices.replaceChildren(node("strong", "Email reply notices"), button("Cancel", async () => closeNotice()));
      await emailNotices(ref!, current, notices);
    }));
  });
  notify.textContent = "Email replies"; notify.setAttribute("aria-label", "Notify me");
  if (channel === "member") sharingActions.append(notify);
  // Reply notices only; contact details stay in the sharing panel above.
  const answered = channel === "member" && offerNotices ? button("Notify me when answered", async () => {
    if (current !== revision) return;
    contact?.dismiss(); notificationOpen = false;
    const back = button("Back to chat", async () => {notices.replaceChildren(); notices.hidden = true; main.querySelector("textarea")?.focus();});
    const heading = node("header"); heading.className = styles.followupHead;
    heading.append(node("strong", "Notify me when answered"), back);
    notices.replaceChildren(heading); notices.hidden = false; back.focus();
    const scope = provisionalOpening ? undefined : ref;
    if (!scope) {notices.append(node("p", "Send your message first. Then you can turn on email notices for this chat.")); return;}
    await emailNotices(scope, current, notices);
  }) : undefined;
  if (answered) {answered.disabled = true; headerActions.append(answered);}
  const verify = labelIcon(button("Verify wallet", async () => {
    if (current !== revision) return;
    contact?.dismiss(); notificationOpen = false; notices.hidden = false;
    const cancel = button("Cancel", async () => {notices.replaceChildren(); notices.hidden = true; main.querySelector("textarea")?.focus();});
    notices.replaceChildren(node("strong", "Verify your wallet"), cancel,
      node("p", "This shares your wallet identity with Templ support and links this chat to it. It sends no transaction. Your approved device is still needed to read encrypted messages."),
      button(widget ? "Continue in secure tab" : "Continue", async () => {
        const started = await runIdentity?.(async () => {
          prepareMemberWallet(profile, {account, draftId: id, from: principal, ...(ref ? {ref} : {})});
          showMemberWallet(profile);
        });
        if (!started && current === revision) notices.append(node("p", "Finish connecting or checking the pending send before verifying your wallet."));
      }));
  }), "wallet", guest.session?.level === "signed" ? "Wallet verified" : "Verify wallet");
  verify.textContent = guest.session?.level === "signed" ? "Wallet verified" : "Verify wallet";
  verify.disabled = true;
  if (channel === "member") sharingActions.insertBefore(verify, notify);
  const intake = channel === "member" ? ownIntake(widget?.intent) : undefined;
  let cleanup: () => void;
  try {cleanup = await mountCustomerSupport(main, {
    profile, pinnedRoot: __OWN_ROOT_KEY__, account, draftId: id, teamName: "Templ", team: channel === "team",
    ownPresentation: {headerActions: conversation.root, composerOptions, sendIcon: () => domIcon("send"), activityIcon: () => domIcon("lock"), openingScene, sendMotion, initialText: openingText(widget?.intent), noticeArea: channel === "member" ? notices : undefined, hideHistoryTools: Boolean(widget),
      deliveryIcon: state => domIcon(state === "sending" ? "clock" : "check"),
      welcome: channel === "member" ? {title: "Welcome to Templ", body: "Get help with Templ or adding support to your app."}
        : {title: "No messages yet", body: "Messages in this case appear here."},
      ...(channel === "member" ? {sharingHost} : {}),
      onSendIntent: id => {
        notify.disabled = true; share.disabled = true; if (answered) answered.disabled = true;
        verify.disabled = true; if (separate) separate.disabled = true;
        return contact?.sendIntent(id);
      },
      onAccepted: (scope, id) => {
        if (provisionalOpening?.id === id && JSON.stringify(provisionalOpening.scope) === JSON.stringify(scope))
          provisionalOpening = undefined;
        contact?.accepted(scope, id);
        if (channel === "member") retain(scope);
      },
      onUnsent: id => {
        // The attempt has no saved envelope, or its saved opening was
        // authoritatively fenced. A prepared opening is not an existing case.
        if (provisionalOpening?.id === id && ref === provisionalOpening.scope) {
          ref = undefined;
          provisionalOpening = undefined;
        }
        contact?.unsent(id);
      },
      onComposeUnlocked: () => {share.disabled = false; notify.disabled = false; if (answered) answered.disabled = false; verify.disabled = guest.session?.level === "signed"; if (separate) separate.disabled = false;},
      // Local choices open with the draft; the view keeps them locked during a send or unconfirmed outcome.
      onComposerReady: prepare => {
        prepareDraft = prepare; intake?.ready(prepare); share.disabled = false; if (separate) separate.disabled = false;
        void list?.refresh();
      },
      onIdentityReady: run => {runIdentity = run;},
      detailChoices: offerDiagnostics && channel === "member" ? SUPPORT_DIAGNOSTIC_FIELDS.map(field => ({field, label: APP_LABELS[field]})) : undefined},
    get existing() {return Boolean(ref) && !provisionalOpening;},
    sessionRevision: () => revision, signal: pageLifetime.signal, initialHistoryPageSize: 4, minimumHistoryValidityMs: OWN_SUPPORT_READ_WINDOW_MS, preparedKeys,
    onHistoryRead: (conversationId, at) => { list?.read(conversationId, at); void list?.refresh(); },
    onHistoryError: inbox ? error => {
      const access = error as {status?: number; reason?: string};
      if (access.status === 401 || access.status === 403) inboxAccess(error);
    } : undefined,
    onRetainedCase: () => {
      if (ref) retain(ref);
      // Staff keep the back-office AI controls. Members simply keep talking in the chat.
      if (channel === "team" && ref && !controlsShown && current === revision) {
        controlsShown = true;
        void caseControls(ref, principal, current, headerActions).catch(error => {controlsShown = false; if (current === revision) showError(error);});
      }
    },
    ...(offerDiagnostics && channel === "member" ? {details: () => Object.entries(diagnostics()).map(([field, value]) => ({
      field: field as keyof SupportAppContextInput, label: APP_LABELS[field as keyof typeof APP_LABELS], value,
      displayValue: appValue(field as keyof typeof APP_LABELS, {[field]: value} as SupportAppContext),
    }))} : {}),
    connect: async (keys, openingId, pending) => {
      const freshOpeningId = !pending && !ref ? openingId : undefined;
      const connected = await connectCustomerCase({profile, pinnedRoot: __OWN_ROOT_KEY__, principal, account,
        revision: () => revision, keys, kind: channel === "team" ? "team" : "member", request, historyConcurrency: 2,
        outbox: device, ...(pending ? {pending} : ref ? {existing: ref} : {}), openingId,
        ...(channel === "member" && !ref && !aiEnabled ? {initialAiMode: "off" as const} : {}),
        issueCertificate: async value => {
          const challenge = await callKeys<OwnEnrollmentChallenge>("challenge", value.case, {
            encryptionKey: value.encryptionKey, signingKey: value.signingKey,
          });
          const possession = base64url(new Uint8Array(await crypto.subtle.sign({name: "ECDSA", hash: "SHA-256"}, keys.signing.privateKey, ownEnrollmentBytes(challenge))));
          try {return await callKeys<EndpointCertificate>("enroll", value.case, {challenge: challenge.id, possession});}
          catch (error) {
            if (current !== revision || (error as {reason?: string}).reason !== "device-approval-required") throw error;
            if (inbox) throw error;
            const approval = team ? {walletApproval: await approveWallet(challenge, team.address)} :
              {deviceApproval: await requestDeviceApproval(panel, challenge, pageLifetime.signal)};
            if (current !== revision) throw new Error("Your sign-in changed.");
            return callKeys<EndpointCertificate>("enroll", value.case, {challenge: challenge.id, possession, ...approval});
          }
        },
        validate: (record) => callKeys("validate", caseOf(record.scope), record),
        recover: recoveryCache.recover,
      });
      if (current !== revision) throw new Error("Your sign-in changed.");
      ref = connected.transport.case;
      provisionalOpening = connected.opening && pending?.reservation === connected.opening &&
        JSON.stringify(caseOf(pending.record.scope)) === JSON.stringify(ref)
        ? {id: pending.record.id, scope: ref}
        : freshOpeningId !== undefined && connected.opening ? {id: freshOpeningId, scope: ref} : undefined;
      await contact?.bindCase(ref);
      if (current !== revision) throw new Error("Your sign-in changed.");
      return connected;
    },
  });} catch (error) {
    recoveryCache.close(); device.close(); contact?.close();
    if (current === revision) {
      if (inbox) { inboxAccess(error); return; }
      showError(error);
      if (!widget) panel.prepend(close);
      panel.append(button("Try again", async () => {
        if (current !== revision || pageLifetime.signal.aborted) return;
        await openChat(profile, channel, principal, ref, team, offerDiagnostics, offerNotices, undefined, selectedFromList);
      }));
    }
    return;
  }
  if (current !== revision) {cleanup(); recoveryCache.close(); device.close(); contact?.close(); return;}
  dispose = () => {cleanup(); recoveryCache.close(); device.close(); contact?.close();};
}

function inboxAccess(error: unknown) {
  reset();
  document.body.classList.add(styles.inboxPage!);
  const access = error as {status?: number; reason?: string};
  const approve = access.reason === "device-approval-required";
  const signIn = access.status === 401;
  const message = node("p", approve ? "Approve this device with your team wallet to read this case."
    : signIn ? "Sign in on Templ’s secure support page with the account you use in this inbox."
    : "This device could not open the case. Check your workspace access and device approval.");
  message.setAttribute("role", "status");
  const link = node("a", approve ? "Approve device" : signIn ? "Team sign in" : "Check device access");
  link.href = `${origin}/${location.hash}`;
  link.target = "_blank"; link.rel = "noopener noreferrer";
  panel.replaceChildren(node("h1", "Encrypted case"), message, link, button("Reload case", async () => location.reload()));
}

async function inboxCase(profile: OwnSupportEncryptionProfile) {
  document.body.classList.add(styles.inboxPage!, styles.chatPage!);
  panel.className = styles.chatStatus;
  openingGap();
  const ref = route();
  const routeParams = new URLSearchParams(location.hash.slice(1));
  const expected = routeParams.get("principal");
  const keys = [...routeParams.keys()];
  if (!ref || !expected || expected.length > 256 || keys.length !== 4 || new Set(keys).size !== 4)
    throw new Error("Choose an encrypted case from the workspace inbox.");
  const session = checkedTeamSession(await json<TeamSession>("/native/team/auth/session"));
  if (session.principalId !== expected)
    throw Object.assign(new Error("Sign in with your inbox account."), {status: 401});
  await openChat(profile, "team", session.principalId, ref, session);
}
/** Staff AI controls for one case. Member views show none of this state. */
async function caseControls(ref: E2eeCase, principal: string, current: number, tools: HTMLElement) {
  const request = <T>(path: string, body?: object) =>
    json<T>(`/native/team${path}`, body === undefined ? undefined : {...body, expectedPrincipalId: principal});
  const box = node("section"), status = node("p");
  box.className = styles.caseActions; status.setAttribute("role", "status");
  status.className = styles.aiStatus;
  let flight: Promise<void> | undefined;
  let previous = "";
  let readRevision = 0, mutating = false;
  const read = async () => {
    const selectedRead = ++readRevision;
    const control = await request<{caseSeq: number; mode: string; state: string; handoff: string | null; stopped: boolean}>(
      `/conversations/${ref.conversation}/encryption/${ref.caseSeq}/control`);
    if (current !== revision || selectedRead !== readRevision) return;
    if (control.caseSeq !== ref.caseSeq) throw new Error("The case changed. Open it again.");
    const snapshot = JSON.stringify(control);
    if (snapshot === previous) return;
    previous = snapshot;
    status.textContent = control.handoff ? "Team requested" : control.mode === "off" ? "Templ AI paused"
      : control.mode === "drafts" ? "Team replies" : "Templ AI";
    box.replaceChildren();
    if (control.state !== "open" || control.stopped) return;
    const update = async (mode: string, takeOver?: boolean) => {
      if (mutating || current !== revision) return;
      mutating = true; readRevision++;
      for (const control of box.querySelectorAll("button")) control.disabled = true;
      try {
        await request(`/conversations/${ref.conversation}/workflow`,
          {action: "ai-mode", mode, expectedCaseSeq: ref.caseSeq, ...(takeOver ? {takeOver: true} : {})});
        if (current === revision) {previous = ""; await read();}
      } finally {
        mutating = false;
        for (const control of box.querySelectorAll("button")) control.disabled = false;
      }
    };
    box.append(button("Take over", () => update("drafts", true)), button("AI off", () => update("off")), button("AI drafts only", () => update("drafts")),
      button("AI answers", () => update("answers")));
  };
  await read();
  if (current !== revision) return;
  tools.prepend(status, box);
  const signal = pageLifetime.signal;
  const interval = setInterval(() => {
    if (current !== revision || flight || mutating) return;
    const expectedRead = readRevision + 1;
    flight = read().catch(() => {if (current === revision && expectedRead === readRevision) {previous = ""; status.textContent = "Chat controls could not refresh."; box.replaceChildren();}}).finally(() => {flight = undefined;});
  }, 10_000);
  signal.addEventListener("abort", () => clearInterval(interval), {once: true});
}
async function emailNotices(ref: E2eeCase, current: number, box: HTMLElement) {
  const request = guest.adopt()[1], path = `/conversations/${ref.conversation}/guest-email`;
  type State = {enabled: boolean; pending: boolean};
  const body = node("div"); body.className = styles.noticeBody;
  body.append(node("p", "Checking reply notices…")); box.append(body);
  let state = await request<State>(path);
  if (revision !== current) return;
  const render = () => {
    if (revision !== current) return;
    body.replaceChildren(node("p", "Templ uses this email only for reply notices and a return link. Message text stays in the encrypted chat. A new device needs key approval."));
    if (state.enabled) body.append(node("p", "Email notices: on"), button("Turn off email notices", async () => {
      state = await request<State>(path, {enabled: false}); render();
    }));
    else if (state.pending) body.append(node("p", "Open the confirmation link in your email."));
    else {
      const label = node("label", "Email address"), input = node("input"); input.type = "email"; input.autocomplete = "email"; input.required = true; label.append(input);
      body.append(label, button("Send confirmation link", async () => {
        if (!input.reportValidity()) return;
        state = await request<State>(path, {email: input.value.trim(), path: "/"}); input.value = ""; render();
      }));
    }
  };
  render();
}
function startEntry(profile: OwnSupportEncryptionProfile) {
  reset();
  const current = revision;
  loadingChat(async () => {await member(profile);}, () => {
    if (frameHost) {frameHost.close(); return;}
    reset(); entry(profile);
  });
  return () => {if (current !== revision) throw new DOMException("Navigation changed", "AbortError");};
}
async function member(profile: OwnSupportEncryptionProfile, historyOnly = false) {
  const walletIntent = memberWalletIntent(profile);
  if (walletIntent && guest.session?.level !== "signed") {showMemberWallet(profile); return;}
  const checkIntent = startEntry(profile);
  // Generating local keys needs no enrollment, reservation or server write.
  // The view uses these only if this authenticated device has no stored keys.
  const preparedKeys = createEndpointKeys().catch(() => undefined);
  const current = <T>(request: Promise<T>) => request.catch(error => {checkIntent(); throw error;});
  const policy = await current(guest.policy()) as Awaited<ReturnType<typeof guest.policy>> & {
    guestCheck?: string; chatMode?: "encrypted" | "standard";
  };
  checkIntent();
  if (policy.minimumLevel !== "anyone") throw new Error("Guest support is unavailable. Try again later.");
  const link = /^#templ-guest=([0-9a-f-]+)\.(tc-[0-9a-f]{32})\.([0-9a-f]{64})$/.exec(location.hash);
  let restoredThread: string | undefined;
  if (link) {
    if (link[1] !== profile.workspace) throw new Error("This support link belongs to another workspace.");
    const answer = await current(guest.adopt()[1]<Parameters<typeof guest.adopt>[0] & {thread: string; credential: string; level: string}>("/auth/guest-link", {thread: link[2], token: link[3]}, true));
    checkIntent();
    if (!answer || answer.thread !== link[2] || !answer.credential || answer.level === "signed") throw new Error("This link could not open your case.");
    guest.adopt({...answer, address: ""}); restoredThread = answer.thread;
    checkIntent();
    history.replaceState(null, "", "/");
  } else {
    const existing = await current(guest.guest(true));
    checkIntent();
    if (!existing) {
      if (historyOnly) {
        replaceHistoryUnavailable();
        return;
      }
      if (!route() && policy.chatMode === "standard") {
        reset();
        const open = node("a", "Open standard chat");
        open.href = "https://usetempl.com/#support";
        if (widget) {open.target = "_blank"; open.rel = "noopener noreferrer";}
        panel.replaceChildren(node("h1", "Templ support"),
          node("p", "New chats use standard support."), open);
        return;
      }
      const check = policy.guestCheck === "turnstile" ? await current(personCheck()) : undefined;
      checkIntent();
      await current(guest.guest(false, false, check));
      checkIntent();
    }
  }
  const session = guest.session;
  if (!session) throw new Error("The guest chat could not start.");
  const existing = route();
  // An explicit retained case is authoritative even when it is resolved or
  // archived. The encrypted transport verifies its descriptor and access.
  if (existing) return openChat(profile, "member", session.principalId, existing, undefined, policy.diagnostics === true, policy.replyEmail === true, preparedKeys);
  const list = await current(guest.adopt()[1]<TeamConversationList>("/conversations?filter=all"));
  checkIntent();
  const selected = list.conversations.find(item => item.encryption?.custody === "templ-own-support" && (!restoredThread || item.id === restoredThread));
  if (restoredThread && !selected) throw new Error("This link has no encrypted case available. Open the original support page for an older chat.");
  if (historyOnly && !selected) {replaceHistoryUnavailable(); return;}
  await openChat(profile, "member", session.principalId, selected?.encryption ? {
    ...caseOf({environment: profile.environment, workspace: profile.workspace, conversation: selected.id, caseSeq: selected.encryption.caseSeq}),
  } : undefined, undefined, policy.diagnostics === true, policy.replyEmail === true, preparedKeys);
}
function replaceHistoryUnavailable() {
  reset();
  const home = node("a", "Back to Templ"); home.href = "https://usetempl.com/#support";
  panel.replaceChildren(node("h1", "Encrypted history"),
    node("p", "This browser has no encrypted chat available. Open the chat on your original device."), home);
}
async function team(profile: OwnSupportEncryptionProfile, setup = false) {
  if (widget) throw new Error("Open team support in its own tab.");
  const checkIntent = startEntry(profile), current = revision;
  const provider = wallet();
  const changed = () => {if (current !== revision) return; reset(); entry(profile); showError(new Error("Your wallet changed. Sign in again to open the intended chat."));};
  const watching = watchTeamWallet(provider, pageLifetime.signal, changed);
  const signedIn = await signInTeam(provider, json, checkIntent);
  checkIntent();
  const walletSelection = await watching.confirm(signedIn.address, checkIntent);
  const session: TeamConnection = {...signedIn, walletSelection};
  checkIntent();
  if (setup) {
    panel.className = styles.account;
    await showEncryptionSetup({panel, profile, principal: session.principalId, signal: pageLifetime.signal, request: json,
      back: () => {reset(); entry(profile);}});
    return;
  }
  const selected = route();
  if (selected) return openChat(profile, "team", session.principalId, selected, session);
  const list = await json<TeamConversationList>("/native/team/conversations?filter=all");
  checkIntent();
  const rows = list.conversations.filter(item => item.encryption?.custody === "templ-own-support");
  panel.replaceChildren(node("h1", "Encrypted cases"));
  const listRevision = revision;
  // Native permission decides whether setup is offered; being a Templ operator
  // or having ordinary team access does not grant workspace administration.
  const setupResponse = await fetch("/native/team/conversations/encryption/setup", {cache: "no-store", credentials: "same-origin",
    signal: pageLifetime.signal, headers: {"X-Templ-Secure": "1"}});
  checkIntent();
  if (setupResponse.ok) panel.append(button("Encryption setup", async () => {
    await showEncryptionSetup({panel, profile, principal: session.principalId, signal: pageLifetime.signal, request: json,
      back: () => {reset(); entry(profile);}});
  }));
  await setupResponse.body?.cancel();
  if (!rows.length) panel.append(node("p", "There are no encrypted cases to open."));
  rows.forEach((item, index) => panel.append(button(`Open case ${index + 1}`, () => openChat(profile, "team", session.principalId,
    {environment: profile.environment, workspace: profile.workspace, conversation: item.id, caseSeq: item.encryption!.caseSeq}, session))));
  let cursor = list.nextCursor, count = rows.length;
  if (cursor) {
    const more = button("More cases", async () => {
      const next = await json<TeamConversationList>(`/native/team/conversations?filter=all&cursor=${encodeURIComponent(cursor!)}`);
      if (listRevision !== revision) return;
      for (const item of next.conversations.filter(item => item.encryption?.custody === "templ-own-support"))
        more.before(button(`Open case ${++count}`, () => openChat(profile, "team", session.principalId,
          {environment: profile.environment, workspace: profile.workspace, conversation: item.id, caseSeq: item.encryption!.caseSeq}, session)));
      cursor = next.nextCursor;
      if (!cursor) more.remove();
    });
    panel.append(more);
  }
}
function entry(profile: OwnSupportEncryptionProfile) {
  if (widget) {void member(profile).catch(showError); return;}
  panel.className = styles.account;
  panel.replaceChildren(node("h1", "Templ support"), node("p", "You can ask a question without sharing a wallet or email."),
    button("Continue anonymously", () => member(profile)), button("Team sign in", () => team(profile)));
  if (guest.session) panel.append(button("Start a separate request", async () => separateRequest(profile)));
}
function showMemberWallet(profile: OwnSupportEncryptionProfile) {
  reset();
  const current = revision, intent = memberWalletIntent(profile);
  if (!intent) {entry(profile); return;}
  const check = () => {if (current !== revision || pageLifetime.signal.aborted) throw new DOMException("Navigation changed", "AbortError");};
  const details = node("p", "Verify the same wallet to open your chat. Signing does not recover encryption keys; this browser must still have its approved device.");
  panel.replaceChildren(node("h1", "Verify your wallet"), details);
  if (widget) {
    const link = node("a", "Open secure support"); link.href = `${origin}/#verify-wallet`; link.target = "_blank"; link.rel = "noopener noreferrer";
    link.onclick = () => frameHost?.close();
    panel.append(link, button("Close", async () => {frameHost?.close();}));
    if (intent.phase === "prepared") panel.append(button("Cancel", async () => {forgetMemberWallet(profile); await member(profile);}));
    return;
  }
  let flight = false;
  const cancel = button("Cancel", async () => {forgetMemberWallet(profile); await member(profile);});
  cancel.hidden = intent.phase !== "prepared";
  const sign = async (network: "evm" | "solana") => {
    if (flight) return; flight = true;
    for (const action of panel.querySelectorAll("button")) action.disabled = true;
    try {
      await guest.policy(); check();
      await guest.guest(true); check();
      if (guest.session && guest.session.level !== "signed" && guest.session.principalId !== intent.from)
        throw new Error("This browser is now using another chat. Open the original chat to verify its wallet.");
      // A restored device must have no uncertain envelope before ownership
      // changes. This is repeated after returning from the compact widget.
      const store = await openCustomerDeviceStore(profile, intent.account, intent.draftId);
      try {if ((await store.pending()).length) throw new Error("Check the pending message in the original chat before verifying your wallet.");}
      finally {store.close();}
      check();
      const verified = await verifyMemberWallet(profile, guest, network, check, address => {expectedMemberAdoption = {revision: current, address};});
      check(); expectedMemberAdoption = undefined;
      if (verified.existing) {
        const existing = verified.existing;
        const saved = await openCustomerDeviceStore(profile, intent.account, intent.draftId);
        let draft: {v?: number; text?: string; purpose?: string; audience?: string} | undefined;
        try {draft = await saved.draft() as typeof draft;} finally {saved.close();}
        check();
        panel.replaceChildren(node("h1", "This wallet has a chat"), node("p", "Your unsent anonymous draft stays saved on this device. Opening the existing chat does not send or copy that draft. Its approved device is still required."),
          button("Open existing chat", async () => {
            check(); history.replaceState(null, "", `/#workspace=${existing.workspace}&conversation=${existing.conversation}&case=${existing.caseSeq}`);
            await member(profile);
          }));
        if (draft?.v === 1 && draft.purpose === "member-message" && draft.audience === "conversation" && typeof draft.text === "string") {
          const label = node("label", "Unsent anonymous draft"), text = node("textarea"); text.readOnly = true; text.value = draft.text; label.append(text); panel.append(label);
        }
        return;
      }
      history.replaceState(null, "", intent.ref ? `/#workspace=${intent.ref.workspace}&conversation=${intent.ref.conversation}&case=${intent.ref.caseSeq}` : "/");
      await member(profile);
    } finally {
      expectedMemberAdoption = undefined; flight = false;
      if (current === revision) {
        for (const action of panel.querySelectorAll("button")) action.disabled = false;
        cancel.hidden = memberWalletIntent(profile)?.phase !== "prepared";
      }
    }
  };
  panel.append(button("Verify EVM wallet", () => sign("evm")), button("Verify Solana wallet", () => sign("solana")));
  panel.append(cancel);
}
function separateRequest(profile: OwnSupportEncryptionProfile, inline?: HTMLElement, back?: () => void) {
  if (!inline) reset();
  const target = inline ?? panel;
  target.replaceChildren();
  const cancel = button("Cancel", async () => {
    if (inline) back?.();
    else {reset(); entry(profile);}
  });
  target.append(node(inline ? "strong" : "h1", "Start a separate request?"),
    node("p", "This signs out of this anonymous chat and creates a new identity. It does not recover the old chat. Keep an approved device or your email return link if you want to return to it."),
    button("Create a new anonymous request", async () => {
      // Once sign-out starts, Cancel must not expose the previous identity again.
      cancel.disabled = true;
      const current = revision;
      guestPrincipal = undefined;
      await guest.signOut(true);
      if (revision !== current) return;
      forgetMemberWallet(profile);
      const clean = new URL(location.href); clean.hash = "";
      if (widget) {widget.intent = "support"; clean.searchParams.set("intent", "support");}
      history.replaceState(null, "", clean.pathname + clean.search);
      await member(profile);
    }), cancel);
}
async function showFragment(profile: OwnSupportEncryptionProfile) {
  if (widget) {
    document.body.classList.add(styles.widgetPage!);
    widgetNavigation(new URL(location.href));
    await member(profile);
    return;
  }
  const approval = /^#approve=([A-Za-z0-9_-]{1,8192})$/.exec(location.hash);
  if (location.hash === "#verify-wallet") {showMemberWallet(profile); return;}
  if (location.hash === "#encrypted-history") {await member(profile, true); return;}
  if (location.hash === "#encryption-setup") {
    reset();
    panel.replaceChildren(node("h1", "Encryption setup"), button("Team sign in", () => team(profile, true)));
    return;
  }
  reset(); route(); entry(profile);
  if (approval) {
    // Remove public device metadata from the address after reading it.
    history.replaceState(null, "", "/");
    const current = revision;
    try {await showDeviceApproval(panel, profile, approval[1], pageLifetime.signal);}
    catch (error) {if (current === revision) showError(error);}
  }
}
void (async () => {
  if (location.origin !== origin) throw new Error("Open the verified Templ support page.");
  if (widget) {
    document.body.classList.add(styles.widgetPage!);
    loadingChat(async () => location.reload());
    frameHost = await connectWidgetFrame();
    const dismiss = button("×", async () => {frameHost?.close();});
    dismiss.setAttribute("aria-label", "Close support"); dismiss.className = styles.entryClose;
    document.querySelector("header[aria-label='Templ']")?.append(dismiss);
    for (const link of document.querySelectorAll<HTMLAnchorElement>("header a, footer a")) {
      link.target = "_blank"; link.rel = "noopener noreferrer";
    }
    frameHost.ready();
    window.addEventListener("keydown", event => {if (event.key === "Escape") frameHost?.close();});
  } else if (!inbox && window.parent !== window) throw new Error("Open this support page in its own tab.");
  const response = await fetch("/profile", {cache: "no-store", credentials: "omit"});
  if (!response.ok) throw new Error("Encrypted support is unavailable. Try again later.");
  const profile = await verifyEncryptionProfile(await response.json(), __OWN_ROOT_KEY__);
  if (profile.custody !== "templ-own-support") throw new Error("The support profile could not be verified.");
  if (inbox) {await inboxCase(profile); return;}
  window.addEventListener("storage", event => {
    if (event.key === `templ:own-wallet-intent:v1:${profile.workspace}:${profile.rootKey}`) {
      try {if (memberWalletIntent(profile)) showMemberWallet(profile); else {reset(); entry(profile);}}
      catch (error) {reset(); showError(error);}
    }
  });
  window.addEventListener("hashchange", () => {void showFragment(profile).catch(showError);});
  await showFragment(profile);
})().catch(error => {if (inbox) inboxAccess(error); else showError(error);});

function openingText(intent?: string) {
  // Fixed navigation intents never carry parent-page data into a chat.
  // Drafts already saved on this device take precedence and Send is required.
  const prompts: Record<string, string> = {
    quote: "I’d like a custom pricing quote.",
    "app-approval": "I’d like to add Templ to my app.",
    "app-services": "I’d like to discuss support for my app.",
    privacy: "I have a privacy question about my data.",
    legal: "I have a legal question for Templ.",
    security: "I want to report a security problem to Templ.",
    feedback: "I’d like to share private feedback about Templ.",
  };
  return intent ? prompts[intent] : undefined;
}
