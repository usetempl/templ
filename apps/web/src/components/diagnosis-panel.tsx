"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import type { ChatRoomId } from "@templ/chat/index";
import type { ChatPrincipalId } from "@templ/chat/principal";
import type { SupportContext, SupportTransaction } from "@templ/chat/support";
import {
  supportNetworkName,
  supportTransactionUrl,
} from "@templ/chat/support-context";
import { diagnosisEvidenceSection } from "@templ/chat/support-diagnosis";
import { SUPPORT_IDENTITY_LABELS } from "@templ/chat/support-identity";
import {
  APP_FIELDS,
  APP_LABELS,
  FAILURE_KIND_LABELS,
  appValue,
} from "@/lib/support-widget-app";
import type {
  SupportDiagnosisList,
  SupportDiagnosisRating,
  SupportDiagnosisView,
} from "@templ/chat/support-diagnosis";
import { DIAGNOSIS_COPY as c, DIAGNOSIS_ERRORS } from "@/lib/copy/diagnosis";
import { CommunityApiError } from "@/lib/community-client";
import { useMemberProfiles } from "@/lib/member-profiles";
import {
  newDiagnosisClientId,
  rateDiagnosis,
  readDiagnoses,
  runDiagnosis,
} from "@/lib/diagnosis-client";
import type { WorkspaceFeatures } from "@templ/chat/workspace-flags";
import styles from "./team-conversations.module.css";
import panel from "./case-panels.module.css";
import own from "./diagnosis-panel.module.css";

/** While a check runs, the panel reads the list again this often, for at
 * most POLL_LIMIT_MS. */
const POLL_MS = 2_000;
const POLL_LIMIT_MS = 30_000;

const fill = (text: string, values: Record<string, string>) =>
  text.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match);
const shortAccount = (id: string) =>
  id.length > 24 ? `${id.slice(0, 16)}…${id.slice(-6)}` : id;
const short = (value: string) =>
  value.length > 20 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value;
const utc = (at: string) => at.slice(0, 16).replace("T", " ");
const host = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};
function errorText(reason: unknown): string {
  if (reason instanceof CommunityApiError) {
    const code = (reason.details as { reason?: unknown } | undefined)?.reason;
    if (reason.status < 500 && reason.message) return reason.message;
    if (typeof code === "string" && code in DIAGNOSIS_ERRORS)
      return DIAGNOSIS_ERRORS[code as keyof typeof DIAGNOSIS_ERRORS]!;
  }
  return c.error;
}
/** The worker decides which transaction checks run in this workspace. */
export function diagnosisPanelAllowed(
  features?: Partial<WorkspaceFeatures>,
): boolean {
  return (
    features?.["diagnosis.evm"] === true ||
    features?.["diagnosis.solana"] === true
  );
}

function AppReport({ context }: { context?: SupportContext | null }) {
  if (!context) return null;
  return (
    <>
      {context.snapshots?.map((snapshot) => {
        const app = {
          ...snapshot.app,
          ...(snapshot.failure ? { failure: snapshot.failure } : {}),
          ...(snapshot.sdk ? { sdk: snapshot.sdk } : {}),
        };
        return (
          <div key={snapshot.id}>
            <p className={panel.by}>
              <time dateTime={snapshot.capturedAt}>
                {fill(c.captured, { time: utc(snapshot.capturedAt) })}
              </time>
            </p>
            <p className={own.text}>
              {SUPPORT_IDENTITY_LABELS[snapshot.wallet.level]}
              {snapshot.wallet.address ? ` ${snapshot.wallet.address}` : ""}
            </p>
            {snapshot.network && (
              <p className={own.text}>{supportNetworkName(snapshot.network)}</p>
            )}
            {APP_FIELDS.filter((field) => app[field] !== undefined).map(
              (field) => (
                <p className={own.text} key={field}>
                  {APP_LABELS[field]}:{" "}
                  {appValue(field, app, FAILURE_KIND_LABELS)}
                </p>
              ),
            )}
          </div>
        );
      })}
      {context.network && (
        <p className={own.text}>{supportNetworkName(context.network)}</p>
      )}
      {context.app &&
        APP_FIELDS.filter((field) => context.app?.[field] !== undefined).map(
          (field) => (
            <p className={own.text} key={field}>
              {APP_LABELS[field]}:{" "}
              {appValue(field, context.app!, FAILURE_KIND_LABELS)}
            </p>
          ),
        )}
    </>
  );
}

/** Only details already shared in this case; no wallet ownership inference. */
function SharedCaseContext({ context }: { context?: SupportContext | null }) {
  if (!context) return null;
  const snapshot = context.snapshots?.length
    ? context.snapshots.reduce((latest, item) =>
        item.capturedAt >= latest.capturedAt ? item : latest,
      )
    : undefined;
  const app = snapshot
    ? {
        ...snapshot.app,
        ...(snapshot.failure ? { failure: snapshot.failure } : {}),
      }
    : context.app;
  const network =
    snapshot?.network ??
    app?.product?.network ??
    app?.failure?.asset?.network ??
    context.network;
  const failure = app?.failure;
  const sharedTransactions = snapshot
    ? (snapshot.transactions ?? [])
    : (context.transactions ?? []);
  const fields = [
    network && ["Network", supportNetworkName(network)],
    snapshot?.wallet.address && [
      SUPPORT_IDENTITY_LABELS[snapshot.wallet.level],
      snapshot.wallet.address,
    ],
    app?.product?.label && ["Product", app.product.label],
    app?.product?.address && ["Product address", app.product.address],
    failure?.asset?.address &&
      failure.asset.address !== app?.product?.address && [
        "Asset address",
        failure.asset.address,
      ],
    failure?.amount && [
      "Amount",
      [failure.amount, failure.asset?.symbol].filter(Boolean).join(" "),
    ],
  ].filter((field): field is string[] => Boolean(field));
  if (!fields.length && !app?.error && !failure && !app?.action) return null;
  return (
    <section className={own.shared} aria-label="Shared app details">
      <div className={own.head}>
        <strong>
          {app?.action
            ? `${appValue("action", app)} ${failure ? "failed" : "details"}`
            : "Shared app details"}
        </strong>
        <span className={panel.by}>{c.appReported}</span>
      </div>
      {app?.error && <p className={own.text}>{appValue("error", app)}</p>}
      {failure && (
        <p className={panel.by}>{FAILURE_KIND_LABELS[failure.kind]}</p>
      )}
      {fields.length > 0 && (
        <dl className={own.contextFacts}>
          {fields.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {failure && sharedTransactions.length === 0 && (
        <p className={panel.by}>No transaction ID was shared for this error.</p>
      )}
    </section>
  );
}

function TransactionReference({ tx }: { tx: SupportTransaction }) {
  const url = supportTransactionUrl(tx);
  return (
    <span className={panel.rowHead}>
      {url ? (
        <a
          className={own.hash}
          href={url}
          title={tx.hash}
          target="_blank"
          rel="noopener noreferrer"
        >
          {short(tx.hash)}
        </a>
      ) : (
        <span className={own.hash} title={tx.hash}>
          {short(tx.hash)}
        </span>
      )}
      {tx.network && <span>{supportNetworkName(tx.network)}</span>}
      <span className={panel.by}>{c.shared}</span>
    </span>
  );
}

function CaseTransactionPanel({
  compact,
  context,
  transactions,
  result,
  notice,
  children,
}: {
  compact: boolean;
  context?: SupportContext | null;
  transactions: readonly SupportTransaction[];
  result?: SupportDiagnosisView;
  notice?: ReactNode;
  children: ReactNode;
}) {
  if (!compact)
    return <section className={styles.detailSection}>{children}</section>;
  const snapshot = context?.snapshots?.length
    ? context.snapshots.reduce((latest, item) =>
        item.capturedAt >= latest.capturedAt ? item : latest,
      )
    : undefined;
  const app = snapshot?.app ?? context?.app;
  const reason = result?.whatHappened || app?.error?.message;
  const transaction = snapshot ? snapshot.transactions?.[0] : transactions[0];
  const subject = result
    ? result.subject.kind === "evm"
      ? result.subject.hash
      : result.subject.signature
    : "";
  return (
    <section className={own.inline} aria-label="Case transaction">
      {(result || transaction || reason) && (
        <div className={own.summaryHead}>
          {result ? (
            <span className={own.chip} data-tone={result.chip.tone}>
              {result.chip.label}
            </span>
          ) : (
            <strong>{app?.error ? "App error" : c.title}</strong>
          )}
          {result ? (
            <>
              {result.network && <span>{result.network.name}</span>}
              {result.explorer ? (
                <a
                  className={own.hash}
                  href={result.explorer}
                  title={subject}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {short(subject)}
                </a>
              ) : (
                <span className={own.hash} title={subject}>
                  {short(subject)}
                </span>
              )}
            </>
          ) : (
            transaction && <TransactionReference tx={transaction} />
          )}
        </div>
      )}
      {reason && (
        <p className={own.summaryText} title={reason}>
          {result && <span className={panel.by}>{c.inference}: </span>}
          {reason}
        </p>
      )}
      {result?.needsPerson && <p className={own.person}>{c.needsPerson}</p>}
      {notice}
      <section className={own.disclosure}>
        <h3>
          {result || transaction || reason
            ? "Transaction details"
            : "Check a transaction"}
        </h3>
        <div className={own.expanded}>{children}</div>
      </section>
    </section>
  );
}

function CheckCard({
  view,
  context,
  replyText,
  onPutInReply,
  onRate,
  name,
  compact = false,
}: {
  compact?: boolean;
  view: SupportDiagnosisView;
  context?: SupportContext | null;
  replyText: string;
  onPutInReply: (text: string) => void;
  onRate: (rating: SupportDiagnosisRating) => Promise<boolean>;
  name: (id: string) => string;
}) {
  const [confirming, setConfirming] = useState(false);
  const [rated, setRated] = useState(view.rating !== null);
  const [savingRating, setSavingRating] =
    useState<SupportDiagnosisRating | null>(null);
  const ratingInFlight = useRef(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  async function rate(rating: SupportDiagnosisRating) {
    if (ratingInFlight.current) return;
    ratingInFlight.current = true;
    setSavingRating(rating);
    try {
      if ((await onRate(rating)) && active.current) setRated(true);
    } finally {
      ratingInFlight.current = false;
      if (active.current) setSavingRating(null);
    }
  }
  const draft = view.memberDraft;
  const who =
    view.trigger === "member-share"
      ? fill(c.checkedShare, { time: utc(view.at) })
      : view.trigger === "ask-ai"
        ? fill(c.checkedAskAi, { time: utc(view.at) })
        : fill(c.checkedBy, {
            time: utc(view.at),
            name: view.by ? name(view.by) : "",
          });
  const put = () => {
    if (!draft) return;
    if (replyText.trim() && !confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    onPutInReply(draft);
  };
  const evidence = (
    <>
      {(context?.app ||
        context?.snapshots?.length ||
        context?.network ||
        view.evidence.some(
          (item) =>
            (item.section ?? diagnosisEvidenceSection(item.source)) === "app",
        )) && (
        <section className={own.block} aria-label={c.appReported}>
          <h4>{c.appReported}</h4>
          <AppReport context={context} />
          {view.evidence
            .filter(
              (item) =>
                (item.section ?? diagnosisEvidenceSection(item.source)) ===
                "app",
            )
            .map((item) => (
              <p className={own.text} key={item.id}>
                {item.label}: {item.value}
              </p>
            ))}
        </section>
      )}
      {view.evidence.some(
        (item) =>
          (item.section ?? diagnosisEvidenceSection(item.source)) === "chain",
      ) && (
        <section className={own.block} aria-label={c.chainShows}>
          <h4>{c.chainShows}</h4>
          <dl className={own.evidence}>
            {view.evidence
              .filter(
                (item) =>
                  (item.section ?? diagnosisEvidenceSection(item.source)) ===
                  "chain",
              )
              .map((item) => (
                <div key={item.id} className={own.fact}>
                  <dt>{item.label}</dt>
                  <dd>
                    <span className={own.value}>{item.value}</span>
                    <span className={panel.by}>{item.sourceLabel}</span>
                    <time
                      className={panel.by}
                      dateTime={item.observedAt ?? view.at}
                    >
                      {fill(c.observed, {
                        time: utc(item.observedAt ?? view.at),
                      })}
                    </time>
                  </dd>
                </div>
              ))}
          </dl>
        </section>
      )}
      {(view.whatHappened ||
        view.findings.length ||
        view.evidence.some(
          (item) =>
            (item.section ?? diagnosisEvidenceSection(item.source)) ===
            "reading",
        )) && (
        <section className={own.block} aria-label={c.templReading}>
          <h4>{c.templReading}</h4>
          <span className={panel.by}>{c.inference}</span>
          <p className={own.text}>{view.whatHappened}</p>
          {view.findings.length > 1 && (
            <ul className={own.findings}>
              {view.findings.slice(1).map((item) => (
                <li key={item.rule}>{item.text}</li>
              ))}
            </ul>
          )}
          {view.evidence
            .filter(
              (item) =>
                (item.section ?? diagnosisEvidenceSection(item.source)) ===
                "reading",
            )
            .map((item) => (
              <p className={own.text} key={item.id}>
                {item.label}: {item.value}{" "}
                <span className={panel.by}>{item.sourceLabel}</span>
              </p>
            ))}
        </section>
      )}
      {(["pending", "not-found", "unavailable", "disagree"].includes(
        view.status,
      ) ||
        view.evidence.some((item) => item.section === "unknown")) && (
        <section className={own.block} aria-label={c.notKnown}>
          <h4>{c.notKnown}</h4>
          <p className={own.text}>
            {view.status === "pending"
              ? c.unknownPending
              : view.status === "not-found"
                ? c.unknownMissing
                : view.status === "disagree"
                  ? c.unknownDisagree
                  : c.unknownUnavailable}
          </p>
          {view.evidence
            .filter((item) => item.section === "unknown")
            .map((item) => (
              <p key={item.id} className={own.text}>
                {item.label}: {item.value}
              </p>
            ))}
        </section>
      )}
      {view.nextSteps && view.nextSteps.length > 0 && (
        <div className={own.block}>
          <h4>{c.nextStep}</h4>
          {view.nextSteps.slice(0, 2).map((step) => (
            <p key={step.id} className={own.text}>
              {step.text}
            </p>
          ))}
        </div>
      )}
    </>
  );
  return (
    <li className={own.card} data-tone={view.chip.tone}>
      <span className={panel.rowHead}>
        <span className={own.chip} data-tone={view.chip.tone}>
          {view.chip.label}
        </span>
        {view.network && <span>{view.network.name}</span>}
        <span className={own.hash}>
          {short(
            view.subject.kind === "evm"
              ? view.subject.hash
              : view.subject.signature,
          )}
        </span>
      </span>
      {compact ? (
        <>
          <p className={own.text}>
            <span className={panel.by}>
              {c.templReading} ({c.inference})
            </span>
            <br />
            {view.whatHappened}
          </p>
          <section className={own.advanced}>
            <h3>Evidence and next steps</h3>
            {evidence}
          </section>
        </>
      ) : (
        evidence
      )}
      {view.status === "confirmed" && (
        <p className={own.person}>{c.succeeded}</p>
      )}
      {view.needsPerson && <p className={own.person}>{c.needsPerson}</p>}
      <div className={panel.actions}>
        {draft ? (
          <button type="button" className="button small" onClick={put}>
            {c.putInReply}
          </button>
        ) : (
          <p className={styles.detailMuted}>{c.noSummary}</p>
        )}
        {view.explorer && (
          <a
            className="button small quiet"
            href={view.explorer}
            target="_blank"
            rel="noopener noreferrer"
          >
            {fill(c.openOn, { host: host(view.explorer) })}
          </a>
        )}
      </div>
      {confirming && (
        <div
          className={own.confirm}
          role="alertdialog"
          aria-label={c.replaceAsk}
        >
          <p>{c.replaceAsk}</p>
          <div className={panel.actions}>
            <button type="button" className="button small" onClick={put}>
              {c.replace}
            </button>
            <button
              type="button"
              className="button small quiet"
              onClick={() => setConfirming(false)}
            >
              {c.keepMine}
            </button>
          </div>
        </div>
      )}
      {rated ? (
        <p className={styles.detailMuted} role="status">
          {c.rated}
        </p>
      ) : (
        <div className={own.rate}>
          <span>{c.rateAsk}</span>
          {(
            [
              ["correct", c.rateYes],
              ["incomplete", c.ratePartly],
              ["wrong", c.rateNo],
            ] as const
          ).map(([rating, label]) => (
            <button
              key={rating}
              type="button"
              className="button small quiet"
              disabled={savingRating !== null}
              aria-busy={savingRating === rating}
              onClick={() => void rate(rating)}
            >
              {savingRating === rating ? "Saving…" : label}
            </button>
          ))}
        </div>
      )}
      <span className={panel.by}>{who}</span>
    </li>
  );
}

/** Transaction checks in the case, for the team. It lists the
 * member's shared transactions with a Check button, the saved checks with
 * what happened and the evidence, and a field to check another hash or
 * link. "Put summary in reply" only fills the composer; the person sends.
 * It reads the list again when `refreshKey` or the shared transactions
 * change, and for a short while after a transaction is shared without a
 * check yet, so an automatic check shows up without a reload. */
type DiagnosisPanelProps = {
  room: ChatRoomId;
  account: ChatPrincipalId | undefined;
  thread: string;
  transactions: readonly SupportTransaction[];
  context?: SupportContext | null;
  replyText: string;
  onPutInReply: (text: string) => void;
  refreshKey?: number;
  enabled?: boolean;
  compact?: boolean;
};

export function DiagnosisPanel(props: DiagnosisPanelProps) {
  return (
    <ScopedDiagnosisPanel
      key={`${props.room}/${props.thread}/${props.account ?? ""}`}
      {...props}
    />
  );
}

function ScopedDiagnosisPanel({
  room,
  account,
  thread,
  transactions,
  context,
  replyText,
  onPutInReply,
  refreshKey = 0,
  enabled = false,
  compact = false,
}: DiagnosisPanelProps) {
  const [list, setList] = useState<SupportDiagnosisList | null>(null);
  const [hidden, setHidden] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [running, setRunning] = useState<string | null>(null);
  const [paste, setPaste] = useState("");
  const clientIds = useRef(new Map<string, string>());
  const pollUntil = useRef(0);
  const readRevision = useRef(0);
  const accessRevision = useRef(0);
  const active = useRef(enabled);
  const checking = useRef<{ key: string } | null>(null);
  const clearAccess = useCallback(() => {
    accessRevision.current += 1;
    readRevision.current += 1;
    setList(null);
    setHidden(true);
    setLoading(false);
    setError("");
    setRunning(null);
    setPaste("");
    clientIds.current.clear();
    checking.current = null;
  }, []);
  useEffect(() => {
    active.current = enabled;
    return () => {
      active.current = false;
      readRevision.current += 1;
      accessRevision.current += 1;
      checking.current = null;
    };
  }, [enabled]);

  const load = useCallback(
    (signal?: AbortSignal) => {
      const revision = ++readRevision.current;
      const stale = () =>
        !active.current || signal?.aborted || revision !== readRevision.current;
      setLoading(true);
      return readDiagnoses(room, thread, signal)
        .then(
          (next) => {
            if (stale()) return null;
            setList(next);
            setHidden(false);
            setLoadFailed(false);
            return next;
          },
          (reason: unknown) => {
            if (stale()) return null;
            if (
              reason instanceof CommunityApiError &&
              [401, 403, 404].includes(reason.status)
            ) {
              clearAccess();
            } else setLoadFailed(true);
            return null;
          },
        )
        .finally(() => {
          if (!stale()) setLoading(false);
        });
    },
    [room, thread, clearAccess],
  );
  const shared = transactions.map((tx) => tx.hash).join(",");
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    // A team change restarts the short polling window.
    pollUntil.current = 0;
    void load(controller.signal);
    return () => controller.abort();
  }, [load, refreshKey, enabled]);
  useEffect(() => {
    pollUntil.current = 0;
  }, [shared]);
  const networks = new Set(list?.networks.map((item) => item.id) ?? []);
  const evmOn = [...networks].some((id) => id.startsWith("eip155:"));
  const latest = (value: string) =>
    list?.diagnoses.find(
      (item) =>
        (item.subject.kind === "evm"
          ? item.subject.hash
          : item.subject.signature) === value,
    );
  const isOff = (tx: SupportTransaction) =>
    tx.network === "solana"
      ? !networks.has("solana")
      : tx.network !== undefined
        ? !networks.has(tx.network)
        : !evmOn;
  // A check that runs elsewhere (an automatic one on a member's share or an
  // Ask AI request, another person's) shows up by polling while the list
  // says one is running or a shared transaction has no check yet.
  const waiting = Boolean(
    list?.running ||
    (list?.enabled &&
      transactions.some((tx) => !isOff(tx) && !latest(tx.hash))),
  );
  useEffect(() => {
    if (!waiting) return;
    if (!pollUntil.current) pollUntil.current = Date.now() + POLL_LIMIT_MS;
    if (Date.now() > pollUntil.current) return;
    const timer = setTimeout(() => void load(), POLL_MS);
    return () => clearTimeout(timer);
  }, [list, waiting, load, shared]);
  const people = [
    ...new Set(
      (list?.diagnoses ?? []).flatMap((item) =>
        item.by && item.by !== account ? [item.by] : [],
      ),
    ),
  ];
  const profiles = useMemberProfiles(people);
  const name = (id: string) =>
    id === account
      ? c.you
      : profiles.get(id)?.displayName?.trim() || shortAccount(id);

  const sharedContext = compact ? (
    <SharedCaseContext context={context} />
  ) : null;
  const hasTransactionContext = Boolean(
    context?.app?.error ||
    context?.app?.failure ||
    context?.snapshots?.some(
      (snapshot) =>
        snapshot.app?.error ||
        snapshot.failure ||
        snapshot.transactions?.length,
    ),
  );
  const readStatus = loadFailed ? (
    <div className={panel.actions}>
      <p className={panel.status} role="status">
        {loading
          ? "Loading transaction checks…"
          : "Transaction checks could not load. Try again."}
      </p>
      <button
        type="button"
        className="button small secondary"
        disabled={loading}
        onClick={() => void load()}
      >
        Retry
      </button>
    </div>
  ) : !list ? (
    <p className={panel.status} role="status">
      Loading transaction checks…
    </p>
  ) : null;
  const optionalCheck = (content: ReactNode) => (
    <section className={`${own.advanced} ${own.optional}`}>
      <h3>Check transaction</h3>
      {content}
    </section>
  );
  if (!enabled || hidden || !list)
    return compact && !hasTransactionContext && !transactions.length ? (
      enabled && !hidden ? (
        optionalCheck(readStatus)
      ) : (
        sharedContext
      )
    ) : (compact && (hasTransactionContext || transactions.length)) ||
      (enabled && !hidden) ? (
      <CaseTransactionPanel
        compact={compact}
        context={context}
        transactions={transactions}
      >
        {sharedContext}
        {transactions.map((tx) => (
          <div className={own.candidate} key={tx.hash}>
            <TransactionReference tx={tx} />
          </div>
        ))}
        {enabled && !hidden && readStatus}
      </CaseTransactionPanel>
    ) : null;
  const visible =
    list.enabled ||
    list.diagnoses.length > 0 ||
    list.refusal !== null ||
    loadFailed;
  if (!visible)
    return compact && (hasTransactionContext || transactions.length > 0) ? (
      <CaseTransactionPanel
        compact
        context={context}
        transactions={transactions}
      >
        {sharedContext}
      </CaseTransactionPanel>
    ) : (
      sharedContext
    );
  const refusal = list.refusal ? (
    <ul className={own.refusal} role="status">
      {c.refusal.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  ) : null;

  async function check(
    input: { hash?: string; link?: string; network?: string },
    key: string,
    force: boolean,
  ) {
    if (!active.current || checking.current) return;
    const operation = { key };
    checking.current = operation;
    readRevision.current += 1;
    const access = accessRevision.current;
    setError("");
    setRunning(key);
    // One request id per click; the retry of a failed click reuses it.
    const id = clientIds.current.get(key) ?? newDiagnosisClientId();
    clientIds.current.set(key, id);
    try {
      const result = await runDiagnosis(account, room, thread, {
        clientId: id,
        force,
        ...input,
      });
      if (!active.current || access !== accessRevision.current) return;
      clientIds.current.delete(key);
      pollUntil.current = 0;
      setList((previous) =>
        previous
          ? "diagnosis" in result
            ? {
                ...previous,
                running: null,
                diagnoses: [
                  result.diagnosis,
                  ...previous.diagnoses.filter(
                    (item) => item.id !== result.diagnosis.id,
                  ),
                ],
              }
            : { ...previous, running: result.running }
          : previous,
      );
      void load();
    } catch (reason) {
      if (active.current && access === accessRevision.current) {
        if (
          reason instanceof CommunityApiError &&
          [401, 404].includes(reason.status)
        ) {
          clearAccess();
        } else {
          setError(errorText(reason));
          // A failed write must not leave the superseded list read loading.
          void load();
        }
      }
    } finally {
      if (checking.current === operation) {
        checking.current = null;
        if (active.current && access === accessRevision.current)
          setRunning(null);
      }
    }
  }
  const checks = list.diagnoses.map((view) => (
    <CheckCard
      key={view.id}
      compact={compact}
      view={view}
      context={context}
      replyText={replyText}
      onPutInReply={onPutInReply}
      name={name}
      onRate={async (rating) => {
        if (!active.current) return false;
        const access = accessRevision.current;
        setError("");
        try {
          await rateDiagnosis(account, room, thread, {
            diagnosis: view.id,
            rating,
          });
          return active.current && access === accessRevision.current;
        } catch (reason) {
          if (active.current && access === accessRevision.current) {
            if (
              reason instanceof CommunityApiError &&
              [401, 404].includes(reason.status)
            )
              clearAccess();
            else {
              setError(
                reason instanceof CommunityApiError && reason.status === 403
                  ? errorText(reason)
                  : "Your rating could not save. Try again.",
              );
              if (reason instanceof CommunityApiError && reason.status === 403)
                void load();
            }
          }
          return false;
        }
      }}
    />
  ));
  const submitPaste = (event: FormEvent) => {
    event.preventDefault();
    const value = paste.trim();
    if (!value) return;
    void check(
      /^https:/i.test(value) ? { link: value } : { hash: value },
      `paste:${value}`,
      false,
    );
  };
  const pasteForm = (
    <form className={own.paste} onSubmit={submitPaste}>
      <label className={styles.detailField}>
        <span>{c.pasteLabel}</span>
        <input
          value={paste}
          onChange={(event) => setPaste(event.target.value)}
          placeholder={c.pastePlaceholder}
          spellCheck={false}
          autoComplete="off"
        />
      </label>
      <button
        type="submit"
        className="button small secondary"
        disabled={running !== null || !paste.trim()}
      >
        {running?.startsWith("paste:") ? c.checking : c.check}
      </button>
    </form>
  );

  if (
    compact &&
    !hasTransactionContext &&
    transactions.length === 0 &&
    list.diagnoses.length === 0 &&
    list.unreadable === 0 &&
    !list.running &&
    !list.refusal
  )
    return optionalCheck(
      <>
        {sharedContext}
        {readStatus}
        {list.enabled && pasteForm}
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </>,
    );

  return (
    <CaseTransactionPanel
      compact={compact}
      context={context}
      transactions={transactions}
      result={list.diagnoses[0]}
      notice={
        compact ? (
          <>
            {refusal}
            {list.running && (
              <p className={panel.status} role="status">
                <span className={panel.pulse} aria-hidden="true" />
                {c.checking}
              </p>
            )}
            {list.unreadable > 0 && (
              <p className={styles.detailMuted}>{c.unreadable}</p>
            )}
          </>
        ) : undefined
      }
    >
      {sharedContext}
      {readStatus}
      <div className={own.head}>
        <h3>{c.title}</h3>
        <span className={panel.badge}>{c.teamOnly}</span>
      </div>
      {!compact && refusal}
      {transactions.length === 0 && list.diagnoses.length === 0 && (
        <p className={styles.detailMuted}>{c.noTransaction}</p>
      )}
      {transactions.length > 0 && (
        <ul className={panel.rows}>
          {transactions.map((tx) => {
            const solana = tx.network === "solana";
            const off = isOff(tx);
            const done = latest(tx.hash);
            const key = `tx:${tx.hash}`;
            return (
              <li key={tx.hash} className={own.candidate}>
                <TransactionReference tx={tx} />
                {off ? (
                  <span className={styles.detailMuted}>
                    {solana
                      ? c.solanaOff
                      : tx.network
                        ? fill(c.networkOff, {
                            network: supportNetworkName(tx.network),
                          })
                        : c.evmOff}
                  </span>
                ) : running === key ? (
                  <span className={panel.status} role="status">
                    <span className={panel.pulse} aria-hidden="true" />
                    {c.checking}
                  </span>
                ) : (
                  <button
                    type="button"
                    className="button small secondary"
                    disabled={running !== null || !list.enabled}
                    onClick={() =>
                      void check(
                        {
                          hash: tx.hash,
                          ...(tx.network ? { network: tx.network } : {}),
                        },
                        key,
                        Boolean(done),
                      )
                    }
                  >
                    {done
                      ? c.checkAgain
                      : compact
                        ? "Check transaction"
                        : c.check}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {!compact && list.running && running === null && (
        <p className={panel.status} role="status">
          <span className={panel.pulse} aria-hidden="true" />
          {c.checking}
        </p>
      )}
      {list.diagnoses.length > 0 && (
        <ul className={panel.rows}>{compact ? checks.slice(0, 1) : checks}</ul>
      )}
      {compact && checks.length > 1 && (
        <section className={own.advanced}>
          <h3>Previous checks</h3>
          <ul className={panel.rows}>{checks.slice(1)}</ul>
        </section>
      )}
      {!compact && list.unreadable > 0 && (
        <p className={styles.detailMuted}>{c.unreadable}</p>
      )}
      {list.enabled &&
        (compact ? (
          <section className={own.advanced}>
            <h3>{c.pasteLabel}</h3>
            {pasteForm}
          </section>
        ) : (
          pasteForm
        ))}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </CaseTransactionPanel>
  );
}
