"use client";

import { canManageWorkspace } from "@templ/chat/moderation-permissions";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import {
  ALERT_CHAT_DEFAULT_EVENTS,
  ALERT_CHAT_EVENTS,
  ALERT_ESCALATION_MINUTES,
  ALERT_SUBSCRIBABLE_EVENTS,
  ALERT_SUMMARY_MINUTES,
  ALERT_WEBHOOK_DEFAULT_EVENTS,
  SUPPORT_ALERT_DESTINATIONS,
  type AlertDestinationView,
  type AlertEscalationMinutes,
  type AlertLogEntry,
  type AlertSubscribableEvent,
  type AlertSummaryMinutes,
  type AlertsView,
  type SupportAlertDestination,
} from "@templ/chat/support-alerts";
import {
  CommunityApiError,
  communityFetch,
  roomPath,
} from "@/lib/community-client";
import { chatMutation } from "@/lib/chat-api";
import { readAccountMethods } from "@/lib/account-methods";
import {
  alertChannelAction,
  createAlertChannel,
  readAlertLog,
  readAlerts,
  readEscalation,
  saveEscalation,
  type NewAlertChannel,
} from "@/lib/alerts-client";
import {
  ALERTS_COPY as c,
  CHANNELS_INTRO,
  ESCALATION_LABELS,
  EVENT_LABELS,
  KIND_NAMES,
  LOG_OUTCOMES,
  SUMMARY_LABELS,
  pauseReason,
} from "@/lib/copy/alerts";
import {
  Badge,
  Callout,
  Card,
  CopyButton,
  Field,
  Skeleton,
  Spinner,
  ui,
} from "@/components/ui/ui";
import type { WorkspaceContext } from "./support-workspace";
import { UnsavedChanges } from "./unsaved-changes";
import styles from "./workspace-alerts.module.css";
import { NativeTelegram } from "./native-telegram";

const message = (reason: unknown) =>
  reason instanceof Error ? reason.message : c.error;
const isAlertsView = (value: unknown): value is AlertsView =>
  !!value &&
  typeof value === "object" &&
  Array.isArray((value as AlertsView).destinations);
const TRY_AGAIN = "Try again";
const SAVED = "Saved.";

/** One read for this section. `undefined` from `load`, or a 403 or 404 (the
 * viewer has no such tool), hides its card; any other failure shows with a
 * retry. A result shows only for the room, account and attempt it was read
 * for. */
type Read<T> = { key: string; value?: T; hidden?: true; error?: string };
function useAlertsRead<T>(
  load: (
    room: WorkspaceContext["room"],
    signal: AbortSignal,
  ) => Promise<T | undefined>,
  room: WorkspaceContext["room"],
  scope: string | null,
) {
  const [attempt, setAttempt] = useState(0);
  const [read, setRead] = useState<Read<T>>();
  const key = scope === null ? null : `${scope}:${attempt}`;
  useEffect(() => {
    if (key === null) return;
    const controller = new AbortController();
    load(room, controller.signal).then(
      (value) => {
        if (!controller.signal.aborted)
          setRead(value === undefined ? { key, hidden: true } : { key, value });
      },
      (reason: unknown) => {
        if (controller.signal.aborted) return;
        setRead(
          reason instanceof CommunityApiError &&
            (reason.status === 403 || reason.status === 404)
            ? { key, hidden: true }
            : { key, error: message(reason) },
        );
      },
    );
    return () => controller.abort();
  }, [load, room, key]);
  const current = key !== null && read?.key === key ? read : undefined;
  return {
    key,
    current,
    loading: key !== null && !current,
    retry: () => setAttempt((value) => value + 1),
    set: (value: T) => key !== null && setRead({ key, value }),
  };
}
const loadEscalation = (room: WorkspaceContext["room"], signal: AbortSignal) =>
  readEscalation(room, signal).then((data) =>
    (ALERT_ESCALATION_MINUTES as readonly unknown[]).includes(
      data?.escalateAfterMinutes,
    )
      ? data.escalateAfterMinutes
      : undefined,
  );
const loadChannels = (room: WorkspaceContext["room"], signal: AbortSignal) =>
  readAlerts(room, signal).then((data) =>
    isAlertsView(data) ? data : undefined,
  );
const loadPreference = (room: WorkspaceContext["room"], signal: AbortSignal) =>
  communityFetch<{ enabled?: unknown }>(
    roomPath(room, "conversations/preferences"),
    undefined,
    signal,
  ).then((data) => data?.enabled === true);

/** A card whose read is loading, or failed with a retry. */
function ReadState({
  title,
  error,
  onRetry,
}: {
  title: string;
  error?: string;
  onRetry: () => void;
}) {
  return (
    <Card title={title}>
      {error ? (
        <div className={styles.stack}>
          <Callout tone="danger" role="alert">
            {error}
          </Callout>
          <div className={styles.actions}>
            <button
              type="button"
              className="button small secondary"
              onClick={onRetry}
            >
              {TRY_AGAIN}
            </button>
          </div>
        </div>
      ) : (
        <Skeleton height={42} />
      )}
    </Card>
  );
}

/** Team alerts in Settings: your own email about waiting requests, the
 * escalation target, and (for the manager) the team's alert channels.
 * A save elsewhere in Settings reads nothing here again, so drafts stay. */
export function WorkspaceAlerts({ context }: { context: WorkspaceContext }) {
  const { room, account } = context;
  const admin = canManageWorkspace({
    isManager: context.manager,
    permissions: context.state?.viewer?.permissions,
  });
  const scope = `${room}:${account ?? "signed-out"}:${admin}`;
  const escalation = useAlertsRead(loadEscalation, room, scope);
  const channels = useAlertsRead(loadChannels, room, admin ? scope : null);
  const view = channels.current?.value;
  return (
    <section className={styles.stack} aria-label={c.sectionTitle} id="alerts">
      <YourAlerts context={context} />
      {admin && <NativeTelegram context={context} />}
      {!!view?.emailOverflowToday && (
        <Callout tone="warning" role="status">
          {c.emailOverflow(view.emailOverflowToday)}
        </Callout>
      )}
      {escalation.current?.value !== undefined ? (
        <EscalationCard
          key={escalation.key}
          context={context}
          initial={escalation.current.value}
          canEdit={admin}
        />
      ) : (
        (escalation.loading || escalation.current?.error) && (
          <ReadState
            title={c.escalationTitle}
            error={escalation.current?.error}
            onRetry={escalation.retry}
          />
        )
      )}
      {admin &&
        (view
          ? (view.available || view.destinations.length > 0) && (
              <TeamChannels
                context={context}
                view={view}
                onChange={channels.set}
              />
            )
          : (channels.loading || channels.current?.error) && (
              <ReadState
                title={c.channelsTitle}
                error={channels.current?.error}
                onRetry={channels.retry}
              />
            ))}
    </section>
  );
}

/** Your own email about waiting cases. The choice saves only on Save. */
function YourAlerts({ context }: { context: WorkspaceContext }) {
  const { room, account } = context;
  const preference = useAlertsRead(
    loadPreference,
    room,
    `${room}:${account ?? "signed-out"}`,
  );
  const saved = preference.current?.value;
  const [draft, setDraft] = useState<{ key: string; enabled: boolean }>();
  const enabled = draft && draft.key === preference.key ? draft.enabled : saved;
  const [email, setEmail] = useState<{
    verified: boolean;
    available: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (!account) return;
    const controller = new AbortController();
    readAccountMethods(account, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted)
          setEmail({
            verified: data.emailVerified,
            available: data.alertEmailAvailable,
          });
      })
      .catch(() => {});
    return () => controller.abort();
  }, [account]);
  if (saved === undefined || enabled === undefined)
    return preference.loading || preference.current?.error ? (
      <ReadState
        title={c.yourAlertsTitle}
        error={preference.current?.error}
        onRetry={preference.retry}
      />
    ) : null;
  const dirty = enabled !== saved;
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!dirty || busy || enabled === undefined) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const data = await chatMutation<{ enabled: boolean }>(
        account,
        roomPath(room, "conversations/preferences"),
        {
          enabled,
        },
      );
      preference.set(data.enabled === true);
      setDraft(undefined);
      setNotice(SAVED);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={(event) => void save(event)}>
      <UnsavedChanges dirty={dirty} />
      <Card
        title={c.yourAlertsTitle}
        description={c.yourAlertsDescription}
        footer={
          <button type="submit" className="button" disabled={!dirty || busy}>
            {busy && <Spinner />}
            {c.save}
          </button>
        }
      >
        <label className={ui.check}>
          <input
            type="checkbox"
            checked={enabled}
            disabled={busy || email?.available === false}
            onChange={(event) => {
              setDraft({
                key: preference.key ?? "",
                enabled: event.target.checked,
              });
              setNotice("");
            }}
          />
          {c.emailToggle}
        </label>
        {email && !email.available && (
          <p className={styles.note}>{c.emailUnavailable}</p>
        )}
        {email?.available && !email.verified && (
          <p className={styles.note}>
            <Link href="/settings/account">{c.addEmail}</Link>
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        {error && (
          <Callout tone="danger" role="alert">
            {error}
          </Callout>
        )}
      </Card>
    </form>
  );
}

function EscalationCard({
  context,
  initial,
  canEdit,
}: {
  context: WorkspaceContext;
  initial: AlertEscalationMinutes;
  canEdit: boolean;
}) {
  const [minutes, setMinutes] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!confirmed || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const data = await saveEscalation(context.account, context.room, minutes);
      setSaved(data.escalateAfterMinutes);
      setConfirmed(false);
      setNotice(c.escalationSaved);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={(event) => void save(event)}>
      <UnsavedChanges dirty={minutes !== saved} />
      <Card
        title={c.escalationTitle}
        footer={
          canEdit ? (
            <>
              <label className={ui.check}>
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={minutes === saved}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                {c.escalationConfirm}
              </label>
              <button
                type="submit"
                className="button"
                disabled={!confirmed || busy}
              >
                {busy && <Spinner />}
                {c.escalationSave}
              </button>
            </>
          ) : undefined
        }
      >
        <Field
          label={c.escalationField}
          hint={c.escalationHint.map((line) => (
            <span key={line} className={styles.note}>
              {line}
            </span>
          ))}
        >
          <select
            className={ui.input}
            value={minutes}
            disabled={!canEdit || busy}
            onChange={(event) => {
              setMinutes(Number(event.target.value) as AlertEscalationMinutes);
              setConfirmed(false);
              setNotice("");
            }}
          >
            {ALERT_ESCALATION_MINUTES.map((value) => (
              <option key={value} value={value}>
                {ESCALATION_LABELS[value]}
              </option>
            ))}
          </select>
        </Field>
        {notice && <p role="status">{notice}</p>}
        {error && (
          <Callout tone="danger" role="alert">
            {error}
          </Callout>
        )}
      </Card>
    </form>
  );
}

function TeamChannels({
  context,
  view,
  onChange,
}: {
  context: WorkspaceContext;
  view: AlertsView;
  onChange: (view: AlertsView) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const replace = (destination: AlertDestinationView) =>
    onChange({
      ...view,
      destinations: view.destinations.some((row) => row.id === destination.id)
        ? view.destinations.map((row) =>
            row.id === destination.id ? destination : row,
          )
        : [...view.destinations, destination],
    });
  const remove = (id: string) =>
    onChange({
      ...view,
      destinations: view.destinations.filter((row) => row.id !== id),
    });
  const full = view.destinations.length >= view.limits.destinations;
  return (
    <Card
      title={c.channelsTitle}
      actions={
        view.available && !adding && !full ? (
          <button
            type="button"
            className="button small"
            onClick={() => setAdding(true)}
          >
            {c.add}
          </button>
        ) : undefined
      }
    >
      <ul className={styles.points}>
        {CHANNELS_INTRO.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {!view.available && <Callout role="status">{c.unavailable}</Callout>}
      {secret && (
        <Callout tone="warning" role="alert">
          <strong>{c.secretTitle}</strong>
          <p>{c.secretBody}</p>
          <code className={styles.secret}>{secret}</code>
          <div className={styles.actions}>
            <CopyButton value={secret} label="Copy" />
            <button
              type="button"
              className="button small secondary"
              onClick={() => setSecret(null)}
            >
              {c.secretSaved}
            </button>
          </div>
        </Callout>
      )}
      {adding && (
        <AddChannel
          context={context}
          view={view}
          onCancel={() => setAdding(false)}
          onAdded={(destination, signingSecret) => {
            replace(destination);
            setAdding(false);
            if (signingSecret) setSecret(signingSecret);
          }}
        />
      )}
      <ul className={styles.rows}>
        {view.destinations.map((destination) => (
          <ChannelRow
            key={destination.id}
            context={context}
            destination={destination}
            available={view.available}
            onChange={replace}
            onRemove={() => remove(destination.id)}
            onSecret={setSecret}
          />
        ))}
      </ul>
    </Card>
  );
}

/** What a channel sends: the events it takes, and the waiting summary as
 * its own choice (`request.waiting` goes with a summary interval). */
type Choice = {
  events: AlertSubscribableEvent[];
  summary: AlertSummaryMinutes;
};
const pickable = (kind: SupportAlertDestination) =>
  (kind === "webhook" ? ALERT_SUBSCRIBABLE_EVENTS : ALERT_CHAT_EVENTS).filter(
    (event) => event !== "request.waiting",
  );
const defaultChoice = (kind: SupportAlertDestination): Choice => ({
  events: (kind === "webhook"
    ? ALERT_WEBHOOK_DEFAULT_EVENTS
    : ALERT_CHAT_DEFAULT_EVENTS
  ).filter((event) => event !== "request.waiting"),
  summary: 0,
});
const choiceOf = (destination: AlertDestinationView): Choice => ({
  events: destination.events.filter((event) => event !== "request.waiting"),
  summary: destination.events.includes("request.waiting")
    ? destination.summaryMinutes
    : 0,
});
/** The events to save: the unseen-reply alert only with wallet details on. */
const eventsOf = (
  choice: Choice,
  wallet: boolean,
): AlertSubscribableEvent[] => [
  ...choice.events.filter((event) => wallet || event !== "member.reply_unseen"),
  ...(choice.summary ? (["request.waiting"] as const) : []),
];

function EventChoice({
  kind,
  wallet,
  choice,
  onChange,
}: {
  kind: SupportAlertDestination;
  wallet: boolean;
  choice: Choice;
  onChange: (choice: Choice) => void;
}) {
  return (
    <fieldset className={styles.events}>
      <legend>{c.events}</legend>
      <div className={styles.eventGrid}>
        {pickable(kind).map((event) => {
          const needsWallet = event === "member.reply_unseen" && !wallet;
          return (
            <label key={event} className={ui.check}>
              <input
                type="checkbox"
                checked={!needsWallet && choice.events.includes(event)}
                disabled={needsWallet}
                onChange={(input) =>
                  onChange({
                    ...choice,
                    events: input.target.checked
                      ? [...choice.events, event]
                      : choice.events.filter((value) => value !== event),
                  })
                }
              />
              <span>
                {EVENT_LABELS[event]}
                {needsWallet && (
                  <span className={styles.note}>{c.unseenNeedsWallet}</span>
                )}
              </span>
            </label>
          );
        })}
      </div>
      <Field label={c.summary}>
        <select
          className={ui.input}
          value={choice.summary}
          onChange={(input) =>
            onChange({
              ...choice,
              summary: Number(input.target.value) as AlertSummaryMinutes,
            })
          }
        >
          {ALERT_SUMMARY_MINUTES.map((value) => (
            <option key={value} value={value}>
              {SUMMARY_LABELS[value]}
            </option>
          ))}
        </select>
      </Field>
    </fieldset>
  );
}

function AddChannel({
  context,
  view,
  onCancel,
  onAdded,
}: {
  context: WorkspaceContext;
  view: AlertsView;
  onCancel: () => void;
  onAdded: (destination: AlertDestinationView, signingSecret?: string) => void;
}) {
  const counts = (kind: SupportAlertDestination) =>
    view.destinations.filter((row) => row.kind === kind).length;
  const kinds = SUPPORT_ALERT_DESTINATIONS.filter(
    (kind) => counts(kind) < view.limits.perKind[kind],
  );
  const [kind, setKind] = useState<SupportAlertDestination>(
    kinds.includes("slack") ? "slack" : kinds[0],
  );
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [topic, setTopic] = useState("");
  const [wallet, setWallet] = useState(false);
  const [choice, setChoice] = useState<Choice>(() => defaultChoice(kind));
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!confirmed || busy) return;
    setBusy(true);
    setError("");
    const walletOn = kind === "webhook" && wallet;
    const sends = {
      events: eventsOf(choice, walletOn),
      summaryMinutes: choice.summary,
    };
    const input: NewAlertChannel =
      kind === "telegram"
        ? {
            kind,
            label,
            token,
            chatId,
            ...(topic ? { threadId: Number(topic) } : {}),
            ...sends,
          }
        : {
            kind,
            label,
            url,
            ...(kind === "webhook" ? { walletContext: wallet } : {}),
            ...sends,
          };
    try {
      const created = await createAlertChannel(
        context.account,
        context.room,
        input,
      );
      onAdded(created.destination, created.signingSecret);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }
  const urlLabel =
    kind === "slack"
      ? c.slackUrl
      : kind === "discord"
        ? c.discordUrl
        : c.webhookUrl;
  const dirty =
    !!(label || url || token || chatId || topic || wallet) ||
    JSON.stringify(choice) !== JSON.stringify(defaultChoice(kind));
  return (
    <form className={styles.form} onSubmit={(event) => void submit(event)}>
      <UnsavedChanges dirty={dirty} />
      <Field label={c.kind}>
        <select
          className={ui.input}
          value={kind}
          onChange={(event) => {
            const next = event.target.value as SupportAlertDestination;
            setKind(next);
            setChoice(defaultChoice(next));
          }}
        >
          {kinds.map((value) => (
            <option key={value} value={value}>
              {KIND_NAMES[value]}
            </option>
          ))}
        </select>
      </Field>
      <Field label={c.label}>
        <input
          className={ui.input}
          value={label}
          maxLength={40}
          required
          onChange={(event) => setLabel(event.target.value)}
        />
      </Field>
      {kind === "telegram" ? (
        <>
          <p className={styles.note}>{c.telegramHelp}</p>
          <Field label={c.telegramToken}>
            <input
              className={ui.input}
              value={token}
              autoComplete="off"
              required
              onChange={(event) => setToken(event.target.value)}
            />
          </Field>
          <Field label={c.telegramChat}>
            <input
              className={ui.input}
              value={chatId}
              required
              onChange={(event) => setChatId(event.target.value)}
            />
          </Field>
          <Field label={c.telegramTopic} optional>
            <input
              className={ui.input}
              value={topic}
              inputMode="numeric"
              onChange={(event) =>
                setTopic(event.target.value.replace(/\D/g, ""))
              }
            />
          </Field>
        </>
      ) : (
        <Field label={urlLabel}>
          <input
            className={ui.input}
            type="url"
            value={url}
            autoComplete="off"
            required
            onChange={(event) => setUrl(event.target.value)}
          />
        </Field>
      )}
      {kind === "webhook" && context.manager && (
        <label className={ui.check}>
          <input
            type="checkbox"
            checked={wallet}
            onChange={(event) => setWallet(event.target.checked)}
          />
          <span>
            {c.wallet}
            <span className={styles.note}>{c.walletHint}</span>
          </span>
        </label>
      )}
      <details className={styles.choose}>
        <summary>{c.chooseEvents}</summary>
        <EventChoice
          kind={kind}
          wallet={kind === "webhook" && wallet}
          choice={choice}
          onChange={setChoice}
        />
      </details>
      <label className={ui.check}>
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
        />
        {c.confirm}
      </label>
      {error && (
        <Callout tone="danger" role="alert">
          {error}
        </Callout>
      )}
      <div className={styles.actions}>
        <button type="submit" className="button" disabled={!confirmed || busy}>
          {busy && <Spinner />}
          {c.create}
        </button>
        <button type="button" className="button secondary" onClick={onCancel}>
          {c.cancel}
        </button>
      </div>
    </form>
  );
}

function ChannelRow({
  context,
  destination,
  available,
  onChange,
  onRemove,
  onSecret,
}: {
  context: WorkspaceContext;
  destination: AlertDestinationView;
  available: boolean;
  onChange: (destination: AlertDestinationView) => void;
  onRemove: () => void;
  onSecret: (secret: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [code, setCode] = useState("");
  const [log, setLog] = useState<AlertLogEntry[] | null>(null);
  const [editing, setEditing] = useState(false);
  const canChange = !destination.walletContext || context.manager;
  // Rotating the signing secret and turning a channel back on (which may
  // re-approve a channel another manager connected) each ask for a review.
  const [review, setReview] = useState<"rotate" | "resume" | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const act = async (
    action: Parameters<typeof alertChannelAction>[3],
    after?: (data: Awaited<ReturnType<typeof alertChannelAction>>) => void,
  ): Promise<boolean> => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const data = await alertChannelAction(
        context.account,
        context.room,
        destination.id,
        action,
      );
      if (data.destination) onChange(data.destination);
      if (data.error) {
        setError(data.error);
        return false;
      }
      after?.(data);
      return true;
    } catch (reason) {
      const details = (
        reason as {
          details?: { destination?: AlertDestinationView; error?: string };
        }
      ).details;
      if (details?.destination) onChange(details.destination);
      setError(details?.error ?? message(reason));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const closeReview = () => {
    setReview(null);
    setReviewed(false);
  };
  const confirmReview = async () => {
    if (!reviewed || !review) return;
    const done =
      review === "rotate"
        ? await act(
            { op: "rotate", confirmed: true },
            (data) => data.signingSecret && onSecret(data.signingSecret),
          )
        : await act({ op: "resume", confirmed: true });
    if (done) closeReview();
  };
  const save = async (input: EditedChannel) => {
    if (
      input.wallet !== undefined &&
      !(await act({
        op: "wallet-context",
        enabled: input.wallet,
        confirmed: true,
      }))
    )
      return;
    const done = await act({
      op: "update",
      confirmed: true,
      label: input.label,
      events: input.events,
      summaryMinutes: input.summaryMinutes,
    });
    if (done) {
      setEditing(false);
      setNotice(c.saved);
    }
  };
  const verifying =
    destination.kind === "telegram" && destination.status === "unverified";
  return (
    <li className={styles.row}>
      <div className={styles.rowHead}>
        <div>
          <strong>{destination.label}</strong>
          <div>
            <span>{KIND_NAMES[destination.kind]}</span>
            <span className={styles.target}>{destination.target}</span>
          </div>
        </div>
        <Badge
          tone={
            destination.status === "active"
              ? "brand"
              : destination.status === "paused"
                ? "warning"
                : "neutral"
          }
        >
          {destination.status === "active"
            ? "On"
            : destination.status === "paused"
              ? "Paused"
              : "Needs code"}
        </Badge>
      </div>
      {destination.status === "paused" && (
        <p className={styles.note}>
          {pauseReason(
            destination.pausedReason,
            destination.kind,
            destination.lastFailure?.at,
          )}
        </p>
      )}
      {destination.events.length > 0 && (
        <p className={styles.note}>
          {c.sends}{" "}
          {destination.events.map((event) => EVENT_LABELS[event]).join(", ")}
        </p>
      )}
      <p className={styles.note}>
        {destination.lastDeliveredAt
          ? `${c.lastDelivered} ${new Date(destination.lastDeliveredAt).toLocaleString()}`
          : c.never}
      </p>
      {destination.overflow && (
        <p className={styles.note}>{c.overflow(destination.overflow.count)}</p>
      )}
      {verifying && canChange && (
        <form
          className={styles.inline}
          onSubmit={(event) => {
            event.preventDefault();
            if (/^[0-9]{6}$/.test(code)) void act({ op: "verify", code });
          }}
        >
          <UnsavedChanges dirty={code !== ""} />
          <Field label={c.codeTitle}>
            <input
              className={ui.input}
              value={code}
              inputMode="numeric"
              maxLength={6}
              autoComplete="one-time-code"
              onChange={(event) =>
                setCode(event.target.value.replace(/\D/g, ""))
              }
            />
          </Field>
          <button
            type="submit"
            className="button small"
            disabled={busy || code.length !== 6}
          >
            {c.verify}
          </button>
        </form>
      )}
      <div className={styles.actions}>
        {canChange && destination.status === "active" && available && (
          <button
            type="button"
            className="button small secondary"
            disabled={busy}
            onClick={() =>
              void act({ op: "test" }, () => setNotice(c.testSent))
            }
          >
            {c.test}
          </button>
        )}
        {canChange && destination.status === "active" && (
          <button
            type="button"
            className="button small secondary"
            disabled={busy}
            onClick={() => void act({ op: "pause" })}
          >
            {c.pause}
          </button>
        )}
        {canChange &&
          destination.status === "paused" &&
          available &&
          destination.pausedReason !== "unreadable" &&
          destination.pausedReason !== "unverified-expired" && (
            <button
              type="button"
              className="button small secondary"
              disabled={busy}
              onClick={() => setReview("resume")}
            >
              {c.resume}
            </button>
          )}
        {canChange &&
          available &&
          destination.status !== "unverified" &&
          !editing && (
            <button
              type="button"
              className="button small secondary"
              disabled={busy}
              onClick={() => setEditing(true)}
            >
              {c.edit}
            </button>
          )}
        {canChange && destination.kind === "webhook" && available && (
          <button
            type="button"
            className="button small secondary"
            disabled={busy}
            onClick={() => setReview("rotate")}
          >
            {c.rotate}
          </button>
        )}
        <button
          type="button"
          className="button small secondary"
          disabled={busy}
          onClick={() => {
            if (log) return setLog(null);
            void readAlertLog(context.room, destination.id)
              .then((data) => setLog(data.entries))
              .catch((reason) => setError(message(reason)));
          }}
        >
          {log ? c.hideLog : c.log}
        </button>
        {canChange && (
          <button
            type="button"
            className="button small destructive"
            disabled={busy}
            onClick={() => {
              if (window.confirm(c.removeConfirm))
                void act({ op: "delete", confirmed: true }, () => onRemove());
            }}
          >
            {c.remove}
          </button>
        )}
      </div>
      {review && (
        <div
          className={styles.review}
          role="group"
          aria-label={review === "rotate" ? c.rotate : c.resume}
        >
          <p>
            {review === "rotate"
              ? c.rotateReview
              : c.resumeReview(destination.target)}
          </p>
          <label className={ui.check}>
            <input
              type="checkbox"
              checked={reviewed}
              onChange={(event) => setReviewed(event.target.checked)}
            />
            {review === "rotate" ? c.rotateConfirm : c.confirm}
          </label>
          <div className={styles.actions}>
            <button
              type="button"
              className="button small"
              disabled={!reviewed || busy}
              onClick={() => void confirmReview()}
            >
              {busy && <Spinner />}
              {c.confirmAction}
            </button>
            <button
              type="button"
              className="button small secondary"
              onClick={closeReview}
            >
              {c.cancel}
            </button>
          </div>
        </div>
      )}
      {editing && (
        <EditChannel
          destination={destination}
          owner={context.manager}
          busy={busy}
          onCancel={() => setEditing(false)}
          onSave={(input) => void save(input)}
        />
      )}
      {notice && (
        <p role="status" className={styles.note}>
          {notice}
        </p>
      )}
      {error && (
        <Callout tone="danger" role="alert">
          {error}
        </Callout>
      )}
      {log && (
        <ol className={styles.log} aria-label={c.log}>
          {log.length === 0 && <li>{c.emptyLog}</li>}
          {log.map((entry) => (
            <li key={`${entry.at}:${entry.event}:${entry.attempt}`}>
              <time dateTime={entry.at}>
                {new Date(entry.at).toLocaleString()}
              </time>{" "}
              {entry.event} {LOG_OUTCOMES[entry.outcome]}
              {entry.outcome === "failed" && entry.status
                ? `: ${entry.status}`
                : ""}
              {entry.outcome === "skipped" && entry.reason
                ? `: ${entry.reason}`
                : ""}
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}

type EditedChannel = {
  label: string;
  events: AlertSubscribableEvent[];
  summaryMinutes: AlertSummaryMinutes;
  /** Webhooks: the new wallet-details setting, when it changed. */
  wallet?: boolean;
};
function EditChannel({
  destination,
  owner,
  busy,
  onCancel,
  onSave,
}: {
  destination: AlertDestinationView;
  owner: boolean;
  busy: boolean;
  onCancel: () => void;
  onSave: (input: EditedChannel) => void;
}) {
  const webhook = destination.kind === "webhook";
  const [label, setLabel] = useState(destination.label);
  const [choice, setChoice] = useState<Choice>(() => choiceOf(destination));
  const [wallet, setWallet] = useState(destination.walletContext === true);
  const [confirmed, setConfirmed] = useState(false);
  const walletChanged =
    webhook && wallet !== (destination.walletContext === true);
  const dirty =
    label !== destination.label ||
    walletChanged ||
    JSON.stringify(choice) !== JSON.stringify(choiceOf(destination));
  return (
    <form
      className={styles.form}
      aria-label={c.edit}
      onSubmit={(event) => {
        event.preventDefault();
        if (!confirmed || busy) return;
        onSave({
          label,
          events: eventsOf(choice, webhook && wallet),
          summaryMinutes: choice.summary,
          ...(walletChanged ? { wallet } : {}),
        });
      }}
    >
      <UnsavedChanges dirty={dirty} />
      <Field label={c.label}>
        <input
          className={ui.input}
          value={label}
          maxLength={40}
          required
          onChange={(event) => setLabel(event.target.value)}
        />
      </Field>
      {webhook && owner && (
        <label className={ui.check}>
          <input
            type="checkbox"
            checked={wallet}
            onChange={(event) => setWallet(event.target.checked)}
          />
          <span>
            {c.wallet}
            <span className={styles.note}>{c.walletHint}</span>
          </span>
        </label>
      )}
      <EventChoice
        kind={destination.kind}
        wallet={webhook && wallet}
        choice={choice}
        onChange={setChoice}
      />
      {walletChanged && wallet && (
        <p className={styles.note}>{c.walletOnReview}</p>
      )}
      <label className={ui.check}>
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
        />
        {c.confirm}
      </label>
      <div className={styles.actions}>
        <button
          type="submit"
          className="button small"
          disabled={!confirmed || busy}
        >
          {busy && <Spinner />}
          {c.save}
        </button>
        <button
          type="button"
          className="button small secondary"
          onClick={onCancel}
        >
          {c.cancel}
        </button>
      </div>
    </form>
  );
}
