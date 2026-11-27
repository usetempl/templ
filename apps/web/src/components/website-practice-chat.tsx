"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ActivityDots } from "./ui/ui";
import { IconSend } from "@tabler/icons-react";
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
  report?: (requestId: string, reason: string) => Promise<void>;
  scanning?: boolean;
  suggestion?: string;
  /** Keeps an unsent question in this tab while the visitor changes websites. */
  draft?: { current: string };
  ask: (
    question: string,
    requestId: string,
    onReceipt: () => void,
  ) => Promise<string | null>;
};

// The renderer is the versioned widget installed by customers. Its trial transport
// keeps the transcript in this tab. Only an explicit send calls the private AI trial.
function practiceTransport(
  workspace: string,
  ask: Props["ask"],
  reporting: () => Props["report"],
) {
  const prefix = "/widget/" + workspace;
  const conversation = {
    id: "tc-" + crypto.randomUUID().replaceAll("-", ""),
    state: "open",
    aiReplyExpected: true,
  };
  const visitor = "practice-visitor";
  const messages: WidgetMessage[] = [];
  // This transport owns its own message IDs, just like the room service.
  // Only a completed AI reply can map to a server-issued preview receipt.
  const answers = new Map<string, { requestId: string; reported: boolean }>();
  const requestIds = new Map<string, string>();
  const deliveries = new Map<string, Promise<WidgetMessage>>();
  let nextAnswer: Promise<void> | undefined;
  let resumeTyping = false;

  function deliver(text: string, clientId: string): Promise<WidgetMessage> {
    const delivered = messages.find((message) => message.clientId === clientId);
    if (delivered) return Promise.resolve(delivered);
    const pending = deliveries.get(clientId);
    if (pending) return pending;

    const requestId = requestIds.get(clientId) ?? crypto.randomUUID();
    requestIds.set(clientId, requestId);
    const delivery = new Promise<WidgetMessage>((resolve, reject) => {
      let received = false;
      const acknowledge = () => {
        if (received) return;
        received = true;
        resumeTyping = !conversation.aiReplyExpected;
        conversation.aiReplyExpected = true;
        const message = {
          id: clientId,
          clientId,
          author: visitor,
          createdAt: new Date().toISOString(),
          text,
        };
        messages.push(message);
        resolve(message);
      };
      const reportable = Boolean(reporting());
      nextAnswer = Promise.resolve().then(async () => {
        try {
          const answer = await ask(text, requestId, acknowledge);
          // An older service can confirm delivery with its completed answer.
          acknowledge();
          const id = answer && reportable ? String(answers.size + 1) : crypto.randomUUID();
          if (answer && reportable) answers.set(id, { requestId, reported: false });
          messages.push({
            id,
            author: "practice-ai",
            teamName: "Support AI",
            createdAt: new Date().toISOString(),
            text: answer || "I can’t answer that from your website or docs. In your live chat, I’d hand it to your team.",
          });
        } catch (error) {
          if (received) conversation.aiReplyExpected = false;
          else reject(error);
        } finally {
          if (received) requestIds.delete(clientId);
          deliveries.delete(clientId);
        }
      });
    });
    deliveries.set(clientId, delivery);
    return delivery;
  }
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
        // The widget can mount during the scan. Its per-answer read below
        // checks the latest server capability after the preview is ready.
        answerReports: true,
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
    if (route === thread + "/workflow") {
      const report = reporting();
      if (!report) return init?.method === "GET"
        ? Response.json({})
        : Response.json({ error: "This answer can’t be reported." }, { status: 404 });
      if (init?.method === "GET" && url.searchParams.get("view") === "reports") {
        const reports: Record<string, "available" | "reported"> = {};
        for (const id of (url.searchParams.get("messages") ?? "").split(",").slice(0, 20)) {
          const answer = answers.get(id);
          if (answer) reports[id] = answer.reported ? "reported" : "available";
        }
        return Response.json({ reports, privatePreview: true });
      }
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        const answer = answers.get(body.message);
        if (body.action === "report-answer" && answer) {
          try {
            await report(answer.requestId, body.reason ?? "");
            answer.reported = true;
            return Response.json({ reported: true });
          } catch (error) {
            if (!(error instanceof CommunityApiError)) throw error;
            const reason = (error.details as { reason?: string } | undefined)?.reason;
            return Response.json({ error: error.message, reason }, { status: error.status === 401 ? 403 : error.status });
          }
        }
      }
      return new Response(null, { status: 404 });
    }
    if (route === thread + "/messages" && init?.method === "GET") {
      // The widget has already drawn its receipt. Wake its normal refresh as
      // soon as there is an answer to display.
      // After a failed answer the widget first needs the new typing state.
      if (resumeTyping) resumeTyping = false;
      else await nextAnswer;
      return Response.json({
        conversation,
        messages,
        nextBefore: null,
        authors: { "practice-ai": { badges: ["bot"] } },
      });
    }
    if (
      init?.method === "POST" &&
      (route === "/conversations/ask" || route === thread + "/messages")
    ) {
      const { text, clientId } = JSON.parse(String(init.body));
      try {
        const message = await deliver(text, clientId);
        return Response.json({ conversation, message });
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
  const questionId = useId();
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
        (text, id, onReceipt) => {
          // The widget keeps a failed question with its own Retry and Discard.
          setAsked(true);
          const kept = latest.current.draft;
          if (kept) kept.current = "";
          return latest.current.ask(text, id, onReceipt);
        },
        () => latest.current.report,
      );
      const options = {
        workspace,
        container: container.current,
        label: latest.current.name,
        appearance: {
          theme: document.documentElement.dataset.theme === "dark" ? "dark" : "light",
          accent: latest.current.accent,
        },
        apiUrl: "https://preview.invalid",
        persistDrafts: false,
        showLauncher: false,
        transactionField: false,
        chatFirst: true,
        conversationDrawers: true,
        replyAfterReceipt: true,
      } satisfies Parameters<typeof mountSupportWidget>[0];
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
      // The first frame already matches the page. The appearance module
      // follows subsequent changes from either theme switch.
      chat.setAppearance({ theme: "auto" });
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
      <div className={styles.practiceWindow} data-templ-site-appearance="" ref={container} />
      {!mounted && !failed && !props.scanning && (
        <p className={styles.activityStatus} role="status">
          <ActivityDots /> Opening chat…
        </p>
      )}
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
          <div className={styles.suggestion}>
            <p id={questionId}>{props.suggestion}</p>
            <button
              className="button"
              type="button"
              aria-describedby={questionId}
              onClick={sendSuggestion}
            >
              <IconSend size={17} aria-hidden="true" />
              Send test question
            </button>
          </div>
        )}
    </>
  );
}
