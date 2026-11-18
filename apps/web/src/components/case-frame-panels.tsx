"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatRoomId, TeamConversation } from "@templ/chat/index";
import type { SupportContext } from "@templ/chat/support";
import { inboxNetworkName, inboxTime } from "@/lib/inbox-facts";
import { SUPPORT_IDENTITY_LABELS } from "@templ/chat/support-identity";
import {
  APP_FIELDS,
  APP_LABELS,
  FAILURE_KIND_LABELS,
  appValue,
} from "@/lib/support-widget-app";
import type { ChatPrincipalId } from "@templ/chat/principal";
import type {
  SupportCaseDetail,
  SupportCaseView,
  SupportSummaryCases,
} from "@templ/chat/support-drafts";
import { copy as t } from "@/lib/copy";
import { useMemberProfiles } from "@/lib/member-profiles";
import { CommunityApiError } from "@/lib/community-client";
import {
  conversationErrorMessage,
  readCase,
  readCases,
} from "@/lib/team-conversations-client";
import { AskAiPanel } from "./ask-ai-panel";
import { CaseFramePanel } from "./case-frame-panel";
import styles from "./team-conversations.module.css";
import panel from "./case-panels.module.css";

type CaseList = {
  thread: string;
  cases: SupportCaseView[];
  nextBefore: number | null;
};
/** While an Ask AI request waits, the panel reads the request again this
 * often, until it is answered, closed or expires. */
const POLL_MS = 3_000;
const shortAccount = (id: string) =>
  id.length > 24 ? `${id.slice(0, 16)}…${id.slice(-6)}` : id;
const accessEnded = (reason: unknown) =>
  reason instanceof CommunityApiError &&
  [401, 403, 404].includes(reason.status);

type CasePanelsProps = {
  room: ChatRoomId;
  account: ChatPrincipalId | undefined;
  conversation: TeamConversation;
  aiDrafts?: boolean;
  context?: SupportContext | null;
  replyText: string;
  onUseDraft: (text: string) => void;
  refreshKey?: number;
};

/** The team's case panels in the request details: the request's frame and
 * evidence, and Ask AI with its drafts. Each read and write goes through
 * the service's access check; the member never gets these panels. */
export function CasePanels(props: CasePanelsProps) {
  return (
    <ScopedCasePanels
      key={`${props.room}/${props.conversation.id}/${props.account ?? ""}`}
      {...props}
    />
  );
}

function ScopedCasePanels({
  aiDrafts = false,
  room,
  account,
  conversation,
  context,
  replyText,
  onUseDraft,
  refreshKey = 0,
}: CasePanelsProps) {
  const id = conversation.id;
  // Newest first. Earlier pages load when the person moves past the oldest
  // loaded request, and a reload keeps them.
  const [list, setListState] = useState<CaseList | null>(null);
  const listRef = useRef<CaseList | null>(null);
  const setList = useCallback((next: CaseList) => {
    listRef.current = next;
    setListState(next);
  }, []);
  const cases = list?.cases ?? null;
  const [selected, setSelected] = useState<number | null>(() => {
    const seq = (conversation.support as SupportSummaryCases | undefined)
      ?.caseSeq;
    return typeof seq === "number" && Number.isSafeInteger(seq) && seq > 0
      ? seq
      : null;
  });
  const [loadedDetail, setDetail] = useState<SupportCaseDetail | null>(null);
  const detail = loadedDetail?.case.seq === selected ? loadedDetail : null;
  const [listError, setListError] = useState("");
  const [detailError, setDetailError] = useState("");
  const error = listError || detailError;
  const [tick, setTick] = useState(0);
  const [detailTick, setDetailTick] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const reload = useCallback(() => setTick((value) => value + 1), []);
  const pageRead = useRef<AbortController | null>(null);
  const accessRevision = useRef(0);
  const clearAccess = useCallback(() => {
    accessRevision.current += 1;
    pageRead.current?.abort();
    listRef.current = null;
    setListState(null);
    setDetail(null);
  }, []);
  useEffect(() => () => pageRead.current?.abort(), [selected]);

  useEffect(() => {
    const controller = new AbortController();
    const access = accessRevision.current;
    readCases(room, id, null, controller.signal).then(
      (page) => {
        if (controller.signal.aborted || access !== accessRevision.current)
          return;
        const previous =
          listRef.current?.thread === id ? listRef.current : null;
        const firstLoad = previous === null;
        const floor = page.cases.at(-1)?.seq ?? 0;
        const older = previous?.cases.filter((c) => c.seq < floor) ?? [];
        const merged = [...page.cases, ...older];
        setList({
          thread: id,
          cases: merged,
          nextBefore: older.length ? previous!.nextBefore : page.nextBefore,
        });
        setListError("");
        setSelected((current) =>
          !firstLoad &&
          current !== null &&
          merged.some((c) => c.seq === current)
            ? current
            : (merged[0]?.seq ?? null),
        );
      },
      (reason) => {
        if (controller.signal.aborted || access !== accessRevision.current)
          return;
        if (accessEnded(reason)) clearAccess();
        setListError(conversationErrorMessage(reason));
      },
    );
    return () => controller.abort();
  }, [room, id, refreshKey, tick, setList, clearAccess]);

  useEffect(() => {
    if (selected === null) return;
    const controller = new AbortController();
    const access = accessRevision.current;
    readCase(room, id, selected, controller.signal).then(
      (read) => {
        if (controller.signal.aborted || access !== accessRevision.current)
          return;
        setDetail(read);
        setNow(Date.now());
        setDetailError("");
      },
      (reason) => {
        if (controller.signal.aborted || access !== accessRevision.current)
          return;
        if (accessEnded(reason)) clearAccess();
        setDetailError(conversationErrorMessage(reason));
      },
    );
    return () => controller.abort();
  }, [room, id, selected, refreshKey, tick, detailTick, clearAccess]);

  // Poll only while a request waits for the AI agent.
  const waitingUntil = detail?.requests
    .filter((request) => request.status === "pending")
    .map((request) => Date.parse(request.expiresAt))
    .find((expires) => expires > now);
  useEffect(() => {
    if (waitingUntil === undefined || error) return;
    const timer = setTimeout(
      () => setDetailTick((value) => value + 1),
      POLL_MS,
    );
    return () => clearTimeout(timer);
  }, [waitingUntil, detail, error]);

  const people = [
    ...new Set([
      ...(detail?.evidence.map((row) => row.author) ?? []),
      ...(detail?.drafts.map((draft) => draft.author) ?? []),
    ]),
  ];
  const profiles = useMemberProfiles(people);
  const nameOf = (principal: ChatPrincipalId) =>
    principal === account
      ? t("room.turn.who.you")
      : profiles.get(principal)?.displayName?.trim() || shortAccount(principal);

  const snapshotFacts = <FailureSnapshots context={context} thread={id} />;
  if (error && (!detail || cases === null))
    return (
      <section className={panel.panels} aria-label={t("room.case.title")}>
        {snapshotFacts}
        <div className={styles.detailSection}>
          <p className={styles.error} role="alert">
            {t("room.case.loadFailed")}
          </p>
          <button
            type="button"
            className="button small secondary"
            onClick={reload}
          >
            {t("room.case.retry")}
          </button>
        </div>
      </section>
    );
  if (cases === null || (selected !== null && !detail))
    return (
      <>
        {snapshotFacts}
        <div className={panel.skeleton} aria-hidden="true" />
      </>
    );
  if (!cases.length || selected === null || !detail)
    return (
      <section className={panel.panels} aria-label={t("room.case.title")}>
        {snapshotFacts}
        <div className={styles.detailSection}>
          <h3>{t("room.case.title")}</h3>
          <p className={styles.detailMuted}>{t("room.case.none")}</p>
        </div>
      </section>
    );
  // "Request n of m": n is the request's number in the thread, m the
  // newest request's number, so the line is right on any page.
  const earlier = cases.filter((c) => c.seq < selected);
  const later = cases.filter((c) => c.seq > selected);
  function show(seq: number) {
    setDetail(null);
    setSelected(seq);
  }
  async function move(step: -1 | 1) {
    if (step === 1) {
      if (later.length) show(later.at(-1)!.seq);
      return;
    }
    if (earlier.length) return show(earlier[0].seq);
    const before = list?.nextBefore;
    if (!before || pageRead.current) return;
    const controller = new AbortController();
    const access = accessRevision.current;
    pageRead.current = controller;
    try {
      const page = await readCases(room, id, before, controller.signal);
      if (controller.signal.aborted || access !== accessRevision.current)
        return;
      setList({
        thread: id,
        cases: [...(listRef.current?.cases ?? []), ...page.cases],
        nextBefore: page.nextBefore,
      });
      setListError("");
      if (page.cases[0]) show(page.cases[0].seq);
    } catch (reason) {
      if (!controller.signal.aborted && access === accessRevision.current) {
        if (accessEnded(reason)) clearAccess();
        setListError(conversationErrorMessage(reason));
      }
    } finally {
      if (pageRead.current === controller) pageRead.current = null;
    }
  }
  return (
    <section className={panel.panels} aria-label={t("room.case.title")}>
      {snapshotFacts}
      <CaseFramePanel
        room={room}
        account={account}
        conversationId={id}
        detail={detail}
        position={{
          index: selected,
          count: cases[0].seq,
          earlier: earlier.length > 0 || Boolean(list?.nextBefore),
        }}
        onMove={(step) => void move(step)}
        onChanged={reload}
        nameOf={nameOf}
      />
      {aiDrafts && selected === cases[0].seq && (
        <AskAiPanel
          room={room}
          account={account}
          conversationId={id}
          ai={conversation.ai}
          detail={detail}
          replyText={replyText}
          onUseDraft={onUseDraft}
          onChanged={reload}
          nameOf={nameOf}
          now={now}
        />
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function FailureSnapshots({
  context,
  thread,
}: {
  context?: SupportContext | null;
  thread: string;
}) {
  const snapshots = context?.snapshots;
  if (!snapshots?.length) return null;
  return (
    <section
      className={`${styles.detailSection} ${styles.failureFacts}`}
      id={`support-failure-${thread}`}
      tabIndex={-1}
      aria-label="When it failed"
    >
      <h3>When it failed</h3>
      {snapshots.map((snapshot) => (
        <div key={snapshot.id}>
          <time dateTime={snapshot.capturedAt}>
            {inboxTime(snapshot.capturedAt)}
          </time>
          <p>
            {SUPPORT_IDENTITY_LABELS[snapshot.wallet.level]}
            {snapshot.wallet.address ? ` ${snapshot.wallet.address}` : ""}
          </p>
          {snapshot.network && <p>{inboxNetworkName(snapshot.network)}</p>}
          {snapshot.transactions?.map((tx) => (
            <p key={tx.hash}>
              {tx.hash}
              {tx.network ? ` on ${inboxNetworkName(tx.network)}` : ""}
            </p>
          ))}
          {snapshot.failure && (
            <p>
              {APP_LABELS.failure}: {FAILURE_KIND_LABELS[snapshot.failure.kind]}{" "}
              on {inboxTime(snapshot.failure.at ?? snapshot.capturedAt, true)}
            </p>
          )}
          {snapshot.failure?.amount !== undefined && (
            <dl className={styles.facts}>
              <div>
                <dt>Amount</dt>
                <dd>
                  {[
                    snapshot.failure.amount,
                    snapshot.failure.asset?.symbol ??
                      snapshot.failure.asset?.address,
                  ]
                    .filter(Boolean)
                    .join(" ")}
                </dd>
              </div>
            </dl>
          )}
          {snapshot.failure?.asset && snapshot.failure.amount === undefined && (
            <p>
              Asset:{" "}
              {snapshot.failure.asset.symbol ?? snapshot.failure.asset.address}
            </p>
          )}
          {APP_FIELDS.map((field) => {
            const app = { ...snapshot.app, sdk: snapshot.sdk };
            return field === "failure" || app[field] === undefined ? null : (
              <p key={field}>
                {APP_LABELS[field]}: {appValue(field, app)}
              </p>
            );
          })}
        </div>
      ))}
    </section>
  );
}
