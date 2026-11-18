"use client";

import { useEffect, useState } from "react";
import { IconArrowRight } from "@tabler/icons-react";
import type { ChatRoomId } from "@templ/chat/index";
import type { ChatPrincipalId } from "@templ/chat/principal";
import {
  PRODUCT_DISPUTE_REASONS,
  PRODUCT_DISPUTE_TEXT_MAX,
  type ProductChargeView,
  type ProductDisputeReason,
} from "@templ/chat/product-catalog";
import {
  disputeCharge,
  readCharges,
  type ChargePage,
} from "@/lib/product-client";
import { useMemberProfiles } from "@/lib/member-profiles";
import { formatDay } from "@/lib/product-format";
import {
  RESOLVED_CASES_DOCS,
  addedPoints,
  chargeCloserLabel,
  chargeStateLabel,
  contributionBillingLabel,
} from "@/lib/product-offer";
import {
  readConversationMessages,
  resolveConversation,
  updateSupportWorkflow,
} from "@/lib/team-conversations-client";
import { Callout, Card, EmptyState, Skeleton } from "@/components/ui/ui";
import type { WorkspaceContext } from "./support-workspace";
import styles from "./workspace.module.css";
import plan from "./workspace-plan.module.css";

const REASON_LABELS: Record<ProductDisputeReason, string> = {
  spam: "It was spam",
  test: "It was our own test",
  duplicate: "Same user, same problem",
  "not-resolved": "It wasn’t resolved",
  other: "Something else",
};
const EVENT_LABELS: Record<
  ProductChargeView["events"][number]["kind"],
  string
> = {
  resolved: "Resolved",
  confirmed: "User confirmed",
  reopened: "Reopened",
  voided: "Dropped",
  excluded: "Marked spam",
  final: "Final",
  disputed: "Disputed",
  credited: "Credited",
  "dispute-rejected": "Dispute declined",
};

function ChargeActor({
  actor,
}: {
  actor: ProductChargeView["events"][number]["actor"];
}) {
  const profiles = useMemberProfiles(actor.principal ? [actor.principal] : []);
  const name = actor.principal
    ? profiles.get(actor.principal)?.displayName?.trim()
    : null;
  return (
    <>
      {actor.kind === "team"
        ? name || "a teammate"
        : actor.kind === "member"
          ? "the user"
          : actor.kind === "operator"
            ? "Templ"
            : "the system"}
    </>
  );
}

type Loaded = { key: string; page?: ChargePage; error?: string };

function useCharges(
  room: ChatRoomId,
  key: string,
  state: "billing-soon" | undefined,
) {
  const [loaded, setLoaded] = useState<Loaded>();
  const [more, setMore] = useState<{
    key: string;
    charges: ProductChargeView[];
    next: string | null;
  }>();
  useEffect(() => {
    const controller = new AbortController();
    readCharges(room, state ? { state } : {}, controller.signal).then(
      (page) => {
        if (!controller.signal.aborted) setLoaded({ key, page });
      },
      (reason) => {
        if (!controller.signal.aborted)
          setLoaded({
            key,
            error:
              reason instanceof Error
                ? reason.message
                : "Charges could not load.",
          });
      },
    );
    return () => controller.abort();
  }, [room, key, state]);
  const current = loaded?.key === key ? loaded : undefined;
  const extra = more?.key === key ? more : undefined;
  const charges = [
    ...(current?.page?.charges ?? []),
    ...(extra?.charges ?? []),
  ];
  const next = extra ? extra.next : (current?.page?.next ?? null);
  async function loadMore() {
    if (!next) return;
    const page = await readCharges(room, {
      ...(state ? { state } : {}),
      cursor: next,
    });
    setMore({
      key,
      charges: [...(extra?.charges ?? []), ...page.charges],
      next: page.next,
    });
  }
  return { current, charges, next, loadMore };
}

function ChargeHead({ charge }: { charge: ProductChargeView }) {
  const added = addedPoints(charge.added);
  const billable = ["pending", "confirmed", "final"].includes(charge.state)
    ? contributionBillingLabel(charge.contributions)
    : null;
  return (
    <>
      <div className={plan.chargeHead}>
        <strong>{chargeStateLabel(charge)}</strong>
        <span className={plan.chargeMeta}>
          {chargeCloserLabel(charge)}, resolved {formatDay(charge.resolvedAt)}
        </span>
      </div>
      {billable && <p className={plan.chargeMeta}>{billable}</p>}
      {added.length > 0 && (
        <ul className={plan.added} aria-label="What Templ added">
          {added.map((point) => (
            <li key={point}>{point}</li>
          ))}
        </ul>
      )}
    </>
  );
}

/** Pending and confirmed charges with who resolved them and when each goes
 * final. Staff who can read the thread may reopen a pending one or mark
 * any of them spam; a selection marks several at once. Templ AI resolves
 * the user hasn't confirmed come first. */
export function PlanBillingSoon({
  context,
  onChanged,
}: {
  context: WorkspaceContext;
  onChanged: () => void;
}) {
  const { room, account, revision } = context;
  const [bump, setBump] = useState(0);
  const key = `${room}:${account}:${revision}:${bump}`;
  const { current, charges, next, loadMore } = useCharges(
    room,
    key,
    "billing-soon",
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const markable = charges.filter((charge) => charge.thread);
  const chosen = markable.filter((charge) => selected.has(charge.ref));
  async function act(rows: ProductChargeView[], action: "spam" | "reopen") {
    setBusy(true);
    setNote("");
    let done = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        if (action === "spam")
          await updateSupportWorkflow(account, room, row.thread!, {
            action: "status",
            state: "spam",
          });
        else {
          const current = await readConversationMessages(room, row.thread!, {
            limit: 1,
          });
          await resolveConversation(account, room, row.thread!, false, {
            ifRevision: current.conversation.revision,
          });
        }
        done++;
      } catch {
        failed++;
      }
    }
    setBusy(false);
    setConfirming(false);
    setSelected(new Set());
    setNote(
      failed
        ? `${done} changed. ${failed} couldn’t change; open them in the inbox.`
        : action === "spam"
          ? `Marked ${done} as spam. They won’t bill.`
          : "Reopened. It won’t bill unless it’s resolved again.",
    );
    setBump((value) => value + 1);
    onChanged();
  }
  return (
    <Card
      title="Billing soon"
      description="Resolved cases that go final unless reopened or marked spam."
      actions={
        chosen.length > 0 &&
        (confirming ? (
          <span className={plan.chargeActions}>
            <button
              type="button"
              className="button small"
              disabled={busy}
              onClick={() => void act(chosen, "spam")}
            >
              {busy ? "Marking…" : `Mark ${chosen.length} as spam`}
            </button>
            <button
              type="button"
              className="button small secondary"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="button small secondary"
            onClick={() => setConfirming(true)}
          >
            Mark spam…
          </button>
        ))
      }
    >
      {note && (
        <p className={styles.small} role="status" style={{ marginTop: 0 }}>
          {note}
        </p>
      )}
      {!current ? (
        <Skeleton height={60} />
      ) : current.error ? (
        <Callout tone="danger" role="alert">
          {current.error}
        </Callout>
      ) : charges.length === 0 ? (
        <EmptyState title="Nothing waiting">
          Resolved cases show here until they go final.
        </EmptyState>
      ) : (
        <ul className={plan.charges}>
          {charges.map((charge) => (
            <li key={charge.ref} className={plan.charge}>
              <div className={plan.chargeHead}>
                {charge.thread ? (
                  <label className={plan.select}>
                    <input
                      type="checkbox"
                      checked={selected.has(charge.ref)}
                      onChange={(event) =>
                        setSelected((value) => {
                          const copy = new Set(value);
                          if (event.target.checked) copy.add(charge.ref);
                          else copy.delete(charge.ref);
                          return copy;
                        })
                      }
                    />
                    <strong>{chargeCloserLabel(charge)}</strong>
                  </label>
                ) : (
                  <strong>{chargeCloserLabel(charge)}</strong>
                )}
                <span className={plan.chargeMeta}>
                  {chargeStateLabel(charge)}
                </span>
              </div>
              {charge.thread && (
                <div className={plan.chargeActions}>
                  <button
                    type="button"
                    className="button small secondary"
                    onClick={() => context.go("inbox", charge.thread)}
                  >
                    Open
                  </button>
                  {charge.state === "pending" && (
                    <button
                      type="button"
                      className="button small secondary"
                      disabled={busy}
                      onClick={() => void act([charge], "reopen")}
                    >
                      Reopen
                    </button>
                  )}
                  <button
                    type="button"
                    className="button small secondary"
                    disabled={busy}
                    onClick={() => void act([charge], "spam")}
                  >
                    Mark spam
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {next && (
        <button
          type="button"
          className="button small secondary"
          onClick={() => void loadMore()}
        >
          Show more
        </button>
      )}
    </Card>
  );
}

function DisputeForm({
  charge,
  account,
  room,
  onDone,
  onCancel,
}: {
  charge: ProductChargeView;
  account?: ChatPrincipalId;
  room: ChatRoomId;
  onDone: (text: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState<ProductDisputeReason>(
    charge.possibleRepeat ? "duplicate" : "not-resolved",
  );
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit() {
    setBusy(true);
    setError("");
    try {
      const result = await disputeCharge(account, room, {
        ref: charge.ref,
        reason,
        text: text.trim() || null,
      });
      onDone(
        result.dispute.status === "credited"
          ? charge.source === "manual"
            ? "Removed from your amount due."
            : "Credited back to your balance."
          : "Sent to Templ. We reply within 5 business days.",
      );
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The dispute didn’t send. Try again.",
      );
      setBusy(false);
    }
  }
  return (
    <div className={plan.dispute}>
      <label className={plan.select}>
        Why
        <select
          value={reason}
          onChange={(event) =>
            setReason(event.target.value as ProductDisputeReason)
          }
        >
          {PRODUCT_DISPUTE_REASONS.map((value) => (
            <option key={value} value={value}>
              {REASON_LABELS[value]}
            </option>
          ))}
        </select>
      </label>
      <textarea
        aria-label="Note for Templ (optional)"
        placeholder="Note for Templ (optional). Users never see it."
        maxLength={PRODUCT_DISPUTE_TEXT_MAX}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      {error && (
        <p className={styles.error} role="alert" style={{ margin: 0 }}>
          {error}
        </p>
      )}
      <div className={plan.chargeActions}>
        <button
          type="button"
          className="button small"
          disabled={busy}
          onClick={() => void submit()}
        >
          {busy ? "Sending…" : "Dispute charge"}
        </button>
        <button
          type="button"
          className="button small secondary"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Every charge, newest first: who resolved it, what it cost and what
 * happened to it. A final charge can be disputed until its date. */
export function PlanCharges({ context }: { context: WorkspaceContext }) {
  const { room, account, revision } = context;
  const [bump, setBump] = useState(0);
  const key = `${room}:${account}:${revision}:${bump}`;
  const { current, charges, next, loadMore } = useCharges(room, key, undefined);
  const [open, setOpen] = useState<string | null>(null);
  const [done, setDone] = useState<{ ref: string; text: string } | null>(null);
  // When the list was read: a dispute window that closes meanwhile is
  // refused by the service.
  const [now] = useState(() => Date.now());
  return (
    <Card
      title="Charges"
      footer={
        <a className={styles.inlineLink} href={RESOLVED_CASES_DOCS}>
          How charges work <IconArrowRight aria-hidden="true" />
        </a>
      }
    >
      {!current ? (
        <Skeleton height={80} />
      ) : current.error ? (
        <Callout tone="danger" role="alert">
          {current.error}
        </Callout>
      ) : charges.length === 0 ? (
        <EmptyState title="No case charges yet">
          Recorded case charges appear here.
        </EmptyState>
      ) : (
        <ul className={plan.charges}>
          {charges.map((charge) => {
            const disputable =
              charge.state === "final" &&
              !charge.dispute &&
              charge.disputeUntil !== null &&
              Date.parse(charge.disputeUntil) > now &&
              charge.source !== "off";
            return (
              <li key={charge.ref} className={plan.charge}>
                <ChargeHead charge={charge} />
                <ul className={plan.events} aria-label="History">
                  {charge.events.map((event, index) => (
                    <li key={`${event.at}:${index}`}>
                      {EVENT_LABELS[event.kind]} {formatDay(event.at)} by{" "}
                      <ChargeActor actor={event.actor} />
                    </li>
                  ))}
                </ul>
                {charge.dispute && (
                  <p className={styles.small} style={{ margin: 0 }}>
                    {charge.dispute.status === "open"
                      ? `Disputed. Templ replies within ${charge.dispute.replyWithinBusinessDays ?? 5} business days.`
                      : charge.dispute.status === "credited"
                        ? "Disputed and credited back."
                        : "Disputed. Templ kept this charge."}
                  </p>
                )}
                {charge.possibleRepeat && !charge.dispute && (
                  <p className={styles.small} style={{ margin: 0 }}>
                    Possible repeat: the same user opened another case within 14
                    days.
                  </p>
                )}
                {done?.ref === charge.ref && (
                  <p
                    className={styles.small}
                    role="status"
                    style={{ margin: 0 }}
                  >
                    {done.text}
                  </p>
                )}
                <div className={plan.chargeActions}>
                  {charge.thread && (
                    <button
                      type="button"
                      className="button small secondary"
                      onClick={() => context.go("inbox", charge.thread)}
                    >
                      Open
                    </button>
                  )}
                  {disputable && open !== charge.ref && (
                    <button
                      type="button"
                      className="button small secondary"
                      onClick={() => setOpen(charge.ref)}
                    >
                      {charge.possibleRepeat ? "Dispute as repeat" : "Dispute"}
                    </button>
                  )}
                </div>
                {disputable && open === charge.ref && (
                  <DisputeForm
                    charge={charge}
                    account={account}
                    room={room}
                    onCancel={() => setOpen(null)}
                    onDone={(text) => {
                      setOpen(null);
                      setDone({ ref: charge.ref, text });
                      setBump((value) => value + 1);
                    }}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
      {next && (
        <button
          type="button"
          className="button small secondary"
          onClick={() => void loadMore()}
        >
          Show more
        </button>
      )}
    </Card>
  );
}
