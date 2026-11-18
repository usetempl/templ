"use client";
import { useState, type FormEvent } from "react";
import type { SupportSettings } from "@templ/chat/support";
import {
  isSourceHost,
  type SupportCaseSettings,
} from "@templ/chat/support-drafts";
import { copy as t } from "@/lib/copy";
import { chatMutation } from "@/lib/chat-api";
import { roomPath } from "@/lib/community-client";
import { Card, Field, Spinner, ui } from "@/components/ui/ui";
import type { WorkspaceContext } from "./support-workspace";
import styles from "./workspace.module.css";
import { UnsavedChanges } from "./unsaved-changes";

/** The manager's checks on AI agent replies: hold a reply whose numbers
 * don't cite evidence, and the sites source links may open. A save sends
 * only these fields; the service keeps every other setting as it is. */
export function AiReplyChecks({
  context,
  initial,
  canEdit,
}: {
  context: WorkspaceContext;
  initial: SupportSettings & SupportCaseSettings;
  canEdit: boolean;
}) {
  const { room, account } = context;
  const [hold, setHold] = useState(initial.agentChecks?.citations === "hold");
  const [hosts, setHosts] = useState((initial.aiSourceHosts ?? []).join("\n"));
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const list = hosts
    .split("\n")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  const badHost = list.some((host) => !isSourceHost(host));
  const [baseline, setBaseline] = useState(() => ({
    hold: initial.agentChecks?.citations === "hold",
    hosts: initial.aiSourceHosts ?? [],
  }));
  const dirty =
    hold !== baseline.hold ||
    JSON.stringify(list) !== JSON.stringify(baseline.hosts);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!canEdit || !dirty || !confirmed || busy || badHost) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await chatMutation(
        account as never,
        roomPath(room, "conversations/settings"),
        {
          agentChecks: { citations: hold ? "hold" : "off" },
          aiSourceHosts: list,
          confirmed,
        },
      );
      setConfirmed(false);
      setNotice(t("room.checks.saved"));
      setBaseline({ hold, hosts: list });
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : t("room.team.errorGeneric"),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={(event) => void save(event)}>
      <UnsavedChanges dirty={dirty} />
      <Card
        title={t("room.checks.title")}
        description={t("room.checks.description")}
        footer={
          canEdit ? (
            <>
              <label className={ui.check}>
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={!dirty || badHost}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                {t("room.checks.confirm")}
              </label>
              <button
                type="submit"
                className="button"
                disabled={!dirty || !confirmed || busy || badHost}
              >
                {busy && <Spinner />}
                {t("room.checks.save")}
              </button>
            </>
          ) : undefined
        }
      >
        <fieldset
          disabled={!canEdit || busy}
          className={styles.formGrid}
          style={{ border: 0, margin: 0, padding: 0 }}
        >
          <label className={ui.check}>
            <input
              type="checkbox"
              checked={hold}
              onChange={(event) => {
                setHold(event.target.checked);
                setConfirmed(false);
                setNotice("");
              }}
            />
            {t("room.checks.citations")}
          </label>
          <div>
            <p style={{ margin: 0 }}>{t("room.checks.holdIntro")}</p>
            <ul style={{ margin: "4px 0", paddingLeft: 18 }}>
              <li>{t("room.checks.holdUncited")}</li>
              <li>{t("room.checks.holdUnlabeled")}</li>
            </ul>
            <p style={{ margin: 0 }}>{t("room.checks.heldWhere")}</p>
          </div>
          <Field
            label={t("room.checks.hosts")}
            optional
            hint={t("room.checks.hostsHint")}
            error={badHost ? t("room.checks.badHost") : undefined}
          >
            <textarea
              className={ui.input}
              rows={3}
              value={hosts}
              placeholder="docs.example.org"
              onChange={(event) => {
                setHosts(event.target.value);
                setConfirmed(false);
                setNotice("");
              }}
            />
          </Field>
          {notice && (
            <p className={styles.status} role="status">
              {notice}
            </p>
          )}
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
        </fieldset>
      </Card>
    </form>
  );
}
