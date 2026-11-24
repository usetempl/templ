"use client";

import { useRelease } from "@/lib/release-context";

import { useEffect, useState } from "react";
import { IconHistory } from "@tabler/icons-react";
import {
  ACCESS_AUDIT_RETENTION,
  AUDIT_RETENTION,
  MAX_AUDIT_PAGE,
  READ_AUDIT_RETENTION,
  type AuditStream,
  type ChatAuditEntry,
  type ChatAuditPage,
} from "@templ/chat/audit";
import {
  normalizeChatPrincipal,
  principalLabel,
  type ChatPrincipalId,
} from "@templ/chat/principal";
import { communityFetch, roomPath } from "@/lib/community-client";
import { memberLabel, useMemberProfiles } from "@/lib/member-profiles";
import { formatDay } from "@/lib/product-format";
import { staffDataFlags } from "@/lib/staff-data-release";
import {
  Card,
  EmptyState,
  PageHeader,
  Skeleton,
  Spinner,
  ui,
} from "@/components/ui/ui";
import type { WorkspaceContext } from "./support-workspace";
import styles from "./workspace.module.css";
import { TemplReadsLine } from "./improvement-copy";

type Part = string | { principal: string };
export type ActivityLine = {
  group: "access" | "chats" | "other";
  parts: Part[];
};

/** Names for roles in activity entries, including roles absent from the
 * workspace state. */
const ROLE_NAMES: Record<string, string> = {
  "ai-agent": "AI support",
  "support-member": "Team",
  "support-lead": "Support lead",
  "support-staff": "Support team",
};
/** Separate retention for each log keeps case activity from removing
 * access changes. Reads show once the read log is released. */
const STREAMS: { value: AuditStream; label: string }[] = [
  { value: "access", label: "Access changes" },
  { value: "chats", label: "Cases" },
  { value: "reads", label: "Reads" },
];
const days = (ms: number) => Math.round(ms / 86_400_000);
const KEPT: Record<AuditStream, string> = {
  access: `Templ keeps the newest ${ACCESS_AUDIT_RETENTION.count.toLocaleString("en-US")} access changes from the last ${days(ACCESS_AUDIT_RETENTION.ms)} days`,
  chats: `Templ keeps the newest ${AUDIT_RETENTION.count.toLocaleString("en-US")} case entries from the last ${days(AUDIT_RETENTION.ms)} days`,
  reads: `Templ keeps the newest ${READ_AUDIT_RETENTION.count.toLocaleString("en-US")} reads from the last ${days(READ_AUDIT_RETENTION.ms)} days`,
};
const EMPTY: Record<AuditStream, string> = {
  access:
    "See changes to team access, AI agents, the widget, support settings and saved replies. Case downloads appear here too.",
  chats:
    "Case actions such as assigning, resolving and adding notes show up here.",
  reads:
    "See when the team opens a case, screenshot or inbox. Inbox searches appear here too.",
};
const SEARCHED: Record<string, string> = {
  address: " for an address",
  transaction: " for a transaction",
  "thread-id": " for a case ID",
};

function field(value: unknown, key: string): unknown {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)[key]
    : undefined;
}
const target = (entry: ChatAuditEntry): Part =>
  entry.target ? { principal: entry.target } : "someone";

/** One plain sentence per entry, after the actor's name. Actions this page
 * doesn't know read as another change; stored
 * before/after values are never shown. */
export function describeActivity(
  entry: ChatAuditEntry,
  roleName: (id: string) => string,
): ActivityLine {
  const access = (...parts: Part[]): ActivityLine => ({
    group: "access",
    parts,
  });
  const chats = (...parts: Part[]): ActivityLine => ({ group: "chats", parts });
  const other = (...parts: Part[]): ActivityLine => ({ group: "other", parts });
  const own = entry.target === entry.actor;
  switch (entry.action) {
    case "role.assign": {
      const id = field(entry.after, "roleId");
      const role =
        typeof id === "string" ? `the “${roleName(id)}” role` : "a role";
      return field(entry.after, "granted") === true
        ? access("gave ", target(entry), ` ${role}`)
        : access(`removed ${role} from `, target(entry));
    }
    case "team-invite.create":
      return access("created a single-use team invitation");
    case "team-invite.revoke":
      return access("revoked a team invitation");
    case "team-invite.redeem":
      return access("accepted a team invitation");
    case "role.save": {
      const name = field(entry.after, "name");
      const label =
        typeof name === "string" && name.trim()
          ? name
          : roleName(entry.target ?? "");
      return access(
        `${entry.before ? "changed" : "created"} the “${label}” role`,
      );
    }
    case "moderator.set":
      return access("changed staff powers for ", target(entry));
    case "bot.register":
      return access("labeled ", target(entry), " as an AI agent");
    case "bot.remove":
      return access("removed the AI label from ", target(entry));
    case "manager.nominate":
      return entry.target
        ? access("started a manager change to ", target(entry))
        : access("canceled a manager change");
    case "manager.accept":
      return access("became the workspace manager");
    case "mute":
      return field(entry.after, "until")
        ? access("muted ", target(entry))
        : access("unmuted ", target(entry));
    case "ban":
      return field(entry.after, "banned") === true
        ? access("stopped ", target(entry), " from posting")
        : access("let ", target(entry), " post again");
    case "conversation.open":
      return chats("opened a case");
    case "conversation.start":
      return chats("started a case with ", target(entry));
    case "conversation.reopen":
      return own
        ? chats("reopened their case")
        : chats("reopened a case with ", target(entry));
    case "conversation.resolve":
      return own
        ? chats("resolved their case")
        : chats("resolved a case with ", target(entry));
    case "conversation.stop":
      return chats("stopped team messages");
    case "conversation.resume":
      return chats("asked the team again");
    case "conversation.claim":
      return chats("took the case with ", target(entry));
    case "conversation.release":
      return chats("let go of the case with ", target(entry));
    case "conversation.takeover":
      return chats(
        "took over the case with ",
        target(entry),
        " from a teammate",
      );
    case "conversation.transfer":
      return chats("moved a guest case to a verified wallet");
    case "conversation.link":
      return chats("linked a guest case to their wallet’s case");
    case "support.assign":
      return entry.target
        ? chats("assigned a case to ", target(entry))
        : chats("unassigned a case");
    case "support.verification":
      return chats("asked ", target(entry), " to verify their wallet");
    case "message.delete":
      return chats("deleted a message from ", target(entry));
    case "support.note":
      return chats("added a note");
    case "conversation.export":
      return own
        ? access("downloaded their case")
        : access("downloaded the case with ", target(entry));
    case "widget.origins":
      return access("changed the widget websites");
    case "widget.level":
      return access("changed who can start a case");
    case "widget.wallet-identification":
      return access("changed which wallets visitors can verify");
    case "widget.wallet-fallback":
      return access(
        field(entry.after, "walletFallback") === true
          ? "let people ask when their wallet won't connect"
          : "turned off cases without a working wallet",
      );
    case "widget.hosted-page":
      return access(
        field(entry.after, "hostedPage") === true
          ? "turned on the hosted support page"
          : "turned off the hosted support page",
      );
    case "widget.ask-person":
      return access(
        field(entry.after, "askPerson") === true
          ? "turned on Talk to a person"
          : "turned off Talk to a person",
      );
    case "widget.remember":
      return access(
        field(entry.after, "remember") === true
          ? "turned on remembered sign-in"
          : "turned off remembered sign-in",
      );
    case "widget.sessions-ended":
      return access("signed out all widget users");
    case "widget.guest-check":
      return access(
        field(entry.after, "guestCheck") === "turnstile"
          ? "turned on the visitor check"
          : "turned off the visitor check",
      );
    case "widget.intro":
      return access("changed the widget questions and reply time");
    case "widget.appearance":
      return access("changed the widget appearance");
    case "widget.safety-line":
      return access(
        field(entry.after, "safetyLine") === true
          ? "turned on the line “We never DM you first.”"
          : "turned off the line “We never DM you first.”",
      );
    case "widget.frame":
      return access(
        field(entry.after, "frameRequired") === true
          ? "required frame mode for the widget"
          : "stopped requiring frame mode for the widget",
      );
    case "widget.domain":
      return access("changed the verified domains");
    case "support.replies": {
      const op = field(entry.after, "op");
      return access(
        op === "create"
          ? "added a saved reply"
          : op === "remove"
            ? "removed a saved reply"
            : "changed a saved reply",
      );
    }
    case "support.settings": {
      const before = JSON.stringify(field(entry.before, "testAccounts") ?? []);
      const after = JSON.stringify(field(entry.after, "testAccounts") ?? []);
      return access(
        before === after ? "changed support settings" : "changed test accounts",
      );
    }
    case "room.profile":
      return other("changed the workspace name or picture");
    case "appearance":
      return other("changed the workspace colors");
    case "support.read":
      return field(entry.after, "via") === "attachment"
        ? other("opened a screenshot in the case with ", target(entry))
        : other("opened the case with ", target(entry));
    case "support.search": {
      const hits = field(entry.after, "hits");
      const kind = field(entry.after, "kind");
      const count = typeof hits === "number" ? hits : 0;
      return other(
        `searched the inbox${typeof kind === "string" ? (SEARCHED[kind] ?? "") : ""} and found ${count} ${count === 1 ? "case" : "cases"}`,
      );
    }
    case "support.feed":
      return other("had the inbox open");
    case "workspace.export": {
      if (field(entry.after, "op") === "done") {
        const threads = field(entry.after, "threads");
        return access(
          `finished a workspace export of ${typeof threads === "number" ? threads : 0} cases`,
        );
      }
      return access(
        field(entry.after, "notes") === true
          ? "started a workspace export with internal notes"
          : "started a workspace export",
      );
    }
    case "workspace.deletion-requested":
      return access("asked to delete the workspace");
    case "workspace.deletion-cancelled":
      return access("cancelled the workspace deletion");
    case "workspace.deletion-started":
      return access("started deleting the workspace");
    default:
      return other("made another change");
  }
}

function principals(entries: ChatAuditEntry[]): ChatPrincipalId[] {
  const ids = new Set<ChatPrincipalId>();
  for (const entry of entries)
    for (const value of [entry.actor, entry.target]) {
      const id = normalizeChatPrincipal(value);
      if (id) ids.add(id);
    }
  return [...ids];
}

/** Manager-only history of access changes and chat actions, newest first,
 * one log at a time. */
export function WorkspaceActivity({
  context,
  readLog: suppliedReadlog,
}: {
  context: WorkspaceContext;
  readLog?: boolean;
}) {
  const RELEASE = useRelease();
  const readLog = suppliedReadlog ?? staffDataFlags(RELEASE).readLog;

  const { room, account, state } = context;
  const [stream, setStream] = useState<AuditStream>("access");
  /** The reads log for one person, or everyone. */
  const [actor, setActor] = useState("");
  const [people, setPeople] = useState<string[]>([]);
  const filter =
    stream === "reads" && actor ? `&actor=${encodeURIComponent(actor)}` : "";
  const [pages, setPages] = useState<{
    key: string;
    entries: ChatAuditEntry[];
    nextBefore: string | null;
    error?: string;
  }>();
  const [before, setBefore] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const key = `${room}:${account}:${context.revision}:${stream}:${actor}`;
  const current = pages?.key === key ? pages : undefined;

  useEffect(() => {
    const controller = new AbortController();
    // A filtered page can come back empty with a cursor: keep going, a few
    // pages at a time.
    const read = async () => {
      let page = await communityFetch<ChatAuditPage>(
        roomPath(
          room,
          `audit?stream=${stream}&limit=${MAX_AUDIT_PAGE}${filter}`,
        ),
        undefined,
        controller.signal,
      );
      for (
        let more = 0;
        !page.entries.length && page.nextBefore && more < 10;
        more++
      )
        page = await communityFetch<ChatAuditPage>(
          roomPath(
            room,
            `audit?stream=${stream}&limit=${MAX_AUDIT_PAGE}${filter}&before=${encodeURIComponent(page.nextBefore)}`,
          ),
          undefined,
          controller.signal,
        );
      return page;
    };
    read()
      .then((page) => {
        if (controller.signal.aborted) return;
        setPages({ key, entries: page.entries, nextBefore: page.nextBefore });
        if (stream === "reads" && !actor)
          setPeople((known) => [
            ...new Set([...known, ...page.entries.map((entry) => entry.actor)]),
          ]);
      })
      .catch((reason) => {
        if (!controller.signal.aborted)
          setPages({
            key,
            entries: [],
            nextBefore: null,
            error:
              reason instanceof Error
                ? reason.message
                : "The activity log could not load.",
          });
      });
    return () => controller.abort();
  }, [room, key, stream, filter, actor]);

  useEffect(() => {
    if (!before) return;
    const controller = new AbortController();
    communityFetch<ChatAuditPage>(
      roomPath(
        room,
        `audit?stream=${stream}&limit=${MAX_AUDIT_PAGE}${filter}&before=${encodeURIComponent(before)}`,
      ),
      undefined,
      controller.signal,
    )
      .then((page) => {
        if (controller.signal.aborted) return;
        setPages((previous) =>
          previous?.key === key
            ? {
                key,
                entries: [...previous.entries, ...page.entries],
                nextBefore: page.nextBefore,
              }
            : previous,
        );
      })
      .catch((reason) => {
        if (controller.signal.aborted) return;
        setPages((previous) =>
          previous?.key === key
            ? {
                ...previous,
                error:
                  reason instanceof Error
                    ? reason.message
                    : "Older activity could not load.",
              }
            : previous,
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoadingMore(false);
          setBefore(null);
        }
      });
    return () => controller.abort();
  }, [room, key, stream, before, filter]);

  const entries = current?.entries ?? [];
  const profiles = useMemberProfiles(
    principals(entries).concat(
      people.flatMap((id) => normalizeChatPrincipal(id) ?? []),
    ),
  );
  const roleName = (id: string) =>
    state.roles.find((role) => role.id === id)?.name ?? ROLE_NAMES[id] ?? id;
  const lines = entries.map((entry) => ({
    entry,
    line: describeActivity(entry, roleName),
  }));

  const name = (id: string) => {
    if (id === account) return <strong>You</strong>;
    const normalized = normalizeChatPrincipal(id);
    if (!normalized) return <strong>{id}</strong>;
    const profile = profiles.get(normalized.toLowerCase());
    const label = memberLabel(profile, normalized);
    const short = principalLabel(normalized);
    return (
      <strong title={normalized}>
        {label}
        {label !== short && <span className={styles.activityId}> {short}</span>}
      </strong>
    );
  };
  const sentence = (line: ActivityLine) =>
    line.parts.map((part, index) =>
      typeof part === "string" ? (
        <span key={index}>{part}</span>
      ) : (
        <span key={index}>{name(part.principal)}</span>
      ),
    );

  return (
    <div className={`${styles.page} ${styles.pageNarrow}`}>
      <PageHeader
        eyebrow="Activity"
        title="Who changed what"
        description={
          readLog
            ? "Access changes, case actions and reads in this workspace, newest first. Only you can see this page."
            : "Access changes and case actions in this workspace, newest first. Only you can see this page."
        }
      />
      <div className={styles.stack}>
        {/* The month's line about Templ's reads. */}
        <TemplReadsLine room={room} />
        <div className={ui.tabs} role="group" aria-label="Show">
          {STREAMS.filter((item) => readLog || item.value !== "reads").map(
            (item) => (
              <button
                key={item.value}
                type="button"
                className={ui.tab}
                aria-pressed={stream === item.value}
                onClick={() => {
                  setStream(item.value);
                  setActor("");
                  setBefore(null);
                  setLoadingMore(false);
                }}
              >
                {item.label}
              </button>
            ),
          )}
        </div>
        {stream === "reads" && (
          <label className={styles.small}>
            Show{" "}
            <select
              className={ui.input}
              value={actor}
              onChange={(event) => {
                setActor(event.target.value);
                setBefore(null);
                setLoadingMore(false);
              }}
            >
              <option value="">Everyone</option>
              {people.map((id) => {
                const normalized = normalizeChatPrincipal(id);
                const label =
                  id === account
                    ? "You"
                    : normalized
                      ? memberLabel(
                          profiles.get(normalized.toLowerCase()),
                          normalized,
                        )
                      : id;
                return (
                  <option key={id} value={id}>
                    {label}
                  </option>
                );
              })}
            </select>
          </label>
        )}
        <Card>
          {!current ? (
            <div className={styles.stack} style={{ gap: 12 }}>
              <Skeleton height={36} />
              <Skeleton height={36} />
              <Skeleton height={36} />
            </div>
          ) : current.error && !entries.length ? (
            <p className={styles.error} role="alert">
              {current.error}
            </p>
          ) : !lines.length ? (
            <EmptyState icon={<IconHistory />} title="Nothing here yet">
              {EMPTY[stream]}
            </EmptyState>
          ) : (
            <ol className={styles.activityList}>
              {lines.map(({ entry, line }) => (
                <li key={entry.id} className={styles.activityRow}>
                  <p>
                    {name(entry.actor)} {sentence(line)}
                  </p>
                  <time
                    dateTime={entry.at}
                    title={new Date(entry.at).toLocaleString()}
                  >
                    {formatDay(entry.at)}{" "}
                    {new Date(entry.at).toLocaleTimeString([], {
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </time>
                </li>
              ))}
            </ol>
          )}
          {current?.error && entries.length > 0 && (
            <p className={styles.error} role="alert" style={{ marginTop: 12 }}>
              {current.error}
            </p>
          )}
          {current?.nextBefore && (
            <button
              type="button"
              className="button small quiet"
              style={{ marginTop: 12 }}
              disabled={loadingMore}
              onClick={() => {
                setLoadingMore(true);
                setBefore(current.nextBefore);
              }}
            >
              {loadingMore && <Spinner />}Load older entries
            </button>
          )}
        </Card>
        <p className={styles.small}>
          {KEPT[stream]} and removes older ones when the next entry is written.{" "}
          {readLog
            ? "Reads show each opened case at most once every 30 minutes per person. New messages that reach an open inbox aren’t listed one by one. The log doesn’t record changes from a case’s Status menu yet."
            : "The log doesn’t record case reads or changes from a case’s Status menu yet."}
        </p>
      </div>
    </div>
  );
}
