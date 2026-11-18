"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { ChatMessage, ChatRoomId } from "@templ/chat/index";
import type { ChatPrincipalId } from "@templ/chat/principal";
import type { SupportNote } from "@templ/chat/support";
import {
  FOLLOW_UP_TYPE_LABELS,
  type SupportFollowUp,
  type SupportFollowUpQueue,
  type SupportFollowUpQueueView,
  type SupportFollowUpRow,
} from "@templ/chat/support-follow-ups";
import {
  FOLLOW_UP_COPY,
  FOLLOW_UP_QUEUE_COPY as q,
  SPECIALIST_COPY as s,
} from "@/lib/copy/follow-ups";
import { chatMutation } from "@/lib/chat-api";
import {
  CommunityApiError,
  communityFetch,
  roomPath,
} from "@/lib/community-client";
import { memberLabel, useMemberProfiles } from "@/lib/member-profiles";
import {
  changeFollowUp,
  newFollowUpClientId,
  readFollowUpQueue,
} from "@/lib/support-follow-ups-client";
import { Card, PageHeader } from "@/components/ui/ui";
import { FollowUpsSection, errorText } from "@/components/follow-ups-section";
import type { WorkspaceContext } from "./support-workspace";
import own from "@/components/follow-ups.module.css";
import styles from "./workspace.module.css";

const fill = (text: string, values: Record<string, string>) =>
  text.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match);
const utc = (at: string) => `${at.slice(0, 16).replace("T", " ")} UTC`;
function age(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return "<1 h";
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}
const full = (row: SupportFollowUpRow): SupportFollowUp | null =>
  row.readable ? (row.followUp as SupportFollowUp) : null;

/** The queue: every open follow-up by owner and age for the team, or a
 * specialist's own ones and their groups'. */
function Queue({
  room,
  account,
  views,
  onOpen,
}: {
  room: ChatRoomId;
  account: ChatPrincipalId | undefined;
  views: readonly SupportFollowUpQueueView[];
  onOpen: (conversation: string) => void;
}) {
  const [view, setView] = useState<SupportFollowUpQueueView>(views[0]);
  const [data, setData] = useState<SupportFollowUpQueue | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(
    (signal?: AbortSignal) =>
      readFollowUpQueue(room, { view }, signal).then(
        (next) => {
          setData(next);
          setError("");
        },
        (reason: unknown) => {
          if (!signal?.aborted) setError(errorText(reason));
        },
      ),
    [room, view],
  );
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);
  const owners = [
    ...new Set(
      (data?.owners ?? [])
        .flatMap((row) => (row.owner ? [row.owner] : []))
        .concat(
          (data?.rows ?? []).flatMap((row) => {
            const item = full(row);
            return item?.owner ? [item.owner] : [];
          }),
        ),
    ),
  ];
  const profiles = useMemberProfiles(owners);
  const name = (id: string) =>
    id === account ? FOLLOW_UP_COPY.you : memberLabel(profiles.get(id), id);
  async function take(row: SupportFollowUpRow) {
    setBusy(true);
    try {
      await changeFollowUp(account, room, row.conversation, row.followUp.id, {
        op: "take",
        revision: row.followUp.revision,
      });
      onOpen(row.conversation);
    } catch (reason) {
      setError(errorText(reason));
      void load();
    } finally {
      setBusy(false);
    }
  }
  const empty =
    view === "mine" ? q.emptyMine : view === "group" ? q.emptyGroup : q.empty;
  return (
    <div className={styles.stack}>
      <div className={own.tabs} role="group" aria-label={q.title}>
        {views.map((item) => (
          <button
            key={item}
            type="button"
            className="button small quiet"
            aria-pressed={view === item}
            onClick={() => setView(item)}
          >
            {q.views[item]}
          </button>
        ))}
      </div>
      {error && <p role="alert">{error}</p>}
      {data && data.owners.length > 0 && (
        <Card title={q.byOwner}>
          <table className={own.table}>
            <thead>
              <tr>
                <th>{q.ownerCol}</th>
                <th>{q.openCol}</th>
                <th>{q.blockedCol}</th>
                <th>{q.overdueCol}</th>
                <th>{q.oldestCol}</th>
              </tr>
            </thead>
            <tbody>
              {data.owners.map((row) => (
                <tr key={`${row.owner ?? ""}:${row.group ?? ""}`}>
                  <td>
                    {row.owner
                      ? name(row.owner)
                      : row.group
                        ? fill(FOLLOW_UP_COPY.group, { name: row.group })
                        : FOLLOW_UP_COPY.ownerNone}
                  </td>
                  <td>{row.open}</td>
                  <td>{row.blocked}</td>
                  <td>{row.overdue}</td>
                  <td>{utc(row.oldestAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {data && (
        <Card>
          {data.rows.length === 0 ? (
            <p className={styles.muted}>{empty}</p>
          ) : (
            <table className={own.table}>
              <thead>
                <tr>
                  <th>{q.ageCol}</th>
                  <th>{q.typeCol}</th>
                  <th>{q.whatCol}</th>
                  <th>{q.ownerCol}</th>
                  <th>{q.dueCol}</th>
                  <th>{q.stateCol}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => {
                  const item = full(row);
                  return (
                    <tr key={`${row.conversation}:${row.followUp.id}`}>
                      <td>{age(row.ageMs)}</td>
                      <td>{FOLLOW_UP_TYPE_LABELS[row.followUp.type]}</td>
                      <td>
                        {item
                          ? item.title
                          : fill(q.waitingFor, {
                              group: row.followUp.group ?? "",
                            })}
                        {row.followUp.overdue && (
                          <span className={own.warn}>
                            {" "}
                            {FOLLOW_UP_COPY.overdue}
                          </span>
                        )}
                      </td>
                      <td>
                        {item?.owner
                          ? name(item.owner)
                          : FOLLOW_UP_COPY.ownerNone}
                      </td>
                      <td>
                        {row.followUp.dueAt ? utc(row.followUp.dueAt) : ""}
                      </td>
                      <td>{FOLLOW_UP_COPY[row.followUp.state]}</td>
                      <td>
                        {row.readable ? (
                          <button
                            type="button"
                            className="button small secondary"
                            onClick={() => onOpen(row.conversation)}
                          >
                            {q.openRequest}
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="button small"
                            disabled={busy}
                            onClick={() => void take(row)}
                          >
                            {FOLLOW_UP_COPY.take}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {!data.complete && <p className={styles.muted}>{q.incomplete}</p>}
        </Card>
      )}
    </div>
  );
}

/** The Follow-ups tab for the team. "Open request" opens the thread in
 * the inbox. */
export function WorkspaceFollowUps({ context }: { context: WorkspaceContext }) {
  return (
    <div className={styles.stack}>
      <PageHeader title={q.title} description={q.lede} />
      <Queue
        room={context.room}
        account={context.account}
        views={["open", "overdue", "mine", "group"]}
        onOpen={(conversation) => context.go("inbox", conversation)}
      />
    </div>
  );
}

type SpecialistRead = {
  conversation: { followUp?: { text: string } | null };
  specialistAccess: { via: string[]; until: string | null; from: string };
};
/** One request as a specialist reads it: the banner, the request's own
 * messages, the team's notes, a note composer and their follow-ups. No
 * reply composer: specialists never write to the member. */
function SpecialistThread({
  room,
  account,
  thread,
  onBack,
}: {
  room: ChatRoomId;
  account: ChatPrincipalId | undefined;
  thread: string;
  onBack: () => void;
}) {
  const [read, setRead] = useState<SpecialistRead | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [notes, setNotes] = useState<SupportNote[]>([]);
  const [gone, setGone] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const base = roomPath(room, `conversations/${thread}`);
        const [head, page, workflow] = await Promise.all([
          communityFetch<SpecialistRead>(base, undefined, signal),
          communityFetch<{ messages: ChatMessage[] }>(
            `${base}/messages`,
            undefined,
            signal,
          ),
          communityFetch<{ workflow: { notes: SupportNote[] } }>(
            `${base}/workflow`,
            undefined,
            signal,
          ),
        ]);
        setRead(head);
        setMessages(page.messages);
        setNotes(workflow.workflow.notes);
      } catch (reason) {
        if (signal?.aborted) return;
        if (reason instanceof CommunityApiError && reason.status === 404)
          setGone(true);
        else setError(errorText(reason));
      }
    },
    [room, thread],
  );
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, revision]);
  const authors = [...new Set(notes.map((item) => item.author))];
  const profiles = useMemberProfiles(authors);
  async function addNote(event: FormEvent) {
    event.preventDefault();
    if (!note.trim()) return;
    setBusy(true);
    setError("");
    try {
      await chatMutation(
        account,
        roomPath(room, `conversations/${thread}/workflow`),
        {
          action: "note",
          text: note.trim(),
          clientId: newFollowUpClientId(),
        },
      );
      setNote("");
      setRevision((value) => value + 1);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }
  if (gone)
    return (
      <div className={styles.stack}>
        <p role="status">{s.gone}</p>
        <button type="button" className="button secondary" onClick={onBack}>
          {s.back}
        </button>
      </div>
    );
  if (!read) return error ? <p role="alert">{error}</p> : null;
  const mention = !read.specialistAccess.via.includes("owner");
  return (
    <div className={styles.stack}>
      <button type="button" className="button small quiet" onClick={onBack}>
        {s.back}
      </button>
      <ul className={own.banner} role="note">
        <li>
          {mention && read.specialistAccess.until
            ? fill(s.bannerMention, { date: utc(read.specialistAccess.until) })
            : s.bannerOwner}
        </li>
        <li>{s.bannerNotes}</li>
        <li>{s.noReply}</li>
      </ul>
      <Card title={s.messages}>
        <ul className={own.messages}>
          {messages.map((message) => (
            <li key={message.id}>{message.text}</li>
          ))}
        </ul>
      </Card>
      <Card title={s.notes}>
        <ul className={own.messages}>
          {notes.map((item) => (
            <li key={item.id}>
              <span className={styles.muted}>
                {item.author === account
                  ? FOLLOW_UP_COPY.you
                  : memberLabel(profiles.get(item.author), item.author)}
              </span>
              <div>{item.text}</div>
            </li>
          ))}
        </ul>
        <form className={own.form} onSubmit={(event) => void addNote(event)}>
          <label>
            {s.note}
            <textarea
              rows={3}
              maxLength={4000}
              placeholder={s.notePlaceholder}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          <button
            type="submit"
            className="button small"
            disabled={busy || !note.trim()}
          >
            {s.addNote}
          </button>
          {error && <p role="alert">{error}</p>}
        </form>
      </Card>
      <FollowUpsSection
        enabled
        room={room}
        account={account}
        thread={thread}
        viewer="specialist"
        refreshKey={revision}
        onChanged={() => setRevision((value) => value + 1)}
      />
    </div>
  );
}

/** What a specialist sees in a workspace: their follow-ups and their
 * groups', and one request at a time. */
export function SpecialistFollowUps({
  room,
  account,
  name,
}: {
  room: ChatRoomId;
  account: ChatPrincipalId | undefined;
  name: string;
}) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className={styles.stack}>
      <PageHeader eyebrow={name} title={s.title} description={s.lede} />
      {open ? (
        <SpecialistThread
          room={room}
          account={account}
          thread={open}
          onBack={() => setOpen(null)}
        />
      ) : (
        <Queue
          room={room}
          account={account}
          views={["mine", "group"]}
          onOpen={setOpen}
        />
      )}
    </div>
  );
}
