"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type { ChatRoomId } from "@templ/chat/index";
import type { ChatPrincipalId } from "@templ/chat/principal";
import {
  FOLLOW_UP_DEFAULT_LABELS,
  FOLLOW_UP_TYPE_LABELS,
  SUPPORT_FOLLOW_UP_TYPES,
  addDays,
  zonedToday,
  type SupportFollowUp,
  type SupportFollowUpList,
  type SupportFollowUpSettingsView,
  type SupportFollowUpType,
  type SupportFollowUpWatch,
} from "@templ/chat/support-follow-ups";
import { supportNetworkName } from "@templ/chat/support-context";
import type { SupportNetwork } from "@templ/chat/support";
import {
  FOLLOW_UP_COPY as c,
  FOLLOW_UP_ERRORS,
  POSITION_COPY as p,
  POSITION_FAILURES,
  POSITION_FAILURE_FALLBACK,
} from "@/lib/copy/follow-ups";
import { CommunityApiError } from "@/lib/community-client";
import { memberLabel, useMemberProfiles } from "@/lib/member-profiles";
import type { WorkspaceFeatures } from "@templ/chat/workspace-flags";
import {
  addFollowUp,
  changeFollowUp,
  discardUnreadableFollowUp,
  newFollowUpClientId,
  readFollowUpSettings,
  readFollowUps,
  readPositions,
  requestPosition,
  type FollowUpChange,
  type PositionReadView,
} from "@/lib/support-follow-ups-client";
import styles from "./team-conversations.module.css";
import panel from "./case-panels.module.css";
import own from "./follow-ups.module.css";

const fill = (text: string, values: Record<string, string>) =>
  text.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match);
const utc = (at: string) => at.slice(0, 16).replace("T", " ");
const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
const day = (value: string) => {
  const [, month, date] = value.split("-").map(Number);
  return `${MONTHS[month - 1]} ${date}`;
};
export function errorText(reason: unknown): string {
  if (reason instanceof CommunityApiError) {
    const code = (reason.details as { reason?: unknown } | undefined)?.reason;
    if (typeof code === "string" && FOLLOW_UP_ERRORS[code])
      return FOLLOW_UP_ERRORS[code];
    if (reason.status < 500 && reason.message) return reason.message;
  }
  return c.error;
}
/** The worker decides whether follow-ups run in this workspace. */
export function followUpsAllowed(
  features?: Partial<WorkspaceFeatures>,
): boolean {
  return features?.followUps === true;
}

function watchConditionText(
  watch: NonNullable<SupportFollowUp["watch"]>,
): string {
  if (watch.state === "failed") return c.watchFailed;
  if (watch.state === "expired") return c.watchExpired;
  if (
    watch.state === "watching" &&
    (watch.lastResult === "settled" || watch.lastResult === "reached")
  )
    return c.watchMet;
  const what =
    watch.kind === "tx"
      ? c.watchTx
      : watch.kind === "block"
        ? fill(c.watchBlock, { n: watch.number.toLocaleString("en-US") })
        : fill(c.watchTime, { time: utc(watch.at) });
  return `${c.watch} ${what}.`;
}

function watchText(watch: NonNullable<SupportFollowUp["watch"]>): string {
  const condition = watchConditionText(watch);
  return watch.readSource?.source === "alchemy"
    ? `${condition} ${c.watchSourceAlchemy}`
    : condition;
}

function WatchForm({
  networks,
  busy,
  onSave,
}: {
  networks: readonly SupportNetwork[];
  busy: boolean;
  onSave: (watch: SupportFollowUpWatch) => void;
}) {
  const [kind, setKind] = useState<"tx" | "block" | "time">("time");
  const [network, setNetwork] = useState<string>(networks[0] ?? "");
  const [hash, setHash] = useState("");
  const [number, setNumber] = useState("");
  const [at, setAt] = useState("");
  const evm = networks.filter((item) => item !== "solana");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (kind === "time") {
      if (!at) return;
      onSave({ kind: "time", at: new Date(`${at}Z`).toISOString() });
    } else if (kind === "block") {
      const value = Number(number);
      if (!Number.isSafeInteger(value) || value < 1 || !network) return;
      onSave({
        kind: "block",
        network: network as `eip155:${number}`,
        number: value,
      });
    } else {
      if (!hash.trim() || !network) return;
      onSave({
        kind: "tx",
        network: network as SupportNetwork,
        hash: hash.trim(),
      });
    }
  };
  return (
    <form className={own.watchForm} onSubmit={submit}>
      <label className={styles.detailField}>
        {c.watchKind}
        <select
          value={kind}
          onChange={(event) =>
            setKind(event.target.value as "tx" | "block" | "time")
          }
        >
          <option value="time">{c.watchKindTime}</option>
          {networks.length > 0 && <option value="tx">{c.watchKindTx}</option>}
          {evm.length > 0 && <option value="block">{c.watchKindBlock}</option>}
        </select>
      </label>
      {kind !== "time" && (
        <label className={styles.detailField}>
          {c.watchNetwork}
          <select
            value={network}
            onChange={(event) => setNetwork(event.target.value)}
          >
            {(kind === "block" ? evm : networks).map((item) => (
              <option key={item} value={item}>
                {supportNetworkName(item)}
              </option>
            ))}
          </select>
        </label>
      )}
      {kind === "tx" && (
        <label className={styles.detailField}>
          {c.watchHash}
          <input
            value={hash}
            onChange={(event) => setHash(event.target.value)}
          />
        </label>
      )}
      {kind === "block" && (
        <label className={styles.detailField}>
          {c.watchNumber}
          <input
            inputMode="numeric"
            value={number}
            onChange={(event) => setNumber(event.target.value)}
          />
        </label>
      )}
      {kind === "time" && (
        <label className={styles.detailField}>
          {c.watchAt}
          <input
            type="datetime-local"
            value={at}
            onChange={(event) => setAt(event.target.value)}
          />
        </label>
      )}
      <div className={panel.actions}>
        <button
          type="submit"
          className="button small secondary"
          disabled={busy}
        >
          {c.watchSave}
        </button>
      </div>
    </form>
  );
}

function FollowUpRow({
  item,
  all,
  viewer,
  account,
  name,
  groupName,
  busy,
  watchNetworks,
  onChange,
}: {
  item: SupportFollowUp;
  all: readonly SupportFollowUp[];
  viewer: "team" | "specialist";
  account: ChatPrincipalId | undefined;
  name: (id: string) => string;
  groupName: (id: string) => string;
  busy: boolean;
  watchNetworks: readonly SupportNetwork[];
  onChange: (input: FollowUpChange) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [watching, setWatching] = useState(false);
  const active = item.state === "open" || item.state === "blocked";
  const mine = item.owner !== null && item.owner === account;
  const team = viewer === "team";
  const canState = team || mine;
  const order = (id: string) => all.find((entry) => entry.id === id)?.order;
  return (
    <li className={panel.row} data-closed={!active}>
      <span className={panel.rowHead}>
        <span className={own.chip}>{FOLLOW_UP_TYPE_LABELS[item.type]}</span>
        <span className={own.state} data-state={item.state}>
          {c[item.state]}
        </span>
        {item.overdue && <span className={own.warn}>{c.overdue}</span>}
        {item.updateMissed && (
          <span className={own.warn}>{c.updateMissed}</span>
        )}
        {item.current && <span className={panel.by}>{c.current}</span>}
      </span>
      <span className={own.title}>{item.title}</span>
      <span className={panel.by}>
        {item.owner
          ? `${c.owner}: ${name(item.owner)}`
          : item.group
            ? fill(c.group, { name: groupName(item.group) })
            : `${c.owner}: ${c.ownerNone}`}
      </span>
      <ul className={own.facts}>
        {item.memberVisible && item.nextUpdateOn && (
          <li>{fill(c.nextUpdateOn, { date: day(item.nextUpdateOn) })}</li>
        )}
        {!item.memberVisible && <li>{c.hiddenFromMember}</li>}
        {item.dueAt && (
          <li>{fill(c.dueOn, { date: `${utc(item.dueAt)} UTC` })}</li>
        )}
        {item.dependsOn.map((id) => (
          <li key={id}>{fill(c.afterStep, { n: String(order(id) ?? id) })}</li>
        ))}
        {item.source === "agent" && <li>{c.byAgent}</li>}
        {item.source === "route" && <li>{c.byRoute}</li>}
        {item.watch && <li>{watchText(item.watch)}</li>}
      </ul>
      {item.link && (
        <a
          className={panel.link}
          href={item.link}
          target="_blank"
          rel="noopener noreferrer"
        >
          {new URL(item.link).hostname}
        </a>
      )}
      {confirming ? (
        <div className={panel.actions} role="group" aria-label={c.cancelAsk}>
          <span>{c.cancelAsk}</span>
          <button
            type="button"
            className="button small danger"
            disabled={busy}
            onClick={() => {
              setConfirming(false);
              onChange({
                op: "state",
                state: "cancelled",
                revision: item.revision,
              });
            }}
          >
            {c.cancelYes}
          </button>
          <button
            type="button"
            className="button small quiet"
            onClick={() => setConfirming(false)}
          >
            {c.keep}
          </button>
        </div>
      ) : (
        <div className={panel.actions}>
          {active && item.owner === null && (
            <button
              type="button"
              className="button small secondary"
              disabled={busy}
              onClick={() => onChange({ op: "take", revision: item.revision })}
            >
              {c.take}
            </button>
          )}
          {active && canState && (
            <button
              type="button"
              className="button small secondary"
              disabled={busy}
              onClick={() =>
                onChange({
                  op: "state",
                  state: "done",
                  revision: item.revision,
                })
              }
            >
              {c.markDone}
            </button>
          )}
          {item.state === "open" && canState && (
            <button
              type="button"
              className="button small quiet"
              disabled={busy}
              onClick={() =>
                onChange({
                  op: "state",
                  state: "blocked",
                  revision: item.revision,
                })
              }
            >
              {c.block}
            </button>
          )}
          {item.state === "blocked" && canState && (
            <button
              type="button"
              className="button small quiet"
              disabled={busy}
              onClick={() =>
                onChange({
                  op: "state",
                  state: "open",
                  revision: item.revision,
                })
              }
            >
              {c.reopen}
            </button>
          )}
          {!active && team && (
            <button
              type="button"
              className="button small quiet"
              disabled={busy}
              onClick={() =>
                onChange({
                  op: "state",
                  state: "open",
                  revision: item.revision,
                })
              }
            >
              {c.reopen}
            </button>
          )}
          {active && mine && (
            <button
              type="button"
              className="button small quiet"
              disabled={busy}
              onClick={() =>
                onChange({ op: "release", revision: item.revision })
              }
            >
              {c.giveBack}
            </button>
          )}
          {active && team && (
            <button
              type="button"
              className="button small quiet"
              disabled={busy}
              onClick={() => setWatching((value) => !value)}
            >
              {item.watch?.state === "watching" ? c.watchClear : c.watchSet}
            </button>
          )}
          {active && team && (
            <button
              type="button"
              className="button small quiet"
              disabled={busy}
              onClick={() => setConfirming(true)}
            >
              {c.cancel}
            </button>
          )}
        </div>
      )}
      {watching &&
        team &&
        active &&
        (item.watch?.state === "watching" ? (
          <div className={panel.actions}>
            <button
              type="button"
              className="button small secondary"
              disabled={busy}
              onClick={() => {
                setWatching(false);
                onChange({
                  op: "update",
                  revision: item.revision,
                  watch: null,
                });
              }}
            >
              {c.watchClear}
            </button>
          </div>
        ) : (
          <WatchForm
            networks={watchNetworks}
            busy={busy}
            onSave={(watch) => {
              setWatching(false);
              onChange({ op: "update", revision: item.revision, watch });
            }}
          />
        ))}
    </li>
  );
}

/** Stored follow-ups that fail their check: counted, never shown. A person
 * on the team can remove one after a confirmation. */
function Unreadable({
  count,
  ids,
  busy,
  onRemove,
}: {
  count: number;
  ids: readonly string[];
  busy: boolean;
  onRemove: (id: string) => void;
}) {
  const [asking, setAsking] = useState<string | null>(null);
  return (
    <div className={styles.detailMuted}>
      <p>
        {count === 1
          ? c.unreadableOne
          : fill(c.unreadable, { n: String(count) })}
      </p>
      {asking ? (
        <div
          className={panel.actions}
          role="group"
          aria-label={fill(c.discardAsk, { id: asking })}
        >
          <span>{fill(c.discardAsk, { id: asking })}</span>
          <button
            type="button"
            className="button small danger"
            disabled={busy}
            onClick={() => {
              setAsking(null);
              onRemove(asking);
            }}
          >
            {c.discardYes}
          </button>
          <button
            type="button"
            className="button small quiet"
            onClick={() => setAsking(null)}
          >
            {c.keep}
          </button>
        </div>
      ) : (
        ids.length > 0 && (
          <div className={panel.actions}>
            {ids.map((id) => (
              <button
                key={id}
                type="button"
                className="button small quiet"
                disabled={busy}
                onClick={() => setAsking(id)}
              >
                {fill(c.discard, { id })}
              </button>
            ))}
          </div>
        )
      )}
    </div>
  );
}

function AddForm({
  list,
  settings,
  timeZone,
  busy,
  name,
  onAdd,
}: {
  list: SupportFollowUpList;
  settings: SupportFollowUpSettingsView | null;
  timeZone: string;
  busy: boolean;
  name: (id: string) => string;
  onAdd: (input: {
    type: SupportFollowUpType;
    title: string;
    owner: string;
    publicLabel: string;
    nextUpdateOn: string;
    dueAt: string;
    link: string;
    dependsOn: string[];
    memberVisible: boolean;
  }) => Promise<boolean>;
}) {
  const [type, setType] = useState<SupportFollowUpType>("strategy");
  const [title, setTitle] = useState("");
  const [owner, setOwner] = useState("");
  const [label, setLabel] = useState<string>(FOLLOW_UP_DEFAULT_LABELS.strategy);
  const [labelTouched, setLabelTouched] = useState(false);
  // The workspace's today, read once when the form opens.
  const [today] = useState(() => zonedToday(Date.now(), timeZone));
  const [next, setNext] = useState(() => addDays(today, 3));
  const [due, setDue] = useState("");
  const [link, setLink] = useState("");
  const [after, setAfter] = useState<string[]>([]);
  const [visible, setVisible] = useState(true);
  const latest = Math.max(0, ...list.cases.map((item) => item.seq));
  const earlier = list.followUps.filter(
    (item) =>
      item.seq === latest &&
      (item.state === "open" || item.state === "blocked"),
  );
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;
    const saved = await onAdd({
      type,
      title: title.trim(),
      owner,
      publicLabel: label.trim(),
      nextUpdateOn: next,
      dueAt: due,
      link: link.trim(),
      dependsOn: after,
      memberVisible: visible,
    });
    if (saved) {
      setTitle("");
      setLink("");
      setDue("");
      setAfter([]);
    }
  };
  return (
    <form className={own.form} onSubmit={(event) => void submit(event)}>
      <div className={panel.formRow}>
        <label className={styles.detailField}>
          {c.type}
          <select
            value={type}
            onChange={(event) => {
              const value = event.target.value as SupportFollowUpType;
              setType(value);
              if (!labelTouched) setLabel(FOLLOW_UP_DEFAULT_LABELS[value]);
            }}
          >
            {SUPPORT_FOLLOW_UP_TYPES.map((item) => (
              <option key={item} value={item}>
                {FOLLOW_UP_TYPE_LABELS[item]}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.detailField}>
          {c.owner}
          <select
            value={owner}
            onChange={(event) => setOwner(event.target.value)}
          >
            <option value="">{c.ownerNone}</option>
            {settings && settings.eligible.staff.length > 0 && (
              <optgroup label={c.ownerTeam}>
                {settings.eligible.staff.map((id) => (
                  <option key={id} value={id}>
                    {name(id)}
                  </option>
                ))}
              </optgroup>
            )}
            {settings && settings.eligible.specialists.length > 0 && (
              <optgroup label={c.ownerSpecialists}>
                {settings.eligible.specialists.map((id) => (
                  <option key={id} value={id}>
                    {name(id)}
                  </option>
                ))}
              </optgroup>
            )}
            {settings && settings.groups.length > 0 && (
              <optgroup label={c.ownerGroups}>
                {settings.groups.map((group) => (
                  <option key={group.id} value={`group:${group.id}`}>
                    {group.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
      </div>
      <label className={styles.detailField}>
        {c.what}
        <input
          maxLength={120}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          aria-describedby="follow-up-what-help"
        />
      </label>
      <span id="follow-up-what-help" className={panel.by}>
        {c.whatHelp}
      </span>
      <label className={own.check}>
        <input
          type="checkbox"
          checked={visible}
          onChange={(event) => setVisible(event.target.checked)}
        />
        {c.showMember}
      </label>
      {visible && (
        <div className={panel.formRow}>
          <label className={styles.detailField}>
            {c.lineLabel}
            <input
              maxLength={48}
              value={label}
              onChange={(event) => {
                setLabel(event.target.value);
                setLabelTouched(true);
              }}
              aria-describedby="follow-up-line-help"
            />
          </label>
          <label className={styles.detailField}>
            {c.nextUpdate}
            <input
              type="date"
              value={next}
              min={today}
              max={addDays(today, 30)}
              onChange={(event) => setNext(event.target.value)}
            />
          </label>
        </div>
      )}
      {visible && (
        <span id="follow-up-line-help" className={panel.by}>
          {c.lineHelp}
        </span>
      )}
      <div className={panel.formRow}>
        <label className={styles.detailField}>
          {c.due}
          <input
            type="datetime-local"
            value={due}
            onChange={(event) => setDue(event.target.value)}
          />
        </label>
        <label className={styles.detailField}>
          {c.link}
          <input
            type="url"
            maxLength={300}
            value={link}
            onChange={(event) => setLink(event.target.value)}
          />
        </label>
      </div>
      {earlier.length > 0 && (
        <label className={styles.detailField}>
          {c.after}
          <select
            multiple
            value={after}
            onChange={(event) =>
              setAfter(
                [...event.target.selectedOptions].map((option) => option.value),
              )
            }
          >
            {earlier.map((item) => (
              <option key={item.id} value={item.id}>
                {`#${item.order} ${item.title}`}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className={panel.actions}>
        <button
          type="submit"
          className="button small"
          disabled={busy || !title.trim()}
        >
          {busy ? c.adding : c.add}
        </button>
      </div>
    </form>
  );
}

function PositionReads({
  room,
  account,
  thread,
  networks,
  refreshKey,
}: {
  room: ChatRoomId;
  account: ChatPrincipalId | undefined;
  thread: string;
  networks: readonly SupportNetwork[];
  refreshKey: number;
}) {
  const [reads, setReads] = useState<PositionReadView[]>([]);
  const [network, setNetwork] = useState<string>(networks[0] ?? "");
  const [token, setToken] = useState("");
  const [compare, setCompare] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(
    (signal?: AbortSignal) =>
      readPositions(room, thread, signal).then(
        (next) => setReads(next.positions),
        () => undefined,
      ),
    [room, thread],
  );
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, refreshKey]);
  const queued = reads.some((item) => item.state === "queued");
  useEffect(() => {
    if (!queued) return;
    const timer = setTimeout(() => void load(), 3_000);
    return () => clearTimeout(timer);
  }, [queued, reads, load]);
  const run = async (kind: "position" | "legacy") => {
    setBusy(true);
    setError("");
    try {
      await requestPosition(account, room, thread, {
        clientId: newFollowUpClientId(),
        kind,
        network,
        ...(kind === "position" ? { token: token.trim() } : {}),
        ...(kind === "position" && compare
          ? { compareBlock: Number(compare) }
          : {}),
      });
      await load();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };
  if (!networks.length) return null;
  return (
    <div className={own.positions}>
      <h4>{p.title}</h4>
      <p className={panel.by}>{p.lede}</p>
      <div className={panel.formRow}>
        <label className={styles.detailField}>
          {p.network}
          <select
            value={network}
            onChange={(event) => setNetwork(event.target.value)}
          >
            {networks.map((item) => (
              <option key={item} value={item}>
                {supportNetworkName(item)}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.detailField}>
          {p.token}
          <input
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
        </label>
      </div>
      {network !== "solana" && (
        <label className={styles.detailField}>
          {p.compare}
          <input
            inputMode="numeric"
            value={compare}
            onChange={(event) => setCompare(event.target.value)}
          />
        </label>
      )}
      <div className={panel.actions}>
        <button
          type="button"
          className="button small secondary"
          disabled={busy || !token.trim()}
          onClick={() => void run("position")}
        >
          {p.read}
        </button>
        <button
          type="button"
          className="button small quiet"
          disabled={busy}
          onClick={() => void run("legacy")}
        >
          {p.legacy}
        </button>
      </div>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {reads.length > 0 && (
        <ul className={own.facts}>
          {reads.map((item) => (
            <li key={item.id}>
              {item.state === "queued" ? (
                <span className={panel.status} role="status">
                  <span className={panel.pulse} aria-hidden="true" />
                  {p.queued}
                </span>
              ) : item.state === "unavailable" ? (
                fill(p.unavailable, {
                  reason:
                    (item.reason && POSITION_FAILURES[item.reason]) ||
                    POSITION_FAILURE_FALLBACK,
                })
              ) : item.kind === "legacy" ? (
                item.legacyFacts?.length ? (
                  item.legacyFacts.map((fact) => (
                    <span key={fact.label}>
                      {fill(p.held, { label: fact.label })}
                    </span>
                  ))
                ) : (
                  p.noneHeld
                )
              ) : (
                fill(p.done, { ids: item.evidence.join(", ") })
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Follow-ups on one request, for the team and for a specialist who owns
 * one there. The team adds, changes, watches and cancels; a specialist
 * marks their own done or blocked, or gives it back. The member sees only
 * the line shown at the top. */
export function FollowUpsSection({
  room,
  account,
  thread,
  viewer = "team",
  enabled = false,
  refreshKey = 0,
  onChanged,
}: {
  room: ChatRoomId;
  account: ChatPrincipalId | undefined;
  thread: string;
  viewer?: "team" | "specialist";
  enabled?: boolean;
  refreshKey?: number;
  onChanged?: () => void;
}) {
  const [list, setList] = useState<SupportFollowUpList | null>(null);
  const [settings, setSettings] = useState<SupportFollowUpSettingsView | null>(
    null,
  );
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const clientId = useRef<string | null>(null);
  const load = useCallback(
    (signal?: AbortSignal) =>
      readFollowUps(room, thread, signal).then(
        (next) => {
          // A worker without these routes, or anything else answering, hides
          // the section.
          if (
            !next ||
            !Array.isArray(next.followUps) ||
            !Array.isArray(next.cases)
          )
            setHidden(true);
          else setList(next);
        },
        (reason: unknown) => {
          if (signal?.aborted) return;
          if (
            reason instanceof CommunityApiError &&
            (reason.status === 404 || reason.status === 503)
          )
            setHidden(true);
        },
      ),
    [room, thread],
  );
  useEffect(() => {
    if (!enabled || hidden) return;
    const controller = new AbortController();
    void load(controller.signal);
    if (viewer === "team")
      void readFollowUpSettings(room, controller.signal).then(
        (next) =>
          setSettings(
            next && Array.isArray(next.groups) && next.eligible ? next : null,
          ),
        () => undefined,
      );
    return () => controller.abort();
  }, [hidden, load, room, viewer, refreshKey, enabled]);
  const people = [
    ...new Set(
      [
        ...(list?.followUps ?? []).flatMap((item) =>
          item.owner ? [item.owner] : [],
        ),
        ...(settings?.eligible.staff ?? []),
        ...(settings?.eligible.specialists ?? []),
      ].filter((id) => id !== account),
    ),
  ];
  const profiles = useMemberProfiles(people);
  const name = (id: string) =>
    id === account ? c.you : memberLabel(profiles.get(id), id);
  const groupName = (id: string) =>
    settings?.groups.find((group) => group.id === id)?.name ?? id;

  if (!enabled || hidden || !list) return null;
  if (!list.available && list.followUps.length === 0) return null;

  async function change(id: string, input: FollowUpChange) {
    setBusy(true);
    setError("");
    try {
      const next = await changeFollowUp(account, room, thread, id, input);
      setList(next);
      onChanged?.();
    } catch (reason) {
      setError(errorText(reason));
      void load();
    } finally {
      setBusy(false);
    }
  }
  async function discard(id: string) {
    setBusy(true);
    setError("");
    try {
      setList(await discardUnreadableFollowUp(account, room, thread, id));
      onChanged?.();
    } catch (reason) {
      setError(errorText(reason));
      void load();
    } finally {
      setBusy(false);
    }
  }
  async function add(input: {
    type: SupportFollowUpType;
    title: string;
    owner: string;
    publicLabel: string;
    nextUpdateOn: string;
    dueAt: string;
    link: string;
    dependsOn: string[];
    memberVisible: boolean;
  }) {
    setBusy(true);
    setError("");
    clientId.current ??= newFollowUpClientId();
    try {
      const next = await addFollowUp(account, room, thread, {
        clientId: clientId.current,
        type: input.type,
        title: input.title,
        ...(input.owner.startsWith("group:")
          ? { group: input.owner.slice("group:".length) }
          : input.owner
            ? { owner: input.owner as ChatPrincipalId }
            : {}),
        memberVisible: input.memberVisible,
        ...(input.memberVisible
          ? { publicLabel: input.publicLabel, nextUpdateOn: input.nextUpdateOn }
          : {}),
        ...(input.dueAt
          ? { dueAt: new Date(`${input.dueAt}Z`).toISOString() }
          : {}),
        ...(input.link ? { link: input.link } : {}),
        ...(input.dependsOn.length ? { dependsOn: input.dependsOn } : {}),
      });
      clientId.current = null;
      setList(next);
      setAdding(false);
      onChanged?.();
      return true;
    } catch (reason) {
      setError(errorText(reason));
      return false;
    } finally {
      setBusy(false);
    }
  }
  const open = list.followUps.filter(
    (item) => item.state === "open" || item.state === "blocked",
  );
  // Next-update dates are days in the workspace's time zone, as the
  // service checks them.
  const timeZone = list.timeZone || "UTC";
  return (
    <div className={styles.detailSection}>
      <div className={own.head}>
        <h3>{c.title}</h3>
        <span className={panel.badge}>{c.teamOnly}</span>
      </div>
      {list.line && (
        <dl className={own.line}>
          <dt>{c.memberSees}</dt>
          <dd>{list.line.text}</dd>
        </dl>
      )}
      {list.followUps.length === 0 ? (
        <p className={styles.detailMuted}>{c.empty}</p>
      ) : (
        <ul className={panel.rows}>
          {list.followUps.map((item) => (
            <FollowUpRow
              key={item.id}
              item={item}
              all={list.followUps}
              viewer={viewer}
              account={account}
              name={name}
              groupName={groupName}
              busy={busy}
              watchNetworks={list.watchNetworks}
              onChange={(input) => void change(item.id, input)}
            />
          ))}
        </ul>
      )}
      {viewer === "team" && open.length > 0 && (
        <p className={styles.detailMuted} role="note">
          {c.resolveBlocked}
        </p>
      )}
      {list.unreadable > 0 && (
        <Unreadable
          count={list.unreadable}
          ids={viewer === "team" && list.available ? list.unreadableIds : []}
          busy={busy}
          onRemove={(id) => void discard(id)}
        />
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {viewer === "team" &&
        list.available &&
        (adding ? (
          <AddForm
            list={list}
            settings={settings}
            timeZone={timeZone}
            busy={busy}
            name={name}
            onAdd={add}
          />
        ) : (
          <div className={panel.actions}>
            <button
              type="button"
              className="button small secondary"
              onClick={() => setAdding(true)}
            >
              {c.add}
            </button>
          </div>
        ))}
      {viewer === "team" && (
        <PositionReads
          room={room}
          account={account}
          thread={thread}
          networks={list.watchNetworks}
          refreshKey={refreshKey}
        />
      )}
    </div>
  );
}
