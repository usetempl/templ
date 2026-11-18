"use client";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type { ChatRoomId } from "@templ/chat/index";
import type { ChatPrincipalId } from "@templ/chat/principal";
import type { SupportAiView } from "@templ/chat/support";
import type {
  CitationAdvice,
  CitationProblem,
} from "@templ/chat/support-citations";
import {
  SUPPORT_DRAFT_LIMITS,
  type SupportCaseDetail,
  type SupportDraft,
  type SupportDraftRequestView,
} from "@templ/chat/support-drafts";
import { copy as t, type MessageKey } from "@/lib/copy";
import { newChatMessageId } from "@/lib/chat-outbox";
import { forgetDraftUse, rememberDraftUse } from "@/lib/draft-link";
import {
  askAi,
  cancelAiDraft,
  conversationErrorMessage,
  dismissAiDraft,
} from "@/lib/team-conversations-client";
import styles from "./team-conversations.module.css";
import panel from "./case-panels.module.css";

/** A request past this age with no answer says the agent may be offline. */
const SLOW_MS = 2 * 60_000;
type PendingAction =
  | { kind: "ask" }
  | { kind: "cancel"; id: string }
  | { kind: "dismiss"; id: string };

/** A citation problem or advice in plain words for the team. */
export function citationText(item: CitationProblem | CitationAdvice): string {
  switch (item.kind) {
    case "uncited-figure":
      return t("room.citations.uncited-figure", { figure: item.figure });
    case "unknown-evidence":
    case "withdrawn-evidence":
      return t(`room.citations.${item.kind}`, { n: item.evidence });
    case "superseded-evidence":
      return t("room.citations.superseded-evidence", {
        n: item.evidence,
        m: item.by,
      });
    case "unlabeled-mix":
      return t("room.citations.unlabeled-mix", {
        s: item.sentence,
        dimension: t(`room.citations.dimension.${item.dimension}`),
      });
    case "unlabeled-comparison":
      return t("room.citations.unlabeled-comparison", {
        dimension: t(`room.citations.dimension.${item.dimension}`),
      });
    case "unknown-diagnosis":
      return t("room.citations.unknown-diagnosis", { id: item.diagnosis });
    case "diagnosis-figure-not-in-check":
      return t("room.citations.diagnosis-figure-not-in-check", {
        figure: item.figure,
      });
    case "value-mismatch":
      return t("room.citations.value-mismatch", {
        figure: item.figure,
        n: item.evidence,
        value: item.value,
      });
    default:
      return t(`room.citations.${item.kind}` as MessageKey);
  }
}
/** Why Ask AI can't be used now, from what the team view already shows. */
export function askAiBlocked(
  ai: SupportAiView | null | undefined,
  detail: SupportCaseDetail,
  now: number,
): MessageKey | null {
  if (ai && !ai.agentRegistered) return "room.askAi.noAgent";
  if (ai?.mode === "off") return "room.askAi.off";
  if (
    detail.requests.some(
      (request) =>
        request.status === "pending" && Date.parse(request.expiresAt) > now,
    )
  )
    return "room.askAi.busy";
  if (detail.requests.length >= SUPPORT_DRAFT_LIMITS.requestsPerCase)
    return "room.askAi.limit";
  return null;
}
function requestLine(
  request: SupportDraftRequestView,
  now: number,
): {
  key: MessageKey;
  params?: Record<string, string>;
  waiting: boolean;
} | null {
  if (request.status === "pending" && Date.parse(request.expiresAt) > now)
    return {
      key:
        now - Date.parse(request.requestedAt) > SLOW_MS
          ? "room.askAi.slow"
          : "room.askAi.pending",
      waiting: true,
    };
  if (request.status === "expired" || request.status === "pending")
    return { key: "room.askAi.expired", waiting: false };
  if (request.status === "declined")
    return {
      key: "room.askAi.declined",
      params: {
        reason: t(
          `room.askAi.decline.${request.decline ?? "other"}` as MessageKey,
        ),
      },
      waiting: false,
    };
  if (request.status === "cancelled")
    return { key: "room.askAi.cancelled", waiting: false };
  return null;
}
const host = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

/** Ask AI and the request's AI drafts. People ask and send; the AI agent
 * only drafts. A draft reaches the member only when a person sends it as
 * their own reply. */
export function AskAiPanel({
  room,
  account,
  conversationId,
  ai,
  detail,
  replyText,
  onUseDraft,
  onChanged,
  nameOf,
  now = Date.now(),
}: {
  room: ChatRoomId;
  account: ChatPrincipalId | undefined;
  conversationId: string;
  ai: SupportAiView | null | undefined;
  detail: SupportCaseDetail;
  /** What the reply box holds now. */
  replyText: string;
  onUseDraft: (text: string) => void;
  onChanged: () => void;
  nameOf: (id: ChatPrincipalId) => string;
  now?: number;
}) {
  const [instruction, setInstruction] = useState("");
  const [pending, setPending] = useState<PendingAction | null>(null);
  const actionInFlight = useRef<PendingAction | null>(null);
  const askAttempt = useRef<{ clientId: string; instruction: string } | null>(
    null,
  );
  const [error, setError] = useState("");
  const [replacing, setReplacing] = useState<SupportDraft | null>(null);
  const [used, setUsed] = useState<string | null>(null);
  const busy = pending !== null;
  const blocked = askAiBlocked(ai, detail, now);
  const latest = detail.requests[0];
  // With AI off the agent can't see the request: say so, not "waiting".
  const line = latest && ai?.mode !== "off" ? requestLine(latest, now) : null;
  useLayoutEffect(() => {
    actionInFlight.current = null;
    askAttempt.current = null;
    setPending(null);
    setInstruction("");
    setError("");
    setReplacing(null);
    setUsed(null);
    return () => {
      actionInFlight.current = null;
      askAttempt.current = null;
    };
  }, [room, account, conversationId, detail.case.seq]);
  useEffect(() => {
    const attempt = askAttempt.current;
    if (
      !pending &&
      attempt &&
      detail.requests.some(
        (request) =>
          request.id === attempt.clientId && request.status !== "pending",
      )
    ) {
      askAttempt.current = null;
      setError("");
    }
  }, [detail.requests, pending]);
  // A cleared reply box forgets which draft it started from.
  useEffect(() => {
    if (!replyText.trim()) forgetDraftUse(conversationId);
  }, [replyText, conversationId]);
  async function ask(event: FormEvent) {
    event.preventDefault();
    if (actionInFlight.current || blocked) return;
    const attempt =
      askAttempt.current?.instruction === instruction
        ? askAttempt.current
        : { clientId: newChatMessageId(), instruction };
    askAttempt.current = attempt;
    await act(
      { kind: "ask" },
      () => askAi(account, room, conversationId, attempt),
      () => {
        askAttempt.current = null;
        setInstruction("");
      },
    );
  }
  async function act(
    action: PendingAction,
    run: () => Promise<unknown>,
    onSuccess?: () => void,
  ) {
    if (actionInFlight.current) return;
    actionInFlight.current = action;
    setPending(action);
    setError("");
    try {
      await run();
      if (actionInFlight.current !== action) return;
      onSuccess?.();
      onChanged();
    } catch (reason) {
      if (actionInFlight.current === action)
        setError(conversationErrorMessage(reason));
    } finally {
      if (actionInFlight.current === action) {
        actionInFlight.current = null;
        setPending(null);
      }
    }
  }
  function use(draft: SupportDraft) {
    rememberDraftUse(conversationId, draft.id);
    onUseDraft(draft.text);
    setReplacing(null);
    setUsed(draft.id);
  }
  const ready = detail.drafts.filter((draft) => draft.status === "ready");
  const closed = detail.drafts.filter((draft) => draft.status !== "ready");
  return (
    <div className={styles.detailSection}>
      <h3>{t("room.askAi.title")}</h3>
      <form onSubmit={(event) => void ask(event)} className={panel.rows}>
        <label className={styles.detailField}>
          {t("room.askAi.label")}
          <textarea
            rows={2}
            maxLength={SUPPORT_DRAFT_LIMITS.instructionBytes}
            placeholder={t("room.askAi.placeholder")}
            value={instruction}
            disabled={busy || Boolean(blocked)}
            onChange={(event) => setInstruction(event.target.value)}
          />
        </label>
        <div className={panel.actions}>
          <button
            type="submit"
            className="button small"
            disabled={busy || Boolean(blocked)}
            aria-busy={pending?.kind === "ask"}
          >
            {pending?.kind === "ask" ? "Requesting…" : t("room.askAi.send")}
          </button>
          {latest && line?.waiting && (
            <button
              type="button"
              className="button small quiet"
              disabled={busy}
              aria-busy={pending?.kind === "cancel"}
              onClick={() =>
                void act({ kind: "cancel", id: latest.id }, () =>
                  cancelAiDraft(account, room, conversationId, latest.id),
                )
              }
            >
              {pending?.kind === "cancel"
                ? "Cancelling…"
                : t("room.askAi.cancel")}
            </button>
          )}
        </div>
      </form>
      {line ? (
        <p className={panel.status} role="status">
          {line.waiting && <span className={panel.pulse} aria-hidden="true" />}
          {t(line.key, line.params)}
        </p>
      ) : (
        blocked &&
        blocked !== "room.askAi.busy" && (
          <p className={styles.detailMuted}>{t(blocked)}</p>
        )
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {detail.drafts.length > 0 && (
        <>
          <h3>{t("room.drafts.title")}</h3>
          <ul className={panel.rows}>
            {ready.map((draft) => (
              <li key={draft.id} className={panel.draft}>
                <span className={panel.rowHead}>
                  <strong>
                    {t(`room.drafts.${draft.kind}` as MessageKey)}
                  </strong>
                  <span>
                    {nameOf(draft.author)} at{" "}
                    <time dateTime={draft.at}>
                      {new Date(draft.at).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </time>
                  </span>
                </span>
                <p className={panel.draftText}>{draft.text}</p>
                {draft.stale && (
                  <p className={styles.detailMuted}>{t("room.drafts.stale")}</p>
                )}
                {(draft.problems.length > 0 || draft.advice.length > 0) && (
                  <ul className={panel.problems}>
                    {[...draft.problems, ...draft.advice].map((item, index) => (
                      <li key={index}>{citationText(item)}</li>
                    ))}
                  </ul>
                )}
                {(draft.provenance || draft.citations.length > 0) && (
                  <details className={panel.why}>
                    <summary>{t("room.drafts.why")}</summary>
                    <ul>
                      {draft.citations.length > 0 && (
                        <li>
                          {t("room.drafts.cited", {
                            ids: [
                              ...new Set(
                                draft.citations.flatMap((c) => c.evidence),
                              ),
                            ]
                              .map((n) => `E${n}`)
                              .join(", "),
                          })}
                        </li>
                      )}
                      {draft.provenance?.summary && (
                        <li>{draft.provenance.summary}</li>
                      )}
                      {draft.provenance?.sources.map((source) => (
                        // Only a site the workspace lists opens as a link.
                        <li key={source.id}>
                          {source.url && draft.links?.[source.id] ? (
                            <a
                              href={source.url}
                              target="_blank"
                              rel="noopener noreferrer nofollow"
                              referrerPolicy="no-referrer"
                            >
                              {source.title}
                            </a>
                          ) : (
                            source.title
                          )}
                          {source.url
                            ? ` (${
                                draft.links?.[source.id]
                                  ? host(source.url)
                                  : t("room.drafts.notListed", {
                                      host: host(source.url),
                                    })
                              })`
                            : ""}
                        </li>
                      ))}
                      {draft.provenance?.confidence && (
                        <li>
                          {t("room.drafts.confidence", {
                            level: draft.provenance.confidence,
                          })}
                        </li>
                      )}
                    </ul>
                  </details>
                )}
                {replacing?.id === draft.id ? (
                  <div className={panel.actions}>
                    <span className={styles.detailMuted}>
                      {t("room.drafts.replaceConfirm")}
                    </span>
                    <button
                      type="button"
                      className="button small"
                      disabled={busy}
                      onClick={() => use(draft)}
                    >
                      {t("room.drafts.replace")}
                    </button>
                    <button
                      type="button"
                      className="button small quiet"
                      disabled={busy}
                      onClick={() => setReplacing(null)}
                    >
                      {t("room.drafts.keep")}
                    </button>
                  </div>
                ) : (
                  <div className={panel.actions}>
                    <button
                      type="button"
                      className="button small"
                      disabled={busy}
                      onClick={() =>
                        replyText.trim() &&
                        replyText.trim() !== draft.text.trim()
                          ? setReplacing(draft)
                          : use(draft)
                      }
                    >
                      {t("room.drafts.use")}
                    </button>
                    <button
                      type="button"
                      className="button small quiet"
                      disabled={busy}
                      aria-busy={
                        pending?.kind === "dismiss" && pending.id === draft.id
                      }
                      onClick={() =>
                        void act({ kind: "dismiss", id: draft.id }, () =>
                          dismissAiDraft(
                            account,
                            room,
                            conversationId,
                            draft.id,
                          ),
                        )
                      }
                    >
                      {pending?.kind === "dismiss" && pending.id === draft.id
                        ? "Dismissing…"
                        : t("room.drafts.dismiss")}
                    </button>
                  </div>
                )}
                {used === draft.id && (
                  <p className={styles.detailMuted} role="status">
                    {t("room.drafts.inComposer")}
                  </p>
                )}
              </li>
            ))}
            {closed.map((draft) => (
              <li key={draft.id} className={panel.draft} data-closed="true">
                <span className={panel.rowHead}>
                  <strong>
                    {t(`room.drafts.${draft.kind}` as MessageKey)}
                  </strong>
                  <span>
                    {draft.status === "dismissed"
                      ? t("room.drafts.dismissed")
                      : draft.edited
                        ? t("room.drafts.usedEdited")
                        : t("room.drafts.used")}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
