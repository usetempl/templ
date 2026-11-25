import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChatRoomId } from "@templ/chat/index";
import type { ChatPrincipalId } from "@templ/chat/principal";
import type { SupportCaseDetail, SupportDraft } from "@templ/chat/support-drafts";
import { newChatMessageId } from "@/lib/chat-outbox";
import { forgetDraftUse, rememberDraftUse } from "@/lib/draft-link";
import { askAi, conversationErrorMessage, readCase, readCases } from "@/lib/team-conversations-client";

export function replySuggestion(
  detail: SupportCaseDetail | undefined,
  latest?: { id: string; revision: number },
  draftId?: string,
) {
  return detail?.drafts.find(draft =>
    (!draftId || draft.id === draftId) &&
    draft.status === "ready" && draft.kind !== "held-reply" &&
    !draft.stale && draft.problems.length === 0 && draft.text.trim() &&
    (!draft.forMessage || !latest ||
      (draft.forMessage.id === latest.id && draft.forMessage.revision === latest.revision)),
  );
}

export function useReplyDraft({
  room,
  account,
  thread,
  enabled,
  latest,
  refreshKey,
  text,
  onUse,
  onError,
}: {
  room: ChatRoomId;
  account: ChatPrincipalId | undefined;
  thread: string | null;
  enabled: boolean;
  latest?: { id: string; revision: number };
  refreshKey: number;
  text: string;
  onUse: (text: string) => void;
  onError: (error: string) => void;
}) {
  const scope = enabled && thread ? `${room}:${account}:${thread}:${latest?.id}:${latest?.revision}` : null;
  const active = useRef(scope);
  const reply = useRef({ text, revision: 0 });
  const [refresh, reload] = useState(0);
  const [read, setRead] = useState<{ scope: string; detail: SupportCaseDetail }>();
  const [starting, setStarting] = useState<string | null>(null);
  const [request, setRequest] = useState<{ scope: string; id: string; replyRevision: number }>();
  const requested = useRef(request);
  const click = useRef<{ scope: string; id: string } | null>(null);
  const inFlight = useRef(false);
  const callbacks = useRef({ onUse, onError });
  callbacks.current = { onUse, onError };
  requested.current = request;
  if (reply.current.text !== text)
    reply.current = { text, revision: reply.current.revision + 1 };
  const detail = scope && read?.scope === scope ? read.detail : undefined;
  const suggestion = replySuggestion(detail, latest);
  const pending = detail?.requests.find(row => row.status === "pending" && Date.parse(row.expiresAt) > Date.now());
  const requesting = scope !== null && (starting === scope || !!pending || request?.scope === scope);
  const canRequest = Boolean(scope && detail?.case.state === "open");

  useEffect(() => {
    if (thread && !text.trim()) forgetDraftUse(thread);
  }, [thread, text]);

  useLayoutEffect(() => {
    active.current = scope;
    return () => { active.current = null; };
  }, [scope]);
  useEffect(() => {
    if (!scope || !thread) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load(seq?: number) {
      try {
        const current = seq ?? (await readCases(room, thread!, null, controller.signal)).cases[0]?.seq;
        if (current === undefined || controller.signal.aborted) return;
        const result = await readCase(room, thread!, current, controller.signal);
        if (controller.signal.aborted || active.current !== scope) return;
        setRead({ scope: scope!, detail: result });
        if (result.requests.some(row => row.status === "pending" && Date.parse(row.expiresAt) > Date.now()))
          timer = setTimeout(() => void load(current), 3000);
      } catch (error) {
        if (controller.signal.aborted || active.current !== scope) return;
        setRead(undefined);
        if (requested.current?.scope === scope) {
          setRequest(undefined);
          callbacks.current.onError(conversationErrorMessage(error));
        }
      }
    }
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [scope, thread, room, refreshKey, refresh]);

  function insertDraft(draft: SupportDraft) {
    if (!thread || active.current !== scope || reply.current.text.trim()) return;
    rememberDraftUse(thread, draft.id);
    callbacks.current.onUse(draft.text);
  }

  useEffect(() => {
    if (!request || request.scope !== scope || !detail || !thread) return;
    const status = detail.requests.find(item => item.id === request.id);
    if (!status || status.status === "pending" && Date.parse(status.expiresAt) > Date.now()) return;
    setRequest(undefined);
    const answer = status.draft ? replySuggestion(detail, latest, status.draft) : undefined;
    if (status.status === "answered" && answer) {
      if (reply.current.revision !== request.replyRevision || active.current !== scope) return;
      rememberDraftUse(thread, answer.id);
      callbacks.current.onUse(answer.text);
    } else callbacks.current.onError("AI couldn't prepare a reply for this message.");
  }, [request, detail, latest, scope, thread]);

  async function openDraft() {
    if (!scope || !thread || !canRequest || requesting || inFlight.current || reply.current.text.trim()) return;
    if (suggestion) {
      insertDraft(suggestion);
      return;
    }
    const attempt = click.current?.scope === scope
      ? click.current
      : { scope, id: newChatMessageId() };
    click.current = attempt;
    const replyRevision = reply.current.revision;
    inFlight.current = true;
    setStarting(scope);
    try {
      const accepted = await askAi(account, room, thread, { clientId: attempt.id });
      if (active.current !== scope) return;
      click.current = null;
      setRequest({ scope, id: accepted.request.id, replyRevision });
      reload(value => value + 1);
    } catch (error) {
      if (active.current === scope) callbacks.current.onError(conversationErrorMessage(error));
    } finally {
      inFlight.current = false;
      setStarting(value => value === scope ? null : value);
    }
  }

  return {
    suggestion,
    canRequest,
    requesting,
    openDraft,
    useSuggestion: () => { if (suggestion) insertDraft(suggestion); },
  };
}
