/** A complete text client mounted by the customer's authenticated app.
 * Serve this bundle and its stylesheet from profile.clientOrigin only. */
import {
  SUPPORT_APP_FIELDS,
  type SupportAppContextInput,
} from "@templ/chat/support-app-context";
import { createEndpointKeys, type EndpointKeys } from "./client";
import { openCustomerDeviceStore } from "./device-store";
import { EncryptionProtocolError, type EncryptionProfile } from "./protocol";
import { verifyEncryptionProfile } from "./verify";
import type {
  EncryptedOutboxEntry,
  EncryptedSendPhase,
  EncryptedSupportTransport,
} from "./transport";
import styles from "./customer-view.module.css";

type SharedDetail = {field: keyof SupportAppContextInput; label: string; value: unknown; displayValue?: string};
type DeliveryState = "sending" | "unconfirmed" | "failed" | "sent";
type OutgoingMessage = {id: string; text: string; at: number; state: DeliveryState};
const sendLabels: Record<EncryptedSendPhase | "setup" | "draft", string> = {
  draft: "Saving your draft",
  setup: "Setting up your device",
  keys: "Checking chat keys",
  encrypting: "Encrypting message",
  checking: "Checking encrypted message",
  sending: "Sending encrypted message",
};

export async function mountCustomerSupport(
  root: HTMLElement,
  options: {
    profile: EncryptionProfile;
    pinnedRoot: string;
    account: string;
    /** A stable, customer-assigned draft ID for this case/composer. Keep it
     * through reloads and delivery resolution; use another ID for other cases. */
    draftId: string;
    teamName: string;
    team?: boolean;
    existing?: boolean;
    /** Own support changes presentation only. The encrypted controller,
     * storage, audiences and delivery fences remain shared. */
    ownPresentation?: {
      headerActions: HTMLElement;
      sendIcon?: () => SVGElement;
      deliveryIcon?: (state: "sending" | "sent") => SVGElement;
      /** Decorative icon for opening and history. */
      activityIcon?: () => SVGElement;
      /** Decorative motion for the first send, driven by the active phase. */
      sendMotion?: () => SVGElement;
      composerOptions: HTMLElement;
      /** Own's contextual panel keeps optional fields out of the opening chat. */
      sharingHost?: HTMLElement;
      initialText?: string;
      detailChoices?: Pick<SharedDetail, "field" | "label">[];
      intake?: HTMLElement;
      noticeArea?: HTMLElement;
      /** Caller-owned copy for an empty conversation. */
      welcome?: {title: string; body: string};
      /** Decorative node that fills an empty conversation while it opens or
       * reads its first history. Status text stays in the chat status region. */
      openingScene?: () => HTMLElement;
      hideHistoryTools?: boolean;
      onSendIntent?: (id: string) => Promise<void> | void;
      onAccepted?: (scope: EncryptedSupportTransport["case"], id: string) => void;
      onUnsent?: (id: string) => void;
      onComposeUnlocked?: () => void;
      onIdentityReady?: (run: (transition: () => Promise<void>) => Promise<boolean>) => void;
      onComposerReady?: (prepareDraft: (text: string, append?: boolean) => Promise<boolean>) => void;
    };
    sessionRevision: () => number;
    signal?: AbortSignal;
    /** Smaller verified pages can display sooner on the first read. */
    initialHistoryPageSize?: number;
    /** Reapprove this device before a read when its certificate lacks this margin. */
    minimumHistoryValidityMs?: number;
    /** Local key generation may start before authenticating a new device. */
    preparedKeys?: Promise<EndpointKeys | undefined>;
    /** Called after an authorized read observes retained encrypted content. */
    onRetainedCase?: () => void;
    /** Only the timestamp of the latest successfully read public reply. */
    onHistoryRead?: (conversation: string, lastReplyAt: number) => void;
    onHistoryError?: (error: unknown) => void;
    /** A function reads optional browser facts only when the picker opens. */
    details?: SharedDetail[] | (() => SharedDetail[]);
    /** Runs prepare/enrollment only after Send for a new case. Customer
     * authentication and key approval must be independent of Templ. */
    connect: (
      keys: EndpointKeys,
      openingId?: string,
      pending?: EncryptedOutboxEntry,
    ) => Promise<{ transport: EncryptedSupportTransport; opening?: string }>;
  },
): Promise<() => void> {
  const revision = options.sessionRevision();
  if (options.signal?.aborted) return () => {};
  const initialPageSize = options.initialHistoryPageSize ?? 50;
  const readWindow = options.minimumHistoryValidityMs ?? 0;
  if (!Number.isSafeInteger(readWindow) || readWindow < 0 || readWindow > 30 * 60_000) throw new EncryptionProtocolError();
  if (!Number.isSafeInteger(initialPageSize) || initialPageSize < 1 || initialPageSize > 100) throw new EncryptionProtocolError();
  const profile = await verifyEncryptionProfile(
    options.profile,
    options.pinnedRoot,
  );
  const compact = options.ownPresentation;
  const deliveryIcon = options.team ? undefined : compact?.deliveryIcon;
  if (compact && profile.custody !== "templ-own-support")
    throw new EncryptionProtocolError("customer-custody-required");
  if (location.origin !== profile.clientOrigin)
    throw new EncryptionProtocolError("customer-custody-required");
  if (options.signal?.aborted || options.sessionRevision() !== revision) return () => {};
  const store = await openCustomerDeviceStore(
      profile,
      options.account,
      options.draftId,
    );
  if (options.signal?.aborted || options.sessionRevision() !== revision) {store.close(); return () => {};}
  let alive = true,
    busy = true,
    localDraftReady = false,
    reconnecting = false,
    draftBlocked = false,
    historyBlocked = Boolean(options.existing),
    historyComplete = !options.existing,
    historyLoaded = false,
    pending: { id: string; transport: EncryptedSupportTransport } | null = null;
  // Set only while this view's own send or delivery check is in flight.
  let activity: "send" | "check" | null = null;
  let sendPhase: keyof typeof sendLabels = "draft";
  let firstSendInFlight = false;
  let outgoing: OutgoingMessage | null = null;
  let restoredSendId: string | undefined;
  let timer: ReturnType<typeof setInterval> | undefined = undefined;
  let connection: Awaited<ReturnType<typeof options.connect>> | null = null;
  let devicePreparation: Promise<EndpointKeys> | undefined;
  const prepareDevice = () => {
    devicePreparation ??= (async () => {
      const keys = await store.keys() ?? await options.preparedKeys ?? await createEndpointKeys();
      if (!current()) throw new DOMException("Chat changed", "AbortError");
      return store.saveKeys(keys);
    })().catch(error => {devicePreparation = undefined; throw error;});
    return devicePreparation;
  };
  // Prepare local keys in parallel with the saved composer. Native enrollment
  // for a new case still requires Send and checks the current authorization.
  void prepareDevice().catch(() => {});
  const connect = async (openingId?: string, pending?: EncryptedOutboxEntry) => {
    const keys = await prepareDevice();
    if (!current()) throw new DOMException("Chat changed", "AbortError");
    return options.connect(keys, openingId, pending);
  };
  let readFlight: Promise<void> | null = null;
  let clearReadSnapshot: (() => void) | null = null;
  const make = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    text?: string,
  ) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const page = make("section"),
    header = make("header"),
    messages = make("div"),
    form = make("form"),
    status = make("p"),
    progress = make("p");
  page.className = `${styles.chat}${compact ? ` ${styles.compact}` : ""}`;
  header.className = styles.header;
  messages.className = styles.messages;
  form.className = styles.compose;
  status.className = styles.status;
  header.append(
    make("h1", `${options.teamName} support`),
    make(
      "p",
      profile.custody === "customer"
        ? "Only you, the support team and its security and recovery service can read this chat. Templ holds no message keys."
        : "Messages are encrypted on this page. Templ's support team and security and recovery service can read them. When AI is on, Templ's AI and its model provider can read the chat.",
    ),
    make("p", "Never share a recovery phrase or private key."),
  );
  // Compact chats keep progress, outcomes and delivery actions in one region
  // above the composer. The header bar shows opening until a real state settles.
  const chatState = make("div"), openingBar = make("span"), activityLine = make("div");
  const activityArt = make("div"), activityCopy = make("div");
  const activityText = make("span");
  const activityIcon = compact?.activityIcon?.();
  const sendMotion = compact?.sendMotion?.();
  const firstSendEstimate = make("span", "Your first encrypted send can take about a minute.");
  firstSendEstimate.className = styles.firstSendEstimate!;
  firstSendEstimate.hidden = true;
  const scene = compact?.openingScene?.();
  if (compact) {
    const logo = make("img");
    logo.src = "/templ-square.svg"; logo.alt = ""; logo.width = logo.height = 36;
    openingBar.className = styles.opening;
    openingBar.setAttribute("role", "progressbar"); openingBar.setAttribute("aria-label", "Opening chat");
    header.replaceChildren(logo, compact.headerActions, openingBar);
    chatState.className = styles.chatState;
    chatState.setAttribute("role", "region"); chatState.setAttribute("aria-label", "Chat status");
    activityLine.className = styles.activity;
    activityLine.hidden = true;
    activityCopy.className = styles.activityCopy;
    activityText.setAttribute("role", "status");
    activityCopy.append(activityText, firstSendEstimate);
    activityLine.append(activityArt, activityCopy);
  }
  if (profile.custody === "customer") header.append(make("p",
    "Your workspace manages its key backups. If all approved keys and backups are lost, Templ cannot restore this chat."));
  messages.setAttribute("role", "log");
  messages.setAttribute("aria-label", "Support messages");
  status.setAttribute("role", "status");
  progress.setAttribute("aria-live", "polite");
  const label = make("label", "Message"),
    input = make("textarea"),
    send = make("button", options.team ? "Send answer" : "Send"),
    check = make("button", "Check delivery"),
    retry = make("button", "Reconnect"),
    retrySend = make("button", "Retry"),
    editDraft = make("button", "Edit draft"),
    actions = make("div");
  input.id = `secure-message-${crypto.randomUUID()}`;
  label.htmlFor = input.id;
  input.maxLength = 4000;
  input.rows = compact ? 1 : 4;
  input.placeholder = compact ? "Message" : "";
  if (compact) label.className = styles.srOnly;
  send.type = "submit";
  const fitInput = () => {
    if (!compact) return;
    input.style.height = "0px";
    input.style.height = `${Math.min(140, Math.max(44, input.scrollHeight))}px`;
  };
  check.type = "button";
  check.hidden = true;
  retry.type = "button"; retry.hidden = true;
  retrySend.type = editDraft.type = "button";
  actions.className = styles.actions;
  actions.append(send, check, retry);
  const update = make("button", "Send update");
  update.type = "submit";
  update.value = "update";
  update.hidden = !options.team;
  actions.append(update);
  const offered = compact ? make("section") : make("details"),
    choices = make("div"),
    fields = new Map<keyof SupportAppContextInput, HTMLInputElement>();
  const previews = new Map<keyof SupportAppContextInput, HTMLElement>();
  const selectedDetails = make("div");
  selectedDetails.className = styles.sharing;
  selectedDetails.setAttribute("aria-label", "Details for next message");
  selectedDetails.hidden = true;
  let selectedState = "";
  const heldDraft = () => outgoing?.state === "failed";
  const editLocked = () => !localDraftReady || draftBlocked || Boolean(pending) || heldDraft() ||
    (compact && !options.team ? busy && !reconnecting : busy || historyBlocked);
  offered.setAttribute("aria-label", "Details to share");
  if (compact) {
    offered.className = styles.sharing;
    const caption = make("span", "Share"), expand = make("button", "Share details");
    expand.type = "button";
    expand.setAttribute("aria-label", "Expand sharing choices");
    expand.setAttribute("aria-expanded", "false");
    choices.id = `secure-sharing-${crypto.randomUUID()}`;
    expand.setAttribute("aria-controls", choices.id);
    expand.addEventListener("click", () => {
      const expanded = expand.getAttribute("aria-expanded") !== "true";
      if (expanded) loadDetails();
      expand.setAttribute("aria-expanded", String(expanded));
      expand.setAttribute("aria-label", expanded ? "Collapse sharing choices" : "Expand sharing choices");
      expand.textContent = expanded ? "Done" : "Share details";
      offered.classList.toggle(styles.expanded!, expanded);
    });
    offered.append(caption, choices, expand);
  } else offered.append(make("summary", "Choose details to share"), choices);
  const clearDetails = make("button", "Clear all");
  clearDetails.type = "button";
  offered.append(clearDetails);
  if (compact) {
    const information = make("div"); information.className = styles.sharingInformation;
    for (const [label, path] of [["Terms", "terms"], ["Report a safety issue", "safety"]]) {
      const link = make("a", label); link.href = `https://usetempl.com/${path}`; link.target = "_blank"; link.rel = "noopener noreferrer"; information.append(link);
    }
    offered.append(information);
  }
  choices.className = styles.details;
  // The visible rail starts with names only. Read local facts when the
  // visitor selects a choice or expands their values, never on opening chat.
  let details: SharedDetail[] = Array.isArray(options.details) ? options.details : (compact?.detailChoices ?? []).map(detail => ({...detail, value: undefined}));
  let detailsLoaded = typeof options.details !== "function";
  const fillDetails = () => {
  for (const detail of details) {
    if (!SUPPORT_APP_FIELDS.includes(detail.field))
      throw new EncryptionProtocolError();
    const existing = fields.get(detail.field);
    const line = existing?.parentElement ?? make("label"),
      choice = existing ?? make("input");
    choice.type = "checkbox";
    choice.disabled = editLocked();
    fields.set(detail.field, choice);
    const value = detail.value === undefined ? "Choose to read this detail" : detail.displayValue ?? (typeof detail.value === "string" ? detail.value : JSON.stringify(detail.value));
    if (compact) {
      const preview = previews.get(detail.field) ?? make("span");
      preview.textContent = value;
      preview.className = styles.detailValue; previews.set(detail.field, preview);
      line.title = `${detail.label}: ${value}`;
      choice.setAttribute("aria-label", `${detail.label}: ${value}`);
      if (!existing) line.append(choice, make("span", detail.label), preview);
    } else line.append(choice, document.createTextNode(` ${detail.label}: ${value}`));
    if (!existing) choices.append(line);
  }
  };
  fillDetails();
  function loadDetails() {
    if (detailsLoaded || typeof options.details !== "function") return;
    details = options.details(); detailsLoaded = true;
    // Keep the focused checkbox in place on its first selection. Loading a
    // local value must not detach the control under a mouse or keyboard.
    for (const [field, box] of fields) if (!details.some(detail => detail.field === field)) {
      box.parentElement?.remove(); fields.delete(field); previews.delete(field);
    }
    fillDetails();
  }
  offered.addEventListener("toggle", () => {
    if (!(offered instanceof HTMLDetailsElement) || !offered.open || detailsLoaded || typeof options.details !== "function") return;
    loadDetails();
  });
  offered.hidden = !options.details || (detailsLoaded && fields.size === 0) || options.team === true;
  const syncSelectedDetails = () => {
    if (!compact?.sharingHost) return;
    const selected = details.filter(detail => fields.get(detail.field)?.checked);
    const state = JSON.stringify(selected.map(detail => detail.field));
    if (state !== selectedState) {
      selectedState = state;
      selectedDetails.replaceChildren(make("small", "Sharing with your next message:"));
      for (const detail of selected) {
        const remove = make("button", `${detail.label} ×`);
        remove.type = "button";
        remove.setAttribute("aria-label", `Remove ${detail.label}`);
        remove.addEventListener("click", () => {
          if (!current() || editLocked()) return;
          const box = fields.get(detail.field)!;
          box.checked = false;
          box.dispatchEvent(new Event("change", {bubbles: true}));
          input.focus();
        });
        selectedDetails.append(remove);
      }
    }
    selectedDetails.hidden = selected.length === 0;
    for (const button of Array.from(selectedDetails.querySelectorAll("button"))) button.disabled = Boolean(editLocked());
  };
  const note = make("input"),
    noteLabel = make("label", "Private team note");
  note.type = "checkbox";
  noteLabel.prepend(note);
  noteLabel.hidden = !options.team;
  let syncDownload = () => {}, syncView = () => {};
  // Compact chats show sending and opening as motion, not helper text.
  const quiet = (text: string) => compact ? "" : text;
  const syncCompose = () => {
    const locked = busy || Boolean(pending) || draftBlocked || historyBlocked || heldDraft();
    for (const control of [send, update, note])
      control.disabled = locked;
    for (const control of [input, clearDetails, ...fields.values()]) control.disabled = editLocked();
    check.disabled = busy;
    retry.disabled = busy;
    retrySend.disabled = editDraft.disabled = busy || Boolean(pending) || draftBlocked || historyBlocked;
    if (!locked && localDraftReady) compact?.onComposeUnlocked?.();
    syncDownload();
    send.textContent = options.team
      ? note.checked
        ? "Save note"
        : "Send answer"
      : "Send";
    send.setAttribute("aria-label", send.textContent!);
    if (compact?.sendIcon && !options.team) send.replaceChildren(compact.sendIcon());
    fitInput();
    syncSelectedDetails();
    update.hidden = !options.team || note.checked;
    syncView();
  };
  syncCompose();
  const query = make("input"),
    queryLabel = make("label", "Search this case"),
    download = make("button", "Download chat");
  query.type = "search";
  query.id = `secure-search-${crypto.randomUUID()}`;
  queryLabel.htmlFor = query.id;
  download.type = "button";
  syncDownload = () => {download.disabled = busy || (compact ? !historyLoaded || historyBlocked : !historyComplete);};
  syncDownload();
  actions.append(download);
  form.append(
    queryLabel,
    query,
    label,
    input,
    noteLabel,
    offered,
    actions,
    status,
    progress,
  );
  page.append(header, messages, form);
  if (compact) {
    if (!compact.hideHistoryTools) {
      query.placeholder = "Search this chat"; queryLabel.className = styles.srOnly;
      const tools = make("div"); tools.className = styles.search;
      tools.append(queryLabel, query, download); header.after(tools);
    }
    const composeRow = make("div"); composeRow.className = styles.composeRow;
    composeRow.append(label, input, send);
    actions.replaceChildren(update);
    if (compact.sharingHost) compact.sharingHost.append(offered);
    form.replaceChildren(compact.composerOptions, compact.sharingHost ? selectedDetails : offered, composeRow, noteLabel, actions);
    chatState.append(activityLine, progress, status, check, retry);
    form.before(chatState);

    if (compact.noticeArea) messages.after(compact.noticeArea);
    if (scene) messages.after(scene);
    if (compact.intake) messages.before(compact.intake);
  }
  root.replaceChildren(page);
  let shown: {
    id: string;
    sequence: number;
    at: number;
    audience: string;
    kind: string;
    authorKind: string;
    text: string;
    context?: unknown;
  }[] = [];
  const welcome = make("div");
  welcome.className = styles.welcome;
  if (compact?.welcome) welcome.append(make("h2", compact.welcome.title), make("p", compact.welcome.body));
  // Existing connection and history flags decide the settled compact state.
  syncView = () => {
    if (!compact || !alive) return;
    const settling = !localDraftReady || reconnecting;
    const historyLoading = readFlight !== null && !historyLoaded;
    // A background retry of history that never loaded keeps the failure visible.
    const view = shown.length || outgoing ? "history" : settling || (historyLoading && !historyBlocked) ? "opening"
      : historyBlocked && (!readFlight || !historyLoaded) ? "failed" : "empty";
    const loading = activity !== "send" && (busy || reconnecting || historyLoading);
    // Each line names only the work that is running now.
    const label = activity === "send" ? sendLabels[sendPhase]
      : activity === "check" ? "Checking delivery"
      : historyLoading ? "Loading encrypted history"
      : settling ? "Opening secure chat" : "";
    page.dataset.view = view; page.dataset.loading = String(loading);
    openingBar.setAttribute("aria-hidden", String(!loading));
    openingBar.setAttribute("aria-label", label || "Updating chat");
    messages.setAttribute("aria-busy", String(view === "opening" || historyLoading));
    // The scene replaces only an empty opening view; known history and sends keep the log.
    if (scene) {scene.hidden = view !== "opening"; messages.hidden = view === "opening";}
    if (activityLine.dataset.label !== label) {
      activityLine.dataset.label = label;
      activityText.textContent = label ? `${label}…` : "";
    }
    activityLine.hidden = !label;
    const firstSend = activity === "send" && firstSendInFlight;
    firstSendEstimate.hidden = !firstSend;
    activityLine.toggleAttribute("data-first-send", firstSend);
    if (sendMotion && firstSend) {
      sendMotion.dataset.phase = sendPhase;
      if (activityArt.firstChild !== sendMotion) activityArt.replaceChildren(sendMotion);
    } else if (activityArt.firstChild !== activityIcon) {
      activityArt.replaceChildren(...(activityIcon ? [activityIcon] : []));
    }
    if (view === "empty" && compact.welcome && !query.value) {if (!welcome.isConnected) messages.append(welcome);}
    else welcome.remove();
  };
  syncView();
  function detailLines(value: unknown, depth = 0): string[] {
    if (depth > 8 || !value || typeof value !== "object") return [];
    return Object.entries(value).flatMap(([key, item]) => {
      const label = key.replace(/([a-z])([A-Z])/g, "$1 $2");
      return item && typeof item === "object"
        ? detailLines(item, depth + 1).map((line) => `${label}: ${line}`)
        : [`${label}: ${String(item)}`];
    });
  }
  function cleanupView() {
    clearInterval(timer);
    options.signal?.removeEventListener("abort", cleanupView);
    clearReadSnapshot?.(); clearReadSnapshot = null;
    alive = false; shown = []; outgoing = null; input.value = ""; page.remove(); store.close();
    compact?.sharingHost?.replaceChildren();
  }
  function current() {
    if (options.signal?.aborted) {cleanupView(); return false;}
    if (!alive) return false;
    if (options.signal?.aborted || options.sessionRevision() !== revision) {
      alive = false;
      if (timer !== undefined) clearInterval(timer);
      clearReadSnapshot?.(); clearReadSnapshot = null;
      shown = [];
      outgoing = null;
      compact?.sharingHost?.replaceChildren();
      input.value = "";
      page.replaceChildren(
        make("p", "Your sign-in changed. Open secure support again."),
      );
      store.close();
      return false;
    }
    return true;
  }
  const draw = () => {
    if (!current()) return;
    const search = query.value.toLocaleLowerCase();
    const nearEnd = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 70;
    const inHistory = outgoing && shown.some(row => row.id === outgoing?.id);
    if (outgoing?.state === "sent" && inHistory) outgoing = null;
    const rows = outgoing && !inHistory
      ? [...shown, {...outgoing, audience: "conversation", kind: "member-message", authorKind: "member", context: undefined}]
      : shown;
    if (deliveryIcon && check.parentNode !== chatState) chatState.insertBefore(check, retry);
    let previousDay = "", previousMember = false;
    messages.replaceChildren(
      ...rows
        .filter(
          (row) => !search || row.text.toLocaleLowerCase().includes(search),
        )
        .map((row) => {
          const line = make("p"),
            who =
              row.audience === "team"
                ? "Private team note"
                : row.audience === "ai-draft"
                  ? "Private AI draft"
                : row.kind === "member-message"
                  ? options.team
                    ? "Customer"
                    : "You"
                  : row.authorKind === "ai"
                    ? (compact ? "Templ AI" : "AI agent")
                    : "Support team";
          line.className = `${styles.message}${row.audience !== "conversation" ? ` ${styles.note}` : ""}${row.kind === "member-message" ? ` ${styles.member}` : ""}`;
          line.append(make("strong", who), document.createTextNode(row.text));
          if (compact) {
            const time = make("time", new Date(row.at).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"}));
            time.dateTime = new Date(row.at).toISOString();
            line.append(time);
            if (deliveryIcon && row.kind === "member-message") {
              const state = "state" in row ? row.state : "sent";
              line.dataset.delivery = state;
              if (state === "sending" || state === "sent") {
                const mark = make("span");
                mark.setAttribute("role", "img");
                mark.setAttribute("aria-label", state === "sent" ? "Sent" : "Sending");
                mark.append(deliveryIcon(state));
                const meta = make("span");
                meta.className = styles.deliveryMeta!;
                time.before(meta);
                meta.append(time, mark);
              }
              if (state === "unconfirmed" || state === "failed") {
                const controls = make("span");
                controls.className = styles.deliveryActions!;
                controls.append(...(state === "unconfirmed" ? [check] : [retrySend, editDraft]));
                line.append(controls);
              }
            }
          }
          if (row.context)
            line.append(
              make(
                "span",
                `\nShared details\n${detailLines(row.context).join("\n")}`,
              ),
            );
          if (!compact) return line;
          const date = new Date(row.at), day = date.toDateString();
          line.dataset.grouped = String(previousMember && row.kind === "member-message" && day === previousDay);
          previousMember = row.kind === "member-message";
          if (day === previousDay) return line;
          previousDay = day;
          const separator = make("div", day === new Date().toDateString() ? "Today" : date.toLocaleDateString(undefined, {month: "long", day: "numeric", year: "numeric"}));
          separator.className = styles.day!;
          return [separator, line];
        }).flat(),
    );
    syncView();
    if (compact && nearEnd) messages.scrollTop = messages.scrollHeight;
  };
  function read(): Promise<void> {
    if (!connection || !current()) return Promise.resolve();
    if (readFlight) return readFlight;
    let selected = connection;
    const audiences = options.team
      ? (profile.custody === "templ-own-support" ? ["conversation", "team", "ai-draft"] as const : ["conversation", "team"] as const)
      : (["conversation"] as const);
    const pages = new Map<string, typeof shown>(audiences.map(audience => [audience, shown.filter(row => row.audience === audience)]));
    let readingRows: typeof shown = [];
    const clearSnapshot = () => {pages.clear(); readingRows.length = 0;};
    clearReadSnapshot = clearSnapshot;
    historyComplete = false; syncDownload();
    const reportProgress = !compact || !historyLoaded || historyBlocked;
    if (reportProgress) progress.textContent = quiet("Loading encrypted history…");
    const task = (async () => {
      try {
        if (readWindow) {
          if (!Number.isSafeInteger(selected.transport.certificateExpiresAt)) throw new EncryptionProtocolError();
          if (selected.transport.certificateExpiresAt - Date.now() < readWindow) {
            // This is fresh independent enrollment, never an extension of a
            // signed certificate or a resend of an uncertain envelope.
            historyBlocked = true; syncCompose();
            progress.textContent = quiet("Checking your access…");
            const previous = selected, previousPending = pending;
            const entry = previousPending ? await store.get(previousPending.id) : undefined;
            if (!current() || connection !== previous || pending !== previousPending) return;
            if (previousPending && !entry) throw new EncryptionProtocolError("encryption-integrity");
            const refreshed = await connect(undefined, entry);
            if (!current() || connection !== previous || pending !== previousPending) return;
            if (JSON.stringify(refreshed.transport.case) !== JSON.stringify(previous.transport.case) ||
                !Number.isSafeInteger(refreshed.transport.certificateExpiresAt) ||
                refreshed.transport.certificateExpiresAt - Date.now() < readWindow)
              throw new EncryptionProtocolError("encryption-scope-changed");
            selected = connection = refreshed;
            if (previousPending) previousPending.transport = refreshed.transport;
            progress.textContent = quiet("Loading encrypted history…");
          }
        }
        let checked = 0;
        for (const audience of audiences) {
          const rows: typeof shown = readingRows = [];
          let after = 0;
          do {
            const seen = new Set<number>();
            const verified = (value: Awaited<ReturnType<EncryptedSupportTransport["history"]>>["rows"][number]) => {
              if (!current() || selected !== connection || seen.has(value.row.sequence)) return;
              seen.add(value.row.sequence);
              options.onRetainedCase?.();
              if (!current() || selected !== connection) return;
              const {row, content} = value, body = content as {text?: unknown; context?: unknown};
              if (typeof body?.text === "string" || body?.context) rows.push({
                id: row.record.id, sequence: row.sequence, at: row.acceptedAt, audience: row.record.scope.audience, kind: row.record.purpose,
                authorKind: row.record.certificate.kind,
                text: typeof body.text === "string" ? body.text : "Shared details", ...(body.context ? {context: body.context} : {}),
              });
              checked++;
              const known = new Map((pages.get(audience) ?? []).map(row => [row.sequence, row]));
              for (const row of rows) known.set(row.sequence, row);
              pages.set(audience, [...known.values()]);
              shown = [...pages.values()].flat().sort((a, b) => a.at - b.at || a.sequence - b.sequence);
              draw();
              if (reportProgress) progress.textContent = quiet(`Loading encrypted history… ${checked} messages checked.`);
            };
            const page = await selected.transport.history(after, audience, historyLoaded || after > 0 ? 50 : initialPageSize, verified);
            if (!current() || selected !== connection) return;
            // Existing adapters may ignore the optional progress callback.
            for (const value of page.rows) verified(value);
            if (!current() || selected !== connection) return;
            const complete = page.nextAfter === null;
            if (!complete && page.nextAfter! <= after) throw new EncryptionProtocolError("encryption-integrity");
            // Retain previously displayed rows while a fresh page is pending;
            // the completed audience replaces them, including native pruning.
            const known = new Map((complete ? [] : pages.get(audience) ?? []).map(row => [row.sequence, row]));
            for (const row of rows) known.set(row.sequence, row);
            pages.set(audience, [...known.values()]);
            shown = [...pages.values()].flat().sort((a, b) => a.at - b.at || a.sequence - b.sequence);
            draw();
            if (reportProgress) progress.textContent = quiet(`Loading encrypted history… ${checked} messages checked.`);
            if (complete) break;
            after = page.nextAfter!;
          } while (current());
        }
        if (!current() || selected !== connection) return;
        historyComplete = true; historyLoaded = true; historyBlocked = false;
        if (options.onHistoryRead) {
          const replies = shown.filter(row => row.audience === "conversation" && row.kind === "team-message");
          options.onHistoryRead(selected.transport.case.conversation, Math.max(0, ...replies.map(row => row.at)));
        }
        retry.hidden = true;
        progress.textContent = "";
        if (status.textContent === "Messages could not refresh. Check your access and try again.") status.textContent = "";
      } catch (error) {
        if (current() && selected === connection) {
          historyBlocked = true; historyComplete = false; shown = [];
          if (outgoing?.state === "sent") outgoing = null;
          draw();
          progress.textContent = "History could not load. Check your access and try again.";
          if (compact && !options.team) retry.hidden = false;
          options.onHistoryError?.(error);
        }
        throw error;
      } finally {
        if (clearReadSnapshot === clearSnapshot) clearReadSnapshot = null;
        if (current()) syncCompose();
      }
    })();
    readFlight = task.finally(() => {readFlight = null; if (current()) syncView();});
    syncView();
    return readFlight;
  }
  const draftState = () => ({
    v: 1,
    text: input.value,
    purpose: options.team
      ? note.checked
        ? "note"
        : "team-message"
      : "member-message",
    audience: options.team && note.checked ? "team" : "conversation",
    selected: [...fields]
      .filter(([, box]) => box.checked)
      .map(([field]) => field),
  });
  const save = () =>
    store.saveDraft(draftState()).catch(() => {
      if (current())
        status.textContent =
          "Your browser could not save the encrypted draft. Keep this page open.";
    });
  input.addEventListener("input", () => {
    fitInput();
    if (current() && !editLocked()) void save();
  });
  choices.addEventListener("change", event => {
    if (current() && !editLocked()) {
      loadDetails(); syncSelectedDetails(); void save();
      // A removed selection chip must leave keyboard focus on a visible action.
      if (compact && !offered.classList.contains(styles.expanded!) &&
        event.target instanceof HTMLInputElement && !event.target.checked)
        offered.querySelector<HTMLButtonElement>("button")?.focus();
    }
  });
  clearDetails.addEventListener("click", () => {
    if (!current() || editLocked()) return;
    for (const choice of fields.values()) choice.checked = false;
    syncSelectedDetails();
    void save();
  });
  note.addEventListener("change", () => {
    syncCompose();
    if (current() && !busy && !pending && !draftBlocked) void save();
  });
  query.addEventListener("input", draw);
  if (compact) input.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (!send.disabled) form.requestSubmit(send);
    }
  });
  function showOutgoing(id: string, state: DeliveryState, text = outgoing?.text ?? input.value) {
    if (!deliveryIcon || !text) return;
    outgoing = {id, state, text, at: outgoing?.at ?? Date.now()};
    input.value = "";
    draw();
    if (state === "sending") messages.scrollTop = messages.scrollHeight;
  }
  function returnDraft() {
    if (!current() || !outgoing || !heldDraft() || editDraft.disabled) return false;
    input.value = outgoing.text;
    outgoing = null;
    restoredSendId = undefined;
    status.textContent = "";
    syncCompose(); draw();
    return true;
  }
  editDraft.addEventListener("click", () => {if (returnDraft()) input.focus();});
  retrySend.addEventListener("click", () => {if (returnDraft()) form.requestSubmit(send);});
  async function recordAcceptance(id: string, accepted: NonNullable<typeof connection>) {
    activity = null;
    if (outgoing && restoredSendId === id) showOutgoing(id, "sent");
    const sentText = input.value;
    if (!deliveryIcon || restoredSendId === undefined || restoredSendId === id) input.value = "";
    try {
      await store.settle(id, draftState());
    } catch (error) {
      input.value = sentText;
      throw error;
    }
    if (!current()) return;
    pending = null;
    restoredSendId = undefined;
    check.hidden = true;
    status.textContent = quiet("Sent.");
    accepted.opening = undefined;
    compact?.onAccepted?.(accepted.transport.case, id);
    await read();
  }
  form.addEventListener("submit", (event) => {
    if (event.target !== form) return;
    event.preventDefault();
    if (!current() || busy || pending || draftBlocked || historyBlocked || heldDraft() || !input.value.trim())
      return;
    // Capture the complete intent before any save, enrollment or network await.
    const draft = draftState();
    const privateNote = options.team === true && note.checked;
    const content: {
      text: string;
      context?: { app: Record<string, unknown> };
      contextConsent?: true;
    } = { text: input.value };
    if (!options.team)
      for (const detail of details)
        if (fields.get(detail.field)?.checked) {
          content.context ??= { app: {} };
          content.context.app[detail.field] = structuredClone(detail.value);
          content.contextConsent = true;
        }
    const sendId = crypto.randomUUID();
    let outboxId: string = sendId;
    restoredSendId = sendId;
    busy = true; activity = "send";
    sendPhase = "draft";
    firstSendInFlight = Boolean(deliveryIcon && !options.existing);
    outgoing = null;
    showOutgoing(sendId, "sending", draft.text);
    syncCompose();
    let deliveryAccepted = false;
    // Freeze local recipient choices at the same moment as the message.
    // A persistence failure still blocks all network writes.
    let prepared: Promise<void>;
    try { prepared = Promise.resolve(compact?.onSendIntent?.(sendId)); }
    catch (error) { prepared = Promise.reject(error); }
    status.textContent = quiet("Sending encrypted message…");
    const intent =
      (event as SubmitEvent).submitter === update
        ? ("update" as const)
        : ("answer" as const);
    void (async () => {
      await Promise.all([prepared, store.saveDraft(deliveryIcon ? {...draft, sendId} : draft)]);
      if (!current()) return;
      if (!connection) {
        sendPhase = "setup";
        syncView();
        connection = await connect(!options.existing ? sendId : undefined);
      }
      if (!current()) return;
      outboxId = connection.opening ?? sendId;
      if (deliveryIcon && outboxId !== sendId) {
        restoredSendId = outboxId;
        await store.saveDraft({...draft, sendId: outboxId});
        if (!current()) return;
      }
      const result = await connection.transport.send({
        content,
        purpose: privateNote
          ? "note"
          : options.team
            ? "team-message"
            : "member-message",
        audience: privateNote ? "team" : "conversation",
        opening: connection.opening,
        id: sendId,
        ...(compact ? {onPhase: (phase: EncryptedSendPhase) => {
          if (!current()) return;
          sendPhase = phase;
          syncView();
        }} : {}),
        ...(options.team && !privateNote ? { replyIntent: intent } : {}),
      });
      if (!current()) return;
      activity = null;
      if (result.state === "unknown") {
        pending = { id: result.id, transport: connection.transport };
        check.hidden = false;
        showOutgoing(result.id, "unconfirmed");
        status.textContent =
          "Delivery is unconfirmed. Check delivery before sending again.";
      } else {
        deliveryAccepted = true;
        pending = { id: result.id, transport: connection.transport };
        check.hidden = false;
        await recordAcceptance(result.id, connection);
      }
    })()
      .catch(async () => {
        if (current()) {
          // No durable envelope means this attempt never reached deliver().
          // Unknown/ready entries remain locked to their exact outcome.
          if (!deliveryAccepted && !pending) {
            try {
              const entry = await store.get(outboxId);
              if (!current()) return;
              if (entry && connection) {
                pending = {id: outboxId, transport: connection.transport};
                check.hidden = false;
                showOutgoing(outboxId, "unconfirmed");
              } else if (!entry) {
                compact?.onUnsent?.(sendId);
                showOutgoing(outboxId, "failed");
              }
            } catch {
              // A local read error cannot prove the message was never sent.
              if (current() && deliveryIcon) {
                draftBlocked = true;
                retry.hidden = false;
                showOutgoing(outboxId, "unconfirmed");
              }
            }
          }
          if (!pending && connection?.opening) connection = null;
          status.textContent =
            deliveryAccepted ? "Sent. Your chat could not refresh. Reopen it to see the latest messages." :
            pending ? "Delivery is unconfirmed. Check delivery before sending again." :
            draftBlocked && deliveryIcon ? "Delivery could not be checked. Reconnect to try again." :
            deliveryIcon ? "Message not sent." :
            "The message was not confirmed. Keep your draft and try again after the team checks its secure support service.";
        }
      })
      .finally(() => {
        busy = false; activity = null;
        if (current()) syncCompose();
      });
  });
  check.addEventListener("click", () => {
    if (!current() || !pending || busy) return;
    const unresolved = pending;
    busy = true; activity = "check";
    syncCompose();
    void (async () => {
      const settledId = unresolved.id;
      const entry = await store.get(settledId);
      if (!current()) return;
      if (!entry) throw new EncryptionProtocolError("encryption-integrity");
      // The fence authorizes this request again in the native transaction.
      // A live Own connection can resolve the saved envelope without another
      // device enrollment. A stale connection still uses the reapproval path.
      const refreshed = deliveryIcon && connection?.transport === unresolved.transport &&
        unresolved.transport.certificateExpiresAt > Date.now()
        ? connection
        : await connect(undefined, entry);
      if (!current()) return;
      connection = refreshed;
      unresolved.transport = refreshed.transport;
      const outcome = await refreshed.transport.fence(settledId);
      if (!current()) return;
      activity = null;
      if (outcome === "accepted") {
        await recordAcceptance(settledId, refreshed);
      } else {
        await store.settle(settledId, {...draftState(), text: outgoing?.text ?? input.value});
        if (!current()) return;
        pending = null;
        check.hidden = true;
        if (connection?.opening) connection = null;
        showOutgoing(settledId, "failed");
        status.textContent = outgoing ? "Message not sent." : "It was not sent. Review your draft, then send again.";
        compact?.onUnsent?.(settledId);
      }
    })()
      .catch(() => {
        if (current())
          status.textContent =
            "Delivery is still unconfirmed. Keep this page open and check again.";
      })
      .finally(() => {
        busy = false; activity = null;
        if (current()) {
          syncCompose();
        }
      });
  });
  download.addEventListener("click", () => {
    if (!current() || busy || (compact ? !historyLoaded || historyBlocked : !historyComplete)) return;
    busy = true;
    syncCompose();
    void read()
      .then(() => {
        if (!current() || !historyComplete) return;
        const blob = new Blob(
          [
            shown
              .map(
                (row) =>
                  `${row.audience === "team" ? "Private note" : row.audience === "ai-draft" ? "Private AI draft" : row.kind === "member-message" ? "Member" : row.authorKind === "ai" ? "AI agent" : "Team"}\n${row.text}${row.context ? `\nShared details\n${detailLines(row.context).join("\n")}` : ""}`,
              )
              .join("\n\n"),
          ],
          { type: "text/plain;charset=utf-8" },
        );
        const url = URL.createObjectURL(blob),
          link = make("a");
        link.href = url;
        link.download = "support-chat.txt";
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1_000);
      })
      .catch(() => {
        if (current())
          status.textContent =
            "The download could not finish. Check your access and try again.";
      })
      .finally(() => {
        busy = false;
        if (current()) syncCompose();
      });
  });
  options.signal?.addEventListener("abort", cleanupView, {once: true});
  if (options.signal?.aborted) {cleanupView(); return () => {};}
  async function restoreConnection(unsettled: Awaited<ReturnType<typeof store.pending>>) {
    if (options.existing && current()) {
      if (!status.textContent) status.textContent = quiet("Connecting securely…");
      connection = await connect();
      if (!current()) return;
      await read();
      if (!current()) return;
    }
    if (unsettled.length) {
      const entry = unsettled.find(row => !connection || row.record.scope.conversation === connection.transport.case.conversation);
      if (entry) {
        connection = await connect(undefined, entry);
        if (current()) {
          note.checked = options.team === true && entry.record.scope.audience === "team";
          pending = {id: entry.record.id, transport: connection.transport};
          draftBlocked = false;
          check.hidden = false;
          if (restoredSendId === entry.record.id) showOutgoing(entry.record.id, "unconfirmed");
          status.textContent = "Delivery is unconfirmed. Check delivery before sending again.";
        }
      }
    } else if (deliveryIcon && draftBlocked && outgoing?.state === "unconfirmed") {
      draftBlocked = false;
      historyBlocked = false;
      showOutgoing(outgoing.id, "failed");
      status.textContent = "Message not sent.";
    }
    if (status.textContent === "Connecting securely…" ||
        status.textContent === "Your chat could not connect. Your draft stays on this device.") status.textContent = "";
  }
  const holdUnsettled = (unsettled: Awaited<ReturnType<typeof store.pending>>) => {
    if (!unsettled.length) return;
    draftBlocked = true;
    status.textContent = "An earlier send is unconfirmed. Check its delivery before starting another message.";
  };
  const connectionFailed = () => {
    if (!current()) return;
    historyBlocked = true; historyComplete = false; shown = []; draw();
    progress.textContent = "";
    if (!draftBlocked) status.textContent = "Your chat could not connect. Your draft stays on this device.";
    retry.hidden = false;
  };
  retry.addEventListener("click", () => {
    if (!current() || busy || !compact || options.team) return;
    busy = reconnecting = true; syncCompose();
    void (async () => {
      const unsettled = await store.pending();
      if (!current()) return;
      holdUnsettled(unsettled); syncCompose();
      await restoreConnection(unsettled);
      if (current()) retry.hidden = true;
    })().catch(connectionFailed).finally(() => {
      busy = reconnecting = false;
      if (current()) syncCompose();
    });
  });
  const composerReady = () => compact?.onComposerReady?.(async (text, append = false) => {
    if (!current() || editLocked() || (!append && input.value.trim()) || !text.trim()) return false;
    const next = append && input.value.trim() ? `${input.value.trimEnd()}\n\n${text}` : text;
    if (next.length > 4000) return false;
    input.value = next;
    await save();
    if (!current()) return false;
    input.focus();
    return true;
  });
  try {
  const saved = (await store.draft()) as
    | {
        v?: unknown;
        text?: unknown;
        selected?: unknown;
        purpose?: unknown;
        audience?: unknown;
        sendId?: unknown;
      }
    | undefined;
  if (!current()) return cleanupView;
  if (saved) {
    const publicDraft =
      saved.audience === "conversation" &&
      saved.purpose === (options.team ? "team-message" : "member-message");
    const privateDraft = saved.audience === "team" && saved.purpose === "note";
    const legacy =
      saved.v === undefined &&
      saved.purpose === undefined &&
      saved.audience === undefined;
    if (
      (!publicDraft && !privateDraft && !legacy) ||
      (!options.team && privateDraft)
    ) {
      draftBlocked = true;
      status.textContent =
        "This draft belongs to another support role. Open it with that role before sending.";
    } else {
      // Old team drafts lack an audience. Keep them private until the author
      // deliberately chooses a public reply; never infer that from a reload.
      note.checked = options.team === true && (privateDraft || legacy);
      if (typeof saved.text === "string") input.value = saved.text;
      if (typeof saved.sendId === "string") restoredSendId = saved.sendId;
      if (Array.isArray(saved.selected) && detailsLoaded)
        for (const [field, box] of fields)
          box.checked = saved.selected.includes(field);
      if (!detailsLoaded && Array.isArray(saved.selected) && saved.selected.length)
        status.textContent = "Your draft is saved. Choose browser details again before sharing them.";
      if (options.team && legacy && input.value)
        status.textContent =
          "Your older draft is private. Review who should receive it before sending.";
    }
  }
  // Resolve the local role and outbox before allowing any edits. A slow
  // network must not hide an earlier uncertain send or overwrite a draft.
  const unsettled = await store.pending();
  if (!current()) return cleanupView;
  holdUnsettled(unsettled);
  localDraftReady = true; reconnecting = true;
  syncCompose(); draw();
  composerReady();
  compact?.onIdentityReady?.(async transition => {
    if (!current() || busy || pending || draftBlocked || historyBlocked) return false;
    busy = true; syncCompose();
    try {
      await store.saveDraft(draftState());
      if (!current()) return false;
      const unsettled = await store.pending();
      if (!current() || unsettled.length) return false;
      await transition(); return true;
    } finally {busy = false; if (current()) syncCompose();}
  });
  try { await restoreConnection(unsettled); }
  catch (error) { if (!compact || options.team) throw error; connectionFailed(); }
  finally { reconnecting = false; }
  } catch (error) {
    cleanupView();
    throw error;
  }
  busy = false;
  if (compact?.initialText && !input.value && !pending && !draftBlocked) input.value = compact.initialText;
  if (current()) {syncCompose(); draw();}
  if (!current()) return cleanupView;
  timer = setInterval(() => {
    if (current() && !busy && !pending)
      void read().catch(() => {
        if (current())
          status.textContent =
            "Messages could not refresh. Check your access and try again.";
      });
  }, 5_000);
  return cleanupView;
}
