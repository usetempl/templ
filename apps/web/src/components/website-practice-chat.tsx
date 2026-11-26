"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CommunityApiError } from "@/lib/community-client";
import { loadTemplSupportWidget } from "@/lib/templ-support";
import { widgetMessageId } from "@/lib/support-widget-message-id";
import type { mountSupportWidget, WidgetMessage } from "@/lib/support-widget";
import styles from "./native-chat-create.module.css";

type Props = {
  name: string;
  accent?: string;
  icon: string;
  canSend: boolean;
  suggestion?: string;
  /** Keeps an unsent question in this tab while the visitor changes websites. */
  draft?: { current: string };
  ask: (question: string, requestId: string) => Promise<string>;
};

// The renderer is the versioned widget installed by customers. Its trial transport
// keeps the transcript in this tab. Only an explicit send calls the private AI trial.
function practiceTransport(workspace: string, ask: Props["ask"]) {
  const prefix = "/widget/" + workspace;
  const conversation = {
    id: "tc-" + crypto.randomUUID().replaceAll("-", ""),
    state: "open",
  };
  const visitor = "practice-visitor";
  const messages: WidgetMessage[] = [];
  const requestIds = new Map<string, string>();
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const route = url.pathname.slice(prefix.length);
    if (
      url.origin !== "https://preview.invalid" ||
      !url.pathname.startsWith(prefix + "/")
    )
      return new Response(null, { status: 404 });
    if (route === "/auth/policy")
      return Response.json({
        minimumLevel: "anyone",
        chatFirst: true,
        singleConversation: true,
        askPerson: false,
        replyEmail: false,
        aiReplyExpected: true,
        walletIdentification: { enabled: false, evm: false, solana: false },
      });
    if (route === "/conversations/status")
      return Response.json({
        mine: messages.length ? conversation.id : null,
        available: true,
        canAsk: true,
      });
    const thread = "/conversations/" + conversation.id;
    if (route === thread + "/messages" && init?.method === "GET")
      return Response.json({
        conversation,
        messages,
        nextBefore: null,
        authors: { "practice-ai": { badges: ["bot"] } },
      });
    if (
      init?.method === "POST" &&
      (route === "/conversations/ask" || route === thread + "/messages")
    ) {
      const { text, clientId } = JSON.parse(String(init.body));
      const delivered = messages.find(
        (message) => message.clientId === clientId,
      );
      if (delivered) return Response.json({ conversation, message: delivered });
      const requestId = requestIds.get(clientId) ?? crypto.randomUUID();
      requestIds.set(clientId, requestId);
      let answer: string;
      try {
        answer = await ask(text, requestId);
      } catch (reason) {
        if (!(reason instanceof CommunityApiError)) throw reason;
        // The widget deletes a draft that the service refused for holding a secret.
        const refused =
          (reason.details as { reason?: unknown } | undefined)?.reason ===
          "secret-refused";
        return Response.json(
          {
            error: reason.message,
            ...(refused ? { reason: "secret-refused" } : {}),
          },
          // A 401 would make the widget renew a guest session that practice never has.
          { status: reason.status === 401 ? 403 : reason.status },
        );
      }
      const now = new Date().toISOString();
      const message = {
        id: clientId,
        clientId,
        author: visitor,
        createdAt: now,
        text,
      };
      messages.push(message, {
        id: crypto.randomUUID(),
        author: "practice-ai",
        teamName: "Support AI",
        createdAt: now,
        text: answer,
      });
      requestIds.delete(clientId);
      return Response.json({ conversation, message });
    }
    // Additional visitor features have no customer destination in private practice.
    return new Response(null, { status: 404 });
  };
  return { transport, visitor };
}

function localIcon(data: string) {
  const parts =
    /^data:(image\/(?:png|jpeg|webp|gif|svg\+xml|x-icon|vnd\.microsoft\.icon));base64,([a-z\d+/=]+)$/i.exec(
      data,
    );
  if (!parts) return "";
  const bytes = Uint8Array.from(atob(parts[2]!), (ch) => ch.charCodeAt(0));
  return URL.createObjectURL(new Blob([bytes], { type: parts[1] }));
}

export function WebsitePracticeChat(props: Props) {
  const container = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });
  const widget = useRef<ReturnType<typeof mountSupportWidget> | undefined>(
    undefined,
  );
  const [mounted, setMounted] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [hasDraft, setHasDraft] = useState(false);
  const [asked, setAsked] = useState(false);
  const root = () =>
    container.current?.querySelector("[data-templ-support]")?.shadowRoot;
  useEffect(() => {
    const lifetime = new AbortController();
    async function open() {
      const widgetModule = await loadTemplSupportWidget();
      if (lifetime.signal.aborted || !container.current) return;
      if (!widgetModule.createSupportClient) throw new Error("Chat could not load.");
      const workspace = widgetMessageId();
      const { transport, visitor } = practiceTransport(
        workspace,
        (text, id) => {
          // The widget keeps a failed question with its own Retry and Discard.
          setAsked(true);
          const kept = latest.current.draft;
          if (kept) kept.current = "";
          return latest.current.ask(text, id);
        },
      );
      const options = {
        workspace,
        container: container.current,
        label: latest.current.name,
        apiUrl: "https://preview.invalid",
        persistDrafts: false,
        showLauncher: false,
        transactionField: false,
        chatFirst: true,
        conversationDrawers: true,
      };
      const client = widgetModule.createSupportClient(options, { fetch: transport });
      // This local identity has no credential or authority at any API.
      client.adopt({
        token: "",
        principalId: visitor,
        address: "",
        level: "anonymous",
        expiresAt: Date.now() + 86_400_000,
      });
      const chat = widgetModule.mountSupportWidget(options, undefined, {
        client,
        guest: Promise.resolve(),
      });
      widget.current = chat;
      const shadow = root();
      const draft = shadow?.querySelector("textarea");
      if (!shadow || !draft) throw new Error("Chat could not load.");
      draft.maxLength = 800;
      draft.addEventListener(
        "input",
        () => {
          setHasDraft(!!draft.value.trim());
          const kept = latest.current.draft;
          if (kept) kept.current = draft.value;
        },
        { signal: lifetime.signal },
      );
      shadow.addEventListener(
        "submit",
        (event) => {
          if (!latest.current.canSend) {
            event.preventDefault();
            event.stopImmediatePropagation();
          }
        },
        { capture: true, signal: lifetime.signal },
      );
      await chat.open(false);
      if (lifetime.signal.aborted) return;
      const kept = latest.current.draft?.current.slice(0, 800);
      if (kept?.trim()) {
        chat.setQuestion(kept);
        setHasDraft(true);
      }
      setMounted(true);
    }
    void open().catch(() => {
      if (!lifetime.signal.aborted) setFailed(true);
    });
    return () => {
      lifetime.abort();
      widget.current?.destroy();
      widget.current = undefined;
    };
  }, [retry]);
  useEffect(() => {
    if (!mounted) return;
    const shadow = root();
    const title = shadow?.querySelector(".titles strong");
    if (title) title.textContent = props.name;
    shadow?.querySelector(".panel")?.setAttribute("aria-label", props.name);
  }, [props.name, mounted]);
  useEffect(() => {
    if (!mounted) return;
    const logo = localIcon(props.icon);
    widget.current?.setAppearance({ logo, accent: props.accent });
    return () => {
      if (logo) URL.revokeObjectURL(logo);
    };
  }, [props.icon, props.accent, mounted]);
  useEffect(() => {
    const button = root()?.querySelector<HTMLButtonElement>(".send");
    if (!button) return;
    button.inert = !props.canSend;
    button.setAttribute("aria-disabled", String(!props.canSend));
    // An inert button otherwise looks ready to send.
    button.style.opacity = props.canSend ? "" : "0.5";
  }, [props.canSend, mounted]);
  function sendSuggestion() {
    if (!widget.current || !props.suggestion || !props.canSend || hasDraft)
      return;
    widget.current.setQuestion(props.suggestion);
    // The question now sits in the composer, so a second click cannot repeat it.
    setHasDraft(true);
    root()?.querySelector<HTMLFormElement>("form.form")?.requestSubmit();
  }
  return (
    <>
      <div className={styles.practiceWindow} ref={container} />
      {failed && (
        <p role="alert">
          Chat could not load.{" "}
          <button
            type="button"
            className={styles.textButton}
            onClick={() => {
              setFailed(false);
              setMounted(false);
              setHasDraft(false);
              setRetry((n) => n + 1);
            }}
          >
            Try again
          </button>
        </p>
      )}
      {mounted &&
        props.canSend &&
        props.suggestion &&
        !hasDraft &&
        !asked && (
          <button
            className={styles.suggestion}
            type="button"
            onClick={sendSuggestion}
          >
            {props.suggestion}
          </button>
        )}
    </>
  );
}
