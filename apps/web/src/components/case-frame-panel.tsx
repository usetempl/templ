"use client";
import { useState, type FormEvent } from "react";
import { IconChevronLeft, IconChevronRight } from "@tabler/icons-react";
import type { ChatRoomId } from "@templ/chat/index";
import type { ChatPrincipalId } from "@templ/chat/principal";
import { SUPPORT_WALLET_CHAINS } from "@templ/chat/chains";
import { supportNetworkName } from "@templ/chat/support-context";
import type { SupportCaseDetail } from "@templ/chat/support-drafts";
import {
  SUPPORT_EVIDENCE_SOURCES,
  SUPPORT_SEEN_WHERE,
  type SupportCaseFrame,
  type SupportEvidence,
  type SupportEvidenceSource,
  type SupportFieldSource,
  type SupportSeenWhere,
  type SupportTag,
} from "@templ/chat/support-evidence";
import type { SupportNetwork } from "@templ/chat/support";
import { copy as t, type MessageKey } from "@/lib/copy";
import { newChatMessageId } from "@/lib/chat-outbox";
import {
  addCaseEvidence,
  conversationErrorMessage,
  conversationErrorReason,
  saveCaseFrame,
  withdrawCaseEvidence,
} from "@/lib/team-conversations-client";
import styles from "./team-conversations.module.css";
import panel from "./case-panels.module.css";

/** Who set a frame field, in the team's words. */
function fieldSource(
  source: SupportFieldSource,
  name: (id: ChatPrincipalId) => string,
): string {
  if (source.by === "member") return t("room.case.fromApp");
  if (source.by === "agent") return t("room.case.fromAgent");
  return source.author ? name(source.author) : t("room.ai.someone");
}
const label = (tag: SupportTag) => tag.label ?? tag.key;
function reportedLine(frame: SupportCaseFrame): string | null {
  const r = frame.reported;
  if (!r) return null;
  const where = t(`room.case.where.${r.where}` as MessageKey);
  const place = r.place ? `, ${r.place}` : "";
  const seen = r.seenAt
    ? `, at ${new Date(r.seenAt).toISOString().slice(11, 16)} UTC`
    : "";
  return `${r.value}${r.unit ? ` ${r.unit}` : ""}, ${where}${place}${seen}`;
}
function pointLine(point: SupportEvidence["observed"]): string {
  const parts: string[] = [];
  if (point.block !== undefined)
    parts.push(
      t("room.case.block.value", {
        block: point.block.toLocaleString("en-US"),
      }),
    );
  if (point.time)
    parts.push(`${point.time.slice(0, 16).replace("T", " ")} UTC`);
  return parts.join(" at ");
}
const linkHost = (link: string) => {
  try {
    return new URL(link).hostname;
  } catch {
    return link;
  }
};

/** Request details (the case frame) and evidence rows for one member
 * request. Team only; the member never reads any of it. */
export function CaseFramePanel({
  room,
  account,
  conversationId,
  detail,
  position,
  onMove,
  onChanged,
  nameOf,
}: {
  room: ChatRoomId;
  account: ChatPrincipalId | undefined;
  conversationId: string;
  detail: SupportCaseDetail;
  /** The request's number in the thread (1 is the first), the newest
   * request's number, and whether an earlier request can be shown. Moving
   * is offered only when there is more than one. */
  position: { index: number; count: number; earlier: boolean };
  onMove: (step: -1 | 1) => void;
  onChanged: () => void;
  nameOf: (id: ChatPrincipalId) => string;
}) {
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState<number | null>(null);
  const frame = detail.frame;
  const seq = detail.case.seq;
  const rows: [MessageKey, string | null, SupportFieldSource | undefined][] = [
    [
      "room.case.product",
      frame?.product ? label(frame.product) : null,
      frame?.product,
    ],
    [
      "room.case.network",
      frame?.network ? supportNetworkName(frame.network.value) : null,
      frame?.network,
    ],
    [
      "room.case.metric",
      frame?.metric ? label(frame.metric) : null,
      frame?.metric,
    ],
    [
      "room.case.window",
      frame?.window ? label(frame.window) : null,
      frame?.window,
    ],
    ["room.case.reported", frame ? reportedLine(frame) : null, frame?.reported],
    ["room.case.question", frame?.question?.text ?? null, frame?.question],
  ];
  async function withdraw(n: number) {
    setError("");
    try {
      await withdrawCaseEvidence(account, room, conversationId, {
        case: seq,
        n,
      });
      setConfirming(null);
      onChanged();
    } catch (reason) {
      setError(conversationErrorMessage(reason));
    }
  }
  return (
    <>
      <div className={styles.detailSection}>
        <h3>{t("room.case.title")}</h3>
        {position.count > 1 && (
          <div className={panel.switcher}>
            <span>
              {t("room.case.position", {
                n: position.index,
                m: position.count,
              })}
            </span>
            <div>
              <button
                type="button"
                className={panel.iconButton}
                aria-label={t("room.case.earlier")}
                disabled={!position.earlier}
                onClick={() => onMove(-1)}
              >
                <IconChevronLeft size={16} aria-hidden="true" />
              </button>
              <button
                type="button"
                className={panel.iconButton}
                aria-label={t("room.case.later")}
                disabled={position.index >= position.count}
                onClick={() => onMove(1)}
              >
                <IconChevronRight size={16} aria-hidden="true" />
              </button>
            </div>
          </div>
        )}
        {editing ? (
          <FrameForm
            room={room}
            account={account}
            conversationId={conversationId}
            seq={seq}
            frame={frame}
            onDone={(saved, message) => {
              if (saved) setEditing(false);
              setNotice(message);
              onChanged();
            }}
          />
        ) : (
          <>
            <dl className={styles.facts}>
              {rows.map(([key, value, source]) => (
                <div key={key}>
                  <dt>{t(key)}</dt>
                  <dd>
                    {value ?? (
                      <span className={styles.detailMuted}>
                        {t("room.case.notSet")}
                      </span>
                    )}
                    {value && source && (
                      <span className={panel.by}>
                        {fieldSource(source, nameOf)}
                      </span>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
            <button
              type="button"
              className="button small secondary"
              onClick={() => {
                setNotice("");
                setEditing(true);
              }}
            >
              {t("room.case.edit")}
            </button>
          </>
        )}
        {notice && (
          <p className={styles.detailMuted} role="status">
            {notice}
          </p>
        )}
      </div>
      <div className={styles.detailSection}>
        <h3>{t("room.case.evidence")}</h3>
        {detail.evidence.length === 0 ? (
          <p className={styles.detailMuted}>{t("room.case.noEvidence")}</p>
        ) : (
          <ul className={panel.rows}>
            {detail.evidence.map((row) => (
              <li
                key={row.n}
                className={panel.row}
                data-closed={Boolean(row.withdrawn || row.supersededBy)}
              >
                <span className={panel.rowHead}>
                  <span className={panel.rowId}>{row.id}</span>
                  <span>
                    {t(`room.case.source.${row.source}` as MessageKey)}
                    {row.sourceLabel && (
                      <span className={panel.by}>{row.sourceLabel}</span>
                    )}
                  </span>
                  <span>{pointLine(row.observed)}</span>
                  {row.withdrawn && (
                    <span className={panel.badge}>
                      {t("room.case.withdrawn")}
                    </span>
                  )}
                  {row.supersededBy && (
                    <span className={panel.badge}>
                      {t("room.case.replacedBy", { n: row.supersededBy })}
                    </span>
                  )}
                </span>
                <span>
                  {label(row.product)}, {label(row.metric)}, {label(row.window)}
                </span>
                <span className={panel.value}>
                  {row.value.text}
                  {row.value.unit ? ` ${row.value.unit}` : ""}
                </span>
                {row.link &&
                  // An AI agent's link shows as text: people open only the
                  // links a person on the team recorded.
                  (row.by === "agent" ? (
                    <span className={panel.link}>
                      <strong>{linkHost(row.link)}</strong>
                      <span>{row.link}</span>
                    </span>
                  ) : (
                    <a
                      className={panel.link}
                      href={row.link}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      referrerPolicy="no-referrer"
                    >
                      <strong>{linkHost(row.link)}</strong>
                      <span>{row.link}</span>
                    </a>
                  ))}
                {row.note && (
                  <span className={styles.detailText}>{row.note}</span>
                )}
                <span className={panel.by}>
                  {row.by === "agent"
                    ? t("room.case.fromAgent")
                    : nameOf(row.author)}
                </span>
                {!row.withdrawn && row.author === account && (
                  <div className={panel.actions}>
                    {confirming === row.n ? (
                      <>
                        <span className={styles.detailMuted}>
                          {t("room.case.withdrawConfirm", { n: row.n })}
                        </span>
                        <button
                          type="button"
                          className="button small"
                          onClick={() => void withdraw(row.n)}
                        >
                          {t("room.case.withdraw")}
                        </button>
                        <button
                          type="button"
                          className="button small quiet"
                          onClick={() => setConfirming(null)}
                        >
                          {t("room.case.cancel")}
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className={styles.linkButton}
                        onClick={() => setConfirming(row.n)}
                      >
                        {t("room.case.withdraw")}
                      </button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {adding ? (
          <EvidenceForm
            room={room}
            account={account}
            conversationId={conversationId}
            seq={seq}
            frame={frame}
            onDone={(added) => {
              if (added) setAdding(false);
              onChanged();
            }}
            onCancel={() => setAdding(false)}
          />
        ) : (
          <button
            type="button"
            className="button small secondary"
            onClick={() => setAdding(true)}
          >
            {t("room.case.addEvidence")}
          </button>
        )}
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </div>
    </>
  );
}

/** The frame's inline form. A save names the revision it read, so a change
 * someone else made first is never overwritten silently. */
function FrameForm({
  room,
  account,
  conversationId,
  seq,
  frame,
  onDone,
}: {
  room: ChatRoomId;
  account: ChatPrincipalId | undefined;
  conversationId: string;
  seq: number;
  frame: SupportCaseFrame | null;
  onDone: (saved: boolean, notice: string) => void;
}) {
  const [values, setValues] = useState({
    product: frame?.product?.label ?? frame?.product?.key ?? "",
    address: frame?.product?.address ?? "",
    network: frame?.network?.value ?? frame?.product?.network ?? "",
    metric: frame?.metric?.label ?? frame?.metric?.key ?? "",
    window: frame?.window?.label ?? frame?.window?.key ?? "",
    reported: frame?.reported?.value ?? "",
    where: (frame?.reported?.where ?? "frontend") as SupportSeenWhere,
    seenAt: frame?.reported?.seenAt?.slice(0, 16) ?? "",
    question: frame?.question?.text ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (name: keyof typeof values) => (value: string) =>
    setValues((previous) => ({ ...previous, [name]: value }));
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    const network = values.network as SupportNetwork | "";
    const change: Record<string, unknown> = {
      product: values.product.trim()
        ? {
            label: values.product.trim(),
            ...(values.address.trim() && network
              ? { address: values.address.trim(), network }
              : {}),
          }
        : null,
      network: network || null,
      metric: values.metric.trim() ? { label: values.metric.trim() } : null,
      window: values.window.trim() ? { label: values.window.trim() } : null,
      reported: values.reported.trim()
        ? {
            value: values.reported.trim(),
            where: values.where,
            ...(values.seenAt ? { seenAt: `${values.seenAt}:00Z` } : {}),
          }
        : null,
      question: values.question.trim() || null,
    };
    // Unchanged empty fields are left out rather than cleared again.
    const setFields = Object.fromEntries(
      Object.entries(change).filter(
        ([field, value]) =>
          value !== null ||
          frame?.[field as keyof SupportCaseFrame] !== undefined,
      ),
    );
    if (!Object.keys(setFields).length) {
      setBusy(false);
      onDone(true, "");
      return;
    }
    try {
      await saveCaseFrame(account, room, conversationId, {
        case: seq,
        set: setFields,
        ifRevision: frame?.revision ?? 0,
      });
      onDone(true, t("room.case.saved"));
    } catch (reason) {
      if (conversationErrorReason(reason) === "frame-stale")
        onDone(false, t("room.case.stale"));
      else setError(conversationErrorMessage(reason));
    } finally {
      setBusy(false);
    }
  }
  const field = (
    name: keyof typeof values,
    key: MessageKey,
    props: { maxLength: number; multiline?: boolean } = { maxLength: 80 },
  ) => (
    <label className={styles.detailField}>
      {t(key)}
      {props.multiline ? (
        <textarea
          rows={2}
          maxLength={props.maxLength}
          value={values[name]}
          onChange={(event) => set(name)(event.target.value)}
        />
      ) : (
        <input
          maxLength={props.maxLength}
          value={values[name]}
          onChange={(event) => set(name)(event.target.value)}
        />
      )}
    </label>
  );
  return (
    <form
      onSubmit={(event) => void save(event)}
      className={styles.detailSection}
    >
      {field("product", "room.case.product")}
      <div className={panel.formRow}>
        <label className={styles.detailField}>
          {t("room.case.network")}
          <select
            value={values.network}
            onChange={(event) => set("network")(event.target.value)}
          >
            <option value="">{t("room.case.notSet")}</option>
            {SUPPORT_WALLET_CHAINS.map((chain) => (
              <option key={chain.id} value={`eip155:${chain.id}`}>
                {chain.name}
              </option>
            ))}
            <option value="solana">Solana</option>
          </select>
        </label>
        {field("address", "room.case.address", { maxLength: 60 })}
      </div>
      <div className={panel.formRow}>
        {field("metric", "room.case.metric")}
        {field("window", "room.case.window")}
      </div>
      <div className={panel.formRow}>
        {field("reported", "room.case.reported", { maxLength: 40 })}
        <label className={styles.detailField}>
          {t("room.case.whereSeen")}
          <select
            value={values.where}
            onChange={(event) => set("where")(event.target.value)}
          >
            {SUPPORT_SEEN_WHERE.map((where) => (
              <option key={where} value={where}>
                {t(`room.case.where.${where}` as MessageKey)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className={styles.detailField}>
        {t("room.case.seenAt")}
        <input
          type="datetime-local"
          value={values.seenAt}
          onChange={(event) => set("seenAt")(event.target.value)}
        />
      </label>
      {field("question", "room.case.question", {
        maxLength: 280,
        multiline: true,
      })}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={panel.actions}>
        <button type="submit" className="button small" disabled={busy}>
          {t("room.case.save")}
        </button>
        <button
          type="button"
          className="button small quiet"
          onClick={() => onDone(false, "")}
        >
          {t("room.case.cancel")}
        </button>
      </div>
    </form>
  );
}

/** One evidence row from a person. The product, metric and window start
 * from the request details so the team reuses the same keys. */
function EvidenceForm({
  room,
  account,
  conversationId,
  seq,
  frame,
  onDone,
  onCancel,
}: {
  room: ChatRoomId;
  account: ChatPrincipalId | undefined;
  conversationId: string;
  seq: number;
  frame: SupportCaseFrame | null;
  onDone: (added: boolean) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState({
    source: "chain" as SupportEvidenceSource,
    sourceLabel: "",
    product: frame?.product?.label ?? frame?.product?.key ?? "",
    metric: frame?.metric?.label ?? frame?.metric?.key ?? "",
    window: frame?.window?.label ?? frame?.window?.key ?? "",
    block: "",
    time: "",
    value: "",
    link: "",
    note: "",
  });
  const [clientId] = useState(() => newChatMessageId());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (name: keyof typeof values) => (value: string) =>
    setValues((previous) => ({ ...previous, [name]: value }));
  async function add(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const block = values.block.replace(/[,\s]/g, "");
    if (!block && !values.time) {
      setError(t("room.case.pointNeeded"));
      return;
    }
    setBusy(true);
    setError("");
    const tag = (text: string, fallback?: SupportTag) =>
      fallback && (fallback.label ?? fallback.key) === text.trim()
        ? {
            key: fallback.key,
            ...(fallback.label ? { label: fallback.label } : {}),
          }
        : { label: text.trim() };
    try {
      await addCaseEvidence(account, room, conversationId, {
        case: seq,
        clientId,
        rows: [
          {
            source: values.source,
            ...(values.sourceLabel.trim()
              ? { sourceLabel: values.sourceLabel.trim() }
              : {}),
            product:
              frame?.product &&
              (frame.product.label ?? frame.product.key) ===
                values.product.trim()
                ? {
                    key: frame.product.key,
                    ...(frame.product.label
                      ? { label: frame.product.label }
                      : {}),
                    ...(frame.product.address
                      ? {
                          address: frame.product.address,
                          network: frame.product.network,
                        }
                      : {}),
                  }
                : tag(values.product),
            metric: tag(values.metric, frame?.metric),
            window: tag(values.window, frame?.window),
            observed: {
              ...(block ? { block: Number(block) } : {}),
              ...(values.time ? { time: `${values.time}:00Z` } : {}),
            },
            value: { text: values.value.trim() },
            ...(values.link.trim() ? { link: values.link.trim() } : {}),
            ...(values.note.trim() ? { note: values.note.trim() } : {}),
          },
        ],
      });
      onDone(true);
    } catch (reason) {
      setError(conversationErrorMessage(reason));
    } finally {
      setBusy(false);
    }
  }
  const input = (
    name: keyof typeof values,
    key: MessageKey,
    props: { maxLength: number; required?: boolean; inputMode?: "numeric" } = {
      maxLength: 80,
    },
  ) => (
    <label className={styles.detailField}>
      {t(key)}
      <input
        maxLength={props.maxLength}
        required={props.required}
        inputMode={props.inputMode}
        value={values[name]}
        onChange={(event) => set(name)(event.target.value)}
      />
    </label>
  );
  return (
    <form
      onSubmit={(event) => void add(event)}
      className={styles.detailSection}
    >
      <div className={panel.formRow}>
        <label className={styles.detailField}>
          {t("room.case.source")}
          <select
            value={values.source}
            onChange={(event) => set("source")(event.target.value)}
          >
            {SUPPORT_EVIDENCE_SOURCES.map((source) => (
              <option key={source} value={source}>
                {t(`room.case.source.${source}` as MessageKey)}
              </option>
            ))}
          </select>
        </label>
        {input("sourceLabel", "room.case.sourceName")}
      </div>
      {input("product", "room.case.product", { maxLength: 80, required: true })}
      <div className={panel.formRow}>
        {input("metric", "room.case.metric", { maxLength: 80, required: true })}
        {input("window", "room.case.window", { maxLength: 80, required: true })}
      </div>
      <div className={panel.formRow}>
        {input("block", "room.case.block", {
          maxLength: 20,
          inputMode: "numeric",
        })}
        <label className={styles.detailField}>
          {t("room.case.time")}
          <input
            type="datetime-local"
            value={values.time}
            onChange={(event) => set("time")(event.target.value)}
          />
        </label>
      </div>
      {input("value", "room.case.value", { maxLength: 64, required: true })}
      {input("link", "room.case.link", { maxLength: 300 })}
      {input("note", "room.case.note", { maxLength: 280 })}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={panel.actions}>
        <button type="submit" className="button small" disabled={busy}>
          {t("room.case.addRow")}
        </button>
        <button type="button" className="button small quiet" onClick={onCancel}>
          {t("room.case.cancel")}
        </button>
      </div>
    </form>
  );
}
