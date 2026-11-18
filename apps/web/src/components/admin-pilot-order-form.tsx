"use client";

import { useEffect, useState } from "react";
import type { ChatPrincipalId } from "@templ/chat/principal";
import type { ProductPilotView } from "@templ/chat/product-catalog";
import { PRODUCT_PILOT_DEFAULTS } from "@templ/chat/plans";
import {
  isPilotOrderFormTerms,
  pilotUpfrontRequestCents,
} from "@templ/chat/pilot-pricing";
import { resolutionPriceTable } from "@templ/chat/resolution-pricing";
import {
  PRODUCT_RAIL_IDS,
  PRODUCT_RAILS,
  type ProductPaymentIntent,
  type ProductRailId,
} from "@templ/chat/product-payment";
import {
  orderFormsAdmin,
  type OperatorOrderForm,
  type OperatorOrderForms,
  type OperatorOrderFormsRecord,
} from "@/lib/order-forms-admin-client";
import { billingAdmin } from "@/lib/billing-admin-client";
import { formatUsd } from "@/lib/product-format";
import { trackEvent } from "@/lib/analytics";
import {
  ProductPaymentRequestDetails,
  paymentNetworkName,
} from "./product-payment-request";
import styles from "./admin-pilot-order-form.module.css";

const DAY_MS = 86_400_000;
const whole = (text: string) => (/^\d+$/.test(text) ? Number(text) : 0);

export function AdminPilotOrderForm({
  principal,
  workspace,
  pilot,
  onChanged,
}: {
  principal: ChatPrincipalId;
  workspace: string;
  pilot?: ProductPilotView | null;
  onChanged: (message: string) => void;
}) {
  const [loaded, setLoaded] = useState<{
    record?: OperatorOrderForms;
    error?: string;
  }>();
  const [now] = useState(Date.now);
  useEffect(() => {
    const controller = new AbortController();
    void orderFormsAdmin(principal)
      .read(workspace, controller.signal)
      .then(
        (record) => {
          if (!controller.signal.aborted) setLoaded({ record });
        },
        (error) => {
          if (!controller.signal.aborted)
            setLoaded({
              error:
                error instanceof Error
                  ? error.message
                  : "The order form could not load.",
            });
        },
      );
    return () => controller.abort();
  }, [principal, workspace]);
  if (!loaded) return <p role="status">Loading pilot form…</p>;
  if (!loaded.record) return <p role="alert">{loaded.error}</p>;
  if (!loaded.record.pilotEnabled) return null;
  const latest = loaded.record.history.at(-1);
  const current =
    latest &&
    loaded.record.ended[latest.id] === undefined &&
    (latest.endsAt > now || loaded.record.orderForm?.id === latest.id)
      ? latest
      : undefined;
  if (current && !current.pilot)
    return <p>This workspace has another signed order form.</p>;
  return (
    <section aria-labelledby="pilot-order-form">
      <h3 id="pilot-order-form">
        {current
          ? current.endsAt > now
            ? "Revise pilot"
            : "Cancel pilot"
          : "Create pilot"}
      </h3>
      <PilotForm
        key={`${current?.id}:${current?.revision}`}
        principal={principal}
        workspace={workspace}
        current={current}
        onSaved={(record, message) => {
          setLoaded({
            record: {
              ...loaded.record!,
              ...record,
            },
          });
          onChanged(message);
        }}
      />
      {current && pilot && pilot.state === "awaiting-payment" && (
        <UpfrontPayment
          principal={principal}
          workspace={workspace}
          pilot={pilot}
        />
      )}
    </section>
  );
}

function PilotForm({
  principal,
  workspace,
  current,
  onSaved,
}: {
  principal: ChatPrincipalId;
  workspace: string;
  current?: OperatorOrderForm;
  onSaved: (record: OperatorOrderFormsRecord, message: string) => void;
}) {
  const defaults = current?.pilot ?? PRODUCT_PILOT_DEFAULTS;
  const [openedAt] = useState(Date.now);
  const canRevise = !current || current.endsAt > openedAt;
  const [title, setTitle] = useState(current?.pilot?.title ?? "Support pilot");
  const [days, setDays] = useState(String(defaults.durationDays));
  const [monthCap, setMonthCap] = useState(
    String(defaults.monthlyCapCents / 100),
  );
  const [totalCap, setTotalCap] = useState(
    String(defaults.totalCapCents / 100),
  );
  const [upfront, setUpfront] = useState(String(defaults.upfrontCents / 100));
  const [start, setStart] = useState(() =>
    new Date(current?.startsAt ?? openedAt + 600_000)
      .toISOString()
      .slice(0, 16),
  );
  const [document, setDocument] = useState("");
  const [founder, setFounder] = useState(current?.approvedBy ?? "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const pilot = {
    title: title.trim(),
    durationDays: whole(days),
    monthlyCapCents: whole(monthCap) * 100,
    totalCapCents: whole(totalCap) * 100,
    upfrontCents: whole(upfront) * 100,
  };
  const startsAt = current?.startsAt ?? Date.parse(`${start}:00.000Z`);
  const ready =
    canRevise &&
    isPilotOrderFormTerms(pilot) &&
    Number.isSafeInteger(startsAt) &&
    (current !== undefined || startsAt >= openedAt) &&
    /^[0-9a-f]{64}$/.test(document) &&
    founder.trim().length > 0 &&
    reason.trim().length > 0;
  const save = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError("");
    setNote("Saving signed pilot…");
    try {
      const result = await orderFormsAdmin(principal).act(workspace, {
        action: current ? "amend" : "create",
        ...(current
          ? { id: current.id, expectedRevision: current.revision }
          : {}),
        table: resolutionPriceTable(),
        service: "software",
        startsAt,
        endsAt: startsAt + pilot.durationDays * DAY_MS,
        documentSha256: document,
        approvedBy: founder.trim(),
        pilot,
        reason: reason.trim(),
      });
      const message = current
        ? "Signed pilot revision saved."
        : "Signed pilot saved. Create its upfront payment request next.";
      setNote(message);
      onSaved(result, message);
    } catch (cause) {
      setNote("");
      setError(
        cause instanceof Error
          ? cause.message
          : "The pilot could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    if (!current || !founder.trim() || !reason.trim() || busy) return;
    setBusy(true);
    setError("");
    setNote("Cancelling pilot…");
    try {
      const result = await orderFormsAdmin(principal).act(workspace, {
        action: "end",
        id: current.id,
        expectedRevision: current.revision,
        approvedBy: founder.trim(),
        reason: reason.trim(),
      });
      setNote("Pilot cancelled. Normal prices apply.");
      onSaved(result, "Pilot cancelled. Normal prices apply.");
    } catch (cause) {
      setNote("");
      setError(
        cause instanceof Error
          ? cause.message
          : "The pilot could not be cancelled.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {canRevise ? (
        <p>
          Cap and date changes need a signed revision. The founder must approve
          it.
        </p>
      ) : (
        <p>End the active pilot before you create another.</p>
      )}
      {current && <p>The founder must approve cancellation too.</p>}
      <div className={styles.fields}>
        {canRevise && (
          <>
            <label>
              Pilot title
              <input
                value={title}
                maxLength={80}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <label>
              Duration (days)
              <input
                type="number"
                min={1}
                max={PRODUCT_PILOT_DEFAULTS.maxDurationDays}
                step={1}
                value={days}
                onChange={(event) => setDays(event.target.value)}
              />
            </label>
            <label>
              Month cap (USD)
              <input
                type="number"
                min={1}
                max={PRODUCT_PILOT_DEFAULTS.maxCapCents / 100}
                step={1}
                value={monthCap}
                onChange={(event) => setMonthCap(event.target.value)}
              />
            </label>
            <label>
              Total cap (USD)
              <input
                type="number"
                min={1}
                max={PRODUCT_PILOT_DEFAULTS.maxCapCents / 100}
                step={1}
                value={totalCap}
                onChange={(event) => setTotalCap(event.target.value)}
              />
            </label>
            <label>
              Upfront payment (USD)
              <input
                type="number"
                min={1}
                max={PRODUCT_PILOT_DEFAULTS.maxCapCents / 100}
                step={1}
                value={upfront}
                onChange={(event) => setUpfront(event.target.value)}
              />
            </label>
            <label>
              Starts (UTC)
              <input
                type="datetime-local"
                value={start}
                disabled={current !== undefined}
                onChange={(event) => setStart(event.target.value)}
              />
            </label>
            <label>
              Signed document hash
              <input
                value={document}
                maxLength={64}
                spellCheck={false}
                onChange={(event) => setDocument(event.target.value)}
              />
            </label>
          </>
        )}
        <label>
          Founder account
          <input
            value={founder}
            spellCheck={false}
            onChange={(event) =>
              setFounder(event.target.value as ChatPrincipalId)
            }
          />
        </label>
        <label className={styles.full}>
          Pilot reason
          <input
            value={reason}
            maxLength={280}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
      </div>
      {canRevise && (
        <>
          <p>Use the SHA-256 hash of the signed form.</p>
          <p>
            The month cap and upfront payment must fit within the total cap.
          </p>
        </>
      )}
      <div className={styles.actions}>
        {canRevise && (
          <button type="submit" disabled={!ready || busy}>
            {current ? "Save revision" : "Save pilot"}
          </button>
        )}
        {current && (
          <button
            type="button"
            disabled={!founder.trim() || !reason.trim() || busy}
            onClick={() => void cancel()}
          >
            Cancel pilot
          </button>
        )}
      </div>
      {note && <p role="status">{note}</p>}
      {error && <p role="alert">{error}</p>}
    </form>
  );
}

function UpfrontPayment({
  principal,
  workspace,
  pilot,
}: {
  principal: ChatPrincipalId;
  workspace: string;
  pilot: ProductPilotView;
}) {
  const [rail, setRail] = useState<ProductRailId>("base-usdc");
  const [payer, setPayer] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [intent, setIntent] = useState<ProductPaymentIntent>();
  const [error, setError] = useState("");
  const due = Math.max(0, pilot.upfrontCents - pilot.upfrontPaidCents);
  const requestCents = pilotUpfrontRequestCents(
    pilot.upfrontCents,
    pilot.upfrontPaidCents,
  );
  const create = async () => {
    if (busy || !payer.trim() || reason.trim().length < 3 || requestCents <= 0)
      return;
    setBusy(true);
    setError("");
    try {
      const result = await billingAdmin(principal).act(workspace, {
        action: "payment-request",
        orderFormId: pilot.id,
        orderFormRevision: pilot.revision,
        rail,
        payer: payer.trim(),
        usdCents: requestCents,
        reason: reason.trim(),
      });
      const request = result.intent as ProductPaymentIntent | undefined;
      if (
        !request ||
        request.room !== `room:${workspace}` ||
        request.orderFormId !== pilot.id ||
        request.orderFormRevision !== pilot.revision ||
        request.usdCents !== requestCents ||
        request.rail !== rail ||
        typeof request.payer !== "string" ||
        (request.kind === "solana"
          ? request.payer !== payer.trim()
          : request.payer.toLowerCase() !== payer.trim().toLowerCase())
      )
        throw new Error("The payment request did not match this pilot.");
      setIntent(request);
      trackEvent("checkout_started");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The payment request could not be created.",
      );
      trackEvent("payment_failed");
      console.warn("TEMPL_SUPPORT_FAILURE", {
        route: "payment",
        step: "prepare",
        cause: "service-refused",
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={styles.payment}>
      <h3>Create upfront request</h3>
      <p>Upfront payment due: {formatUsd(due)}.</p>
      <p>Payment request: {formatUsd(requestCents)}.</p>
      {requestCents > due && (
        <p>
          Requests use whole dollars. The extra amount stays in the balance.
        </p>
      )}
      <p>
        Use a wallet the billing manager has verified. The manager pays in Plan.
      </p>
      <div className={styles.fields}>
        <label>
          Network and token
          <select
            value={rail}
            onChange={(event) => setRail(event.target.value as ProductRailId)}
          >
            {PRODUCT_RAIL_IDS.map((id) => (
              <option key={id} value={id}>
                {PRODUCT_RAILS[id].symbol} on{" "}
                {paymentNetworkName(PRODUCT_RAILS[id].network)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Paying wallet
          <input
            value={payer}
            spellCheck={false}
            onChange={(event) => setPayer(event.target.value)}
          />
        </label>
        <label className={styles.full}>
          Payment reason
          <input
            value={reason}
            maxLength={280}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
      </div>
      <button
        type="button"
        disabled={
          busy || !payer.trim() || reason.trim().length < 3 || requestCents <= 0
        }
        onClick={() => void create()}
      >
        Create payment request
      </button>
      {busy && <p role="status">Creating payment request…</p>}
      {error && <p role="alert">{error}</p>}
      {intent && <ProductPaymentRequestDetails request={intent} />}
    </div>
  );
}
