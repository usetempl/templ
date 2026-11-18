"use client";
import { isChatSignInCanceled } from "@/lib/chat-auth-cancellation";

import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  IconCheck,
  IconExternalLink,
  IconRefresh,
  IconSend,
} from "@tabler/icons-react";
import {
  SAFETY_REASONS,
  legalNotice,
  ordinaryLegalNotice,
} from "@templ/chat/safety";
import { useChatAuth } from "@/lib/chat-auth";
import { copy as t, type MessageKey } from "@/lib/copy";
import { LoadingSpinner } from "./loading-state";
import { SITE } from "@/lib/site-environment";
import styles from "./safety-report-form.module.css";

const API = SITE.community;
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const roomPattern =
  /^\/rooms\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const reasons = SAFETY_REASONS;
type Reason = (typeof reasons)[number][0];
/** The message key of each SAFETY_REASONS label (packages/chat keeps the English). */
const REASON_KEYS: Record<Reason, MessageKey> = {
  "legal-request": "shell.safety.reason.legalRequest",
  "mandatory-notice": "shell.safety.reason.mandatoryNotice",
  "child-safety": "shell.safety.reason.childSafety",
  "imminent-harm": "shell.safety.reason.imminentHarm",
  appeal: "shell.safety.reason.appeal",
};
export type SafetyTargetInput = {
  room?: string;
  channel?: string;
  message?: string;
  attachment?: string;
};
type Target = {
  endpoint: string;
  url: string;
  message: boolean;
};
const conversationPattern = /^tc-[0-9a-f]{32}$/;
/** A message report names a support conversation; any other report link is
 * out of date. */
const OUT_OF_DATE =
  "This report link is out of date. Report the whole workspace instead.";

export function safetyTarget(input: SafetyTargetInput): Target | null {
  if (
    !input.room &&
    !input.channel &&
    !input.message &&
    input.attachment === undefined
  )
    return null;
  if (!input.room || !roomPattern.test(input.room))
    throw new Error(
      "This report link is incomplete. Open Report from the chat again.",
    );
  const room = input.room.toLowerCase();
  const url = `${SITE.origin}${room}`;
  if (!input.channel && !input.message && input.attachment === undefined)
    return { endpoint: `${room}/report`, url, message: false };
  if (
    input.attachment !== undefined ||
    (input.channel !== undefined && !conversationPattern.test(input.channel))
  )
    throw new Error(OUT_OF_DATE);
  if (
    !input.channel ||
    !input.message ||
    !/^[1-9][0-9]{0,14}$/.test(input.message)
  )
    throw new Error(
      "This report link is incomplete. Open Report from the message again.",
    );
  return {
    endpoint: `${room}/conversations/${input.channel}/messages/${input.message}/report`,
    url,
    message: true,
  };
}

export function safetyTargetUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Add a complete Templ page link.");
  }
  const page = url.origin === SITE.origin;
  const image =
    url.origin === API && /^\/media\/[0-9a-f]{64}$/.test(url.pathname);
  if (
    (!page && !image) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Use a Templ page or uploaded image link without query text or an invitation secret.",
    );
  if (url.href.length > 2048) throw new Error("This link is too long.");
  return url.href;
}

class ReportError extends Error {
  constructor(
    message: string,
    readonly retryAfter = 0,
  ) {
    super(message);
  }
}
async function reportFetch(path: string, body: unknown, signal: AbortSignal) {
  const response = await fetch(`${API}${path}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "include",
    cache: "no-store",
    signal,
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const result = await response.json();
  if (!response.ok) {
    const retry = response.headers.get("Retry-After");
    const seconds =
      retry && /^[1-9][0-9]*$/.test(retry)
        ? Math.min(Number(retry), 86_400)
        : 0;
    throw new ReportError(
      typeof result.error === "string"
        ? result.error.slice(0, 400)
        : "Could not submit the report. Try again.",
      seconds,
    );
  }
  return result;
}

export function SafetyReportForm({
  target: input = {},
  initialReason = "",
  initialReportId = "",
}: {
  target?: SafetyTargetInput;
  initialReason?: string;
  initialReportId?: string;
}) {
  const auth = useChatAuth();
  const parsed = (() => {
    try {
      return { target: safetyTarget(input), error: "" };
    } catch (error) {
      return { target: null, error: (error as Error).message };
    }
  })();
  const target = parsed.target;
  const [reason, setReason] = useState<Reason | "">(
    reasons.some(([value]) => value === initialReason)
      ? (initialReason as Reason)
      : "",
  );
  const [targetUrl, setTargetUrl] = useState(target?.url ?? "");
  const [details, setDetails] = useState("");
  const [notice, setNotice] = useState({
    jurisdiction: "",
    legalBasis: "",
    noticeObligation: "",
    evidence: "",
    reporterName: "",
    contactEmail: "",
    goodFaith: false,
  });
  const [authority, setAuthority] = useState({
    organization: "",
    officialContact: "",
    reference: "",
    requestedAction: "removal",
  });
  const ordinary = ordinaryLegalNotice(reason);
  const noticeField = (key: keyof typeof notice, value: string | boolean) =>
    setNotice((current) => ({ ...current, [key]: value }));
  const [relatedReportId, setRelatedReportId] = useState(
    uuid.test(initialReportId) ? initialReportId : "",
  );
  const [capability, setCapability] = useState<
    "checking" | "on" | "off" | "error"
  >("checking");
  const [check, setCheck] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState("");
  const [reviewStatus, setReviewStatus] = useState("");
  const [copied, setCopied] = useState(false);
  const [retryAt, setRetryAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const pending = useRef<{ fingerprint: string; id: string } | null>(null);
  const request = useRef<AbortController | null>(null);
  const inFlight = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      request.current?.abort();
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    let active = true;
    setCapability("checking");
    void reportFetch("/safety", undefined, controller.signal)
      .then((result) => {
        if (active)
          setCapability(
            typeof result.reporting === "boolean"
              ? result.reporting
                ? "on"
                : "off"
              : "error",
          );
      })
      .catch(() => {
        if (active) setCapability("error");
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      active = false;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [check]);
  useEffect(() => {
    if (retryAt <= Date.now()) return;
    const timer = setInterval(() => {
      const time = Date.now();
      setNow(time);
      if (time >= retryAt) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [retryAt]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      inFlight.current ||
      capability !== "on" ||
      parsed.error ||
      Date.now() < retryAt
    )
      return;
    setError("");
    let body: Record<string, unknown>;
    try {
      if (!reasons.some(([value]) => value === reason))
        throw new Error("Choose a reason.");
      if (!details.trim() || details.length > 2000)
        throw new Error("Explain the issue in up to 2,000 characters.");
      if (
        Array.from(details).some((character) => {
          const code = character.charCodeAt(0);
          return code === 127 || (code < 32 && ![9, 10, 13].includes(code));
        })
      )
        throw new Error("Describe the issue in plain text.");
      if (
        reason === "appeal" &&
        relatedReportId.trim() &&
        !uuid.test(relatedReportId.trim())
      )
        throw new Error(
          "Check the report ID, or leave it blank if you don’t have one.",
        );
      body = {
        reason,
        targetUrl: safetyTargetUrl(target?.url ?? targetUrl),
        details: details.trim(),
        notice: legalNotice(
          reason,
          ordinary
            ? {
                ...notice,
                ...(reason === "legal-request" ? { authority } : {}),
              }
            : undefined,
        ),
        ...(reason === "appeal" && relatedReportId.trim()
          ? { relatedReportId: relatedReportId.trim().toLowerCase() }
          : {}),
      };
    } catch (failure) {
      setError((failure as Error).message);
      return;
    }
    inFlight.current = true;
    setBusy(true);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let submitted = false;
    try {
      if (target) {
        const session = await auth.signIn();
        if (!alive.current) return;
        body.expectedPrincipalId = session.principalId;
      }
      const endpoint = target?.endpoint ?? "/safety/reports";
      const fingerprint = JSON.stringify([endpoint, body]);
      if (pending.current?.fingerprint !== fingerprint)
        pending.current = { fingerprint, id: crypto.randomUUID() };
      request.current = new AbortController();
      timeout = setTimeout(() => request.current?.abort(), 20_000);
      submitted = true;
      const result = await reportFetch(
        endpoint,
        { ...body, requestId: pending.current.id },
        request.current.signal,
      );
      if (
        !result.received ||
        typeof result.id !== "string" ||
        !uuid.test(result.id)
      )
        throw new Error("Unconfirmed receipt");
      if (alive.current) {
        setReceipt(result.id);
        setReviewStatus(
          typeof result.reviewStatus === "string" ? result.reviewStatus : "",
        );
        setRetryAt(0);
      }
    } catch (failure) {
      if (!alive.current || isChatSignInCanceled(failure)) return;
      setError(
        failure instanceof ReportError
          ? failure.message
          : submitted
            ? t("shell.safety.unconfirmed")
            : t("shell.safety.signInToReport"),
      );
      if (failure instanceof ReportError && failure.retryAfter) {
        setNow(Date.now());
        setRetryAt(Date.now() + failure.retryAfter * 1000);
      }
    } finally {
      clearTimeout(timeout);
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  }
  if (receipt)
    return (
      <section
        className={styles.receipt}
        aria-labelledby="report-received-title"
      >
        <IconCheck className={styles.receiptIcon} aria-hidden="true" />
        <h2 id="report-received-title">{t("shell.safety.received")}</h2>
        <p>{t("shell.safety.keepId")}</p>
        {reviewStatus === "pending-authority-verification" && (
          <p>{t("shell.safety.authorityPending")}</p>
        )}
        {reviewStatus === "pending-legal-duty-validation" && (
          <p>{t("shell.safety.dutyPending")}</p>
        )}
        <code>{receipt}</code>
        <div className={styles.receiptActions}>
          <button
            type="button"
            onClick={() => {
              if (!navigator.clipboard) return;
              void navigator.clipboard
                .writeText(receipt)
                .then(() => {
                  setCopied(true);
                })
                .catch(() => {
                  setCopied(false);
                });
            }}
          >
            {copied ? t("shell.safety.copied") : t("shell.safety.copyId")}
          </button>
          <button
            type="button"
            onClick={() => {
              setReceipt("");
              setReviewStatus("");
              setDetails("");
              setError("");
              setCopied(false);
              pending.current = null;
            }}
          >
            {t("shell.safety.newReport")}
          </button>
        </div>
      </section>
    );
  const wait = Math.max(0, Math.ceil((retryAt - now) / 1000));
  return (
    <form
      className={styles.form}
      onSubmit={(event) => void submit(event)}
      aria-labelledby="report-title"
    >
      <header className={styles.heading}>
        <h2 id="report-title">{t("shell.safety.title")}</h2>
        <p>{target ? t("shell.safety.targetLead") : t("shell.safety.lead")}</p>
      </header>
      <div className={styles.availability} role="status" aria-live="polite">
        {capability === "checking" && (
          <>
            <LoadingSpinner />
            <span>{t("shell.safety.checkingAvailability")}</span>
          </>
        )}
        {(capability === "off" || capability === "error") && (
          <>
            <span>
              {capability === "off"
                ? t("shell.safety.notAvailable")
                : t("shell.safety.temporarilyUnavailable")}
            </span>
            <button
              type="button"
              onClick={() => setCheck((value) => value + 1)}
            >
              <IconRefresh aria-hidden="true" /> {t("shell.safety.checkAgain")}
            </button>
          </>
        )}
      </div>
      {parsed.error && (
        <p role="alert" className={styles.error}>
          {parsed.error}
        </p>
      )}
      <fieldset disabled={busy || Boolean(parsed.error)}>
        <div className={styles.row}>
          <label>
            {t("shell.safety.reason")}
            <select
              value={reason}
              onChange={(event) => setReason(event.target.value as Reason)}
              required
            >
              <option value="" disabled>
                {t("shell.safety.chooseReason")}
              </option>
              {reasons.map(([value]) => (
                <option key={value} value={value}>
                  {t(REASON_KEYS[value])}
                </option>
              ))}
            </select>
          </label>
          {target ? (
            <div className={styles.target}>
              <span>
                {target.message
                  ? t("shell.safety.message")
                  : t("shell.safety.chat")}
              </span>
              <a href={target.url} target="_blank" rel="noreferrer">
                {t("shell.safety.openReported")}{" "}
                <IconExternalLink aria-hidden="true" />
              </a>
              {target.message && (
                <small>
                  {t("shell.safety.messageNumber", {
                    id: input.message ?? "",
                  })}
                </small>
              )}
            </div>
          ) : (
            <label>
              {t("shell.safety.link")}
              <input
                type="url"
                value={targetUrl}
                onChange={(event) => setTargetUrl(event.target.value)}
                placeholder={`${SITE.origin}/…`}
                required
                maxLength={2048}
                autoComplete="off"
              />
            </label>
          )}
        </div>
        {ordinary && (
          <>
            <div className={styles.row}>
              <label>
                {t("shell.safety.reporterName")}
                <input
                  value={notice.reporterName}
                  onChange={(e) => noticeField("reporterName", e.target.value)}
                  required
                  maxLength={200}
                  autoComplete="name"
                />
              </label>
              <label>
                {t("shell.safety.contactEmail")}
                <input
                  type="email"
                  value={notice.contactEmail}
                  onChange={(e) => noticeField("contactEmail", e.target.value)}
                  required
                  maxLength={254}
                  autoComplete="email"
                />
              </label>
            </div>
            <div className={styles.row}>
              <label>
                {t("shell.safety.jurisdiction")}
                <input
                  value={notice.jurisdiction}
                  onChange={(e) => noticeField("jurisdiction", e.target.value)}
                  required
                  maxLength={200}
                  placeholder={t("shell.safety.jurisdictionHint")}
                />
              </label>
              <label>
                {t("shell.safety.legalBasis")}
                <input
                  value={notice.legalBasis}
                  onChange={(e) => noticeField("legalBasis", e.target.value)}
                  required
                  maxLength={1000}
                  placeholder={t("shell.safety.legalBasisHint")}
                />
              </label>
            </div>
            <label>
              {t("shell.safety.evidence")}
              <textarea
                value={notice.evidence}
                onChange={(e) => noticeField("evidence", e.target.value)}
                required
                maxLength={1500}
                rows={3}
                placeholder={t("shell.safety.evidenceHint")}
              />
            </label>
            {reason === "mandatory-notice" && (
              <>
                <label>
                  {t("shell.safety.noticeObligation")}
                  <input
                    value={notice.noticeObligation}
                    onChange={(e) =>
                      noticeField("noticeObligation", e.target.value)
                    }
                    required
                    maxLength={1000}
                    placeholder={t("shell.safety.noticeObligationHint")}
                  />
                </label>
                <p className={styles.notice}>{t("shell.safety.noticeCheck")}</p>
              </>
            )}
            {reason === "legal-request" && (
              <>
                <div className={styles.row}>
                  <label>
                    {t("shell.safety.authority")}
                    <input
                      value={authority.organization}
                      onChange={(e) =>
                        setAuthority((current) => ({
                          ...current,
                          organization: e.target.value,
                        }))
                      }
                      required
                      maxLength={200}
                    />
                  </label>
                  <label>
                    {t("shell.safety.officialContact")}
                    <input
                      value={authority.officialContact}
                      onChange={(e) =>
                        setAuthority((current) => ({
                          ...current,
                          officialContact: e.target.value,
                        }))
                      }
                      required
                      maxLength={500}
                      placeholder={t("shell.safety.officialContactHint")}
                    />
                  </label>
                </div>
                <div className={styles.row}>
                  <label>
                    {t("shell.safety.reference")}
                    <input
                      value={authority.reference}
                      onChange={(e) =>
                        setAuthority((current) => ({
                          ...current,
                          reference: e.target.value,
                        }))
                      }
                      required
                      maxLength={500}
                    />
                  </label>
                  <label>
                    {t("shell.safety.requestedAction")}
                    <select
                      value={authority.requestedAction}
                      onChange={(e) =>
                        setAuthority((current) => ({
                          ...current,
                          requestedAction: e.target.value,
                        }))
                      }
                    >
                      <option value="removal">
                        {t("shell.safety.actionRemoval")}
                      </option>
                      <option value="preservation">
                        {t("shell.safety.actionPreservation")}
                      </option>
                      <option value="disclosure">
                        {t("shell.safety.actionDisclosure")}
                      </option>
                    </select>
                  </label>
                </div>
                <p className={styles.notice}>
                  {t("shell.safety.authorityCheck")}
                </p>
              </>
            )}
            <label className={styles.confirmation}>
              <input
                type="checkbox"
                checked={notice.goodFaith}
                onChange={(e) => noticeField("goodFaith", e.target.checked)}
                required
              />
              <span>{t("shell.safety.goodFaith")}</span>
            </label>
          </>
        )}
        {(reason === "child-safety" || reason === "imminent-harm") && (
          <p className={styles.notice}>{t("shell.safety.urgentHint")}</p>
        )}
        {reason === "appeal" && (
          <label>
            {t.rich("shell.safety.reportId", {
              optional: (chunks) => (
                <span className={styles.optional}>{chunks}</span>
              ),
            })}
            <input
              value={relatedReportId}
              onChange={(event) => setRelatedReportId(event.target.value)}
              placeholder={t("shell.safety.reportIdHint")}
              maxLength={36}
              autoComplete="off"
            />
          </label>
        )}
        <label>
          {reason === "appeal"
            ? t("shell.safety.reconsider")
            : t("shell.safety.whatHappened")}
          <textarea
            value={details}
            onChange={(event) => setDetails(event.target.value)}
            required
            maxLength={2000}
            rows={5}
            placeholder={
              reason === "appeal"
                ? t("shell.safety.reconsiderHint")
                : t("shell.safety.whatHappenedHint")
            }
            aria-describedby="report-content-note"
          />
        </label>
        <div className={styles.noteRow}>
          <p id="report-content-note">{t("shell.safety.contentNote")}</p>
          <span
            aria-label={t("shell.safety.charCountLabel", {
              count: details.length,
            })}
          >
            {t("shell.safety.charCount", {
              count: details.length.toLocaleString(),
            })}
          </span>
        </div>
      </fieldset>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      <div className={styles.actions}>
        <button
          className={styles.submit}
          type="submit"
          disabled={
            capability !== "on" || busy || Boolean(parsed.error) || wait > 0
          }
        >
          {busy ? <LoadingSpinner /> : <IconSend aria-hidden="true" />}
          {busy
            ? t("shell.safety.sending")
            : wait > 0
              ? t("shell.safety.tryAgainIn", { seconds: wait })
              : error && pending.current
                ? t("shell.common.tryAgain")
                : reason === "appeal"
                  ? t("shell.safety.submitAppeal")
                  : t("shell.safety.submitReport")}
        </button>
        <p>{t("shell.safety.emergency")}</p>
      </div>
    </form>
  );
}
