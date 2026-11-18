"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { ChatRole, ChatState } from "@templ/chat/index";
import {
  normalizeChatPrincipal,
  type ChatPrincipalId,
} from "@templ/chat/principal";
import {
  SUPPORT_HANDOFF_REASONS,
  type SupportHandoffReason,
} from "@templ/chat/support";
import {
  FOLLOW_UP_LIMITS,
  FOLLOW_UP_TYPE_LABELS,
  SUPPORT_FOLLOW_UP_TYPES,
  type SupportFollowUpGroup,
  type SupportFollowUpRoute,
  type SupportFollowUpSettingsView,
  type SupportFollowUpType,
} from "@templ/chat/support-follow-ups";
import { ROUTING_COPY as r } from "@/lib/copy/follow-ups";
import { chatMutation } from "@/lib/chat-api";
import {
  CommunityApiError,
  communityFetch,
  roomPath,
} from "@/lib/community-client";
import { memberLabel, useMemberProfiles } from "@/lib/member-profiles";
import {
  readFollowUpSettings,
  saveFollowUpSettings,
} from "@/lib/support-follow-ups-client";
import { Card, Skeleton } from "@/components/ui/ui";
import { errorText, followUpsAllowed } from "@/components/follow-ups-section";
import type { WorkspaceContext } from "@/components/workspace/support-workspace";
import { UnsavedChanges } from "@/components/workspace/unsaved-changes";
import own from "./follow-ups.module.css";
import styles from "./team-conversations.module.css";

/** Staff labels for handoff reasons, as the inbox shows them. */
const REASON_TEXT: Record<SupportHandoffReason, string> = {
  quote: "Quote",
  privacy: "Privacy",
  account: "Account",
  billing: "Billing",
  legal: "Legal",
  safety: "Security or safety",
  transaction: "Transaction",
  bug: "Bug",
  person: "Human requested",
  unsure: "Unsure",
  other: "Other",
  strategy: "Strategy action",
  access: "Access or permission change",
  recovery: "Fund or account recovery",
  decision: "Needs a team decision",
  internal: "Needs internal information",
};
/** The Specialist role this section keeps. */
const SPECIALIST_ROLE = {
  id: "support-specialist",
  name: "Specialist",
  permissions: ["handleFollowUps"],
} as const;
const groupId = () =>
  `g-${[...crypto.getRandomValues(new Uint8Array(4))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;

/** What a specialist change does, shown before it applies. */
const grantReview = (who: string) =>
  `${who} gets the Specialist role. They read only cases where they own a follow-up or a teammate mentions them. They can't reply to users.`;
const removeReview = (who: string) =>
  `${who} loses the Specialist role and the case access it gives.`;
const CONFIRM_GROUPS = "I checked the people in each group.";
const CONFIRM = "Confirm";
const CANCEL = "Cancel";
const TRY_AGAIN = "Try again";

/** Specialists: the manager adds or removes the role by account ID or 0x
 * address, after a review. The role alone reads nothing. */
function Specialists({
  context,
  specialists,
  name,
  onChanged,
}: {
  context: WorkspaceContext;
  specialists: readonly ChatPrincipalId[];
  name: (id: string) => string;
  onChanged: () => void;
}) {
  const [target, setTarget] = useState("");
  const [review, setReview] = useState<{
    principalId: ChatPrincipalId;
    granted: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { room, account } = context;
  async function ensureRole() {
    const state = await communityFetch<ChatState>(roomPath(room, "channels"));
    const existing = state.roles.find(
      (role: ChatRole) => role.id === SPECIALIST_ROLE.id,
    );
    if (!existing)
      await chatMutation(account, roomPath(room, "roles"), {
        id: SPECIALIST_ROLE.id,
        name: SPECIALIST_ROLE.name,
        mode: "manual",
        moderationPermissions: SPECIALIST_ROLE.permissions,
        confirmed: true,
      });
    else if (
      existing.mode !== "manual" ||
      existing.enabled === false ||
      (existing.moderationPermissions ?? []).join() !== "handleFollowUps"
    )
      throw new Error(r.roleChanged);
  }
  async function assign(principalId: ChatPrincipalId, granted: boolean) {
    setBusy(true);
    setError("");
    try {
      if (granted) await ensureRole();
      await chatMutation(
        account,
        roomPath(room, `roles/${SPECIALIST_ROLE.id}/assign`),
        { principalId, granted, confirmed: true },
      );
      if (granted) setTarget("");
      setReview(null);
      onChanged();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const id = normalizeChatPrincipal(target.trim());
    if (!id) {
      setError(r.addInvalid);
      return;
    }
    setError("");
    setReview({ principalId: id, granted: true });
  };
  return (
    <div className={own.form}>
      <UnsavedChanges dirty={!!target.trim()} />
      <h4>{r.specialists}</h4>
      <p className={styles.detailMuted}>{r.specialistsHelp}</p>
      {specialists.length === 0 ? (
        <p className={styles.detailMuted}>{r.noSpecialists}</p>
      ) : (
        <ul className={own.facts}>
          {specialists.map((id) => (
            <li key={id}>
              {name(id)}{" "}
              <button
                type="button"
                className="button small quiet"
                disabled={busy}
                onClick={() => {
                  setError("");
                  setReview({ principalId: id, granted: false });
                }}
              >
                {r.remove}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className={own.watchForm} onSubmit={submit}>
        <label className={styles.detailField}>
          {r.addLabel}
          <input
            value={target}
            onChange={(event) => {
              setTarget(event.target.value);
              if (review?.granted) setReview(null);
            }}
          />
        </label>
        <button
          type="submit"
          className="button small secondary"
          disabled={busy || !target.trim()}
        >
          {r.add}
        </button>
      </form>
      {review && (
        <div
          className={own.banner}
          role="group"
          aria-label={review.granted ? r.add : r.remove}
        >
          <p style={{ margin: 0 }}>
            {(review.granted ? grantReview : removeReview)(
              name(review.principalId),
            )}
          </p>
          <div className={own.tabs}>
            <button
              type="button"
              className="button small"
              disabled={busy}
              onClick={() => void assign(review.principalId, review.granted)}
            >
              {CONFIRM}
            </button>
            <button
              type="button"
              className="button small secondary"
              disabled={busy}
              onClick={() => setReview(null)}
            >
              {CANCEL}
            </button>
          </div>
        </div>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

type Draft = {
  groups: SupportFollowUpGroup[];
  routes: SupportFollowUpRoute[];
};
/** The last settings read or saved, and the edits made since. */
type Form = { view: SupportFollowUpSettingsView; draft: Draft | null };
const usable = (next: SupportFollowUpSettingsView | null | undefined) =>
  !!next &&
  Array.isArray(next.groups) &&
  Array.isArray(next.routes) &&
  !!next.eligible &&
  Array.isArray(next.eligible.staff) &&
  Array.isArray(next.eligible.specialists);
/** A worker without follow-ups answers 404 or 503; the section hides. */
const unavailable = (reason: unknown) =>
  reason instanceof CommunityApiError &&
  (reason.status === 404 || reason.status === 503);
const changed = ({ view, draft }: Form) =>
  !!draft &&
  JSON.stringify(draft) !==
    JSON.stringify({ groups: view.groups, routes: view.routes });

/** Settings: Admins edit groups and routing rules. The owner manages specialists. Shown only while follow-ups
 * are live for this build and the worker answers. */
export function FollowUpRoutingSettings({
  context,
}: {
  context: WorkspaceContext;
}) {
  const { room, account } = context;
  const [form, setForm] = useState<Form>();
  const enabled = followUpsAllowed(context.state?.features);
  const [hidden, setHidden] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmedGroups, setConfirmedGroups] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  // A specialist change reads who can join groups again; unsaved groups and
  // rules stay.
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!enabled || hidden) return;
    const controller = new AbortController();
    readFollowUpSettings(room, controller.signal).then(
      (next) => {
        if (controller.signal.aborted) return;
        // A worker without these routes, or anything else answering, hides
        // the section.
        if (!usable(next)) {
          setHidden(true);
          return;
        }
        setLoadError("");
        setForm({ view: next, draft: null });
      },
      (reason: unknown) => {
        if (controller.signal.aborted) return;
        if (unavailable(reason)) setHidden(true);
        else setLoadError(errorText(reason));
      },
    );
    return () => controller.abort();
  }, [room, hidden, attempt, enabled]);
  useEffect(() => {
    if (!refresh || !enabled || hidden) return;
    const controller = new AbortController();
    readFollowUpSettings(room, controller.signal).then(
      (next) => {
        if (controller.signal.aborted) return;
        if (!usable(next)) {
          setHidden(true);
          return;
        }
        // Unsaved edits keep the revision they started from, so the service
        // still refuses a save over someone else's change. An answer older
        // than a save that already landed only updates who can join.
        setForm((previous) =>
          previous &&
          (changed(previous) || next.revision < previous.view.revision)
            ? {
                ...previous,
                view: { ...previous.view, eligible: next.eligible },
              }
            : { view: next, draft: null },
        );
      },
      (reason: unknown) => {
        if (controller.signal.aborted) return;
        if (unavailable(reason)) setHidden(true);
        else setError(errorText(reason));
      },
    );
    return () => controller.abort();
  }, [room, refresh, enabled, hidden]);
  const view = form?.view;
  const people = [
    ...new Set([
      ...(view?.eligible.staff ?? []),
      ...(view?.eligible.specialists ?? []),
    ]),
  ];
  const profiles = useMemberProfiles(people);
  const name = (id: string) => memberLabel(profiles.get(id), id);
  if (!enabled || hidden) return null;
  if (!form || !view)
    return (
      <Card id="follow-up-routing" title={r.title} description={r.lede}>
        {loadError ? (
          <div className={own.form}>
            <p className={styles.error} role="alert">
              {loadError}
            </p>
            <div>
              <button
                type="button"
                className="button small secondary"
                onClick={() => {
                  setLoadError("");
                  setAttempt((value) => value + 1);
                }}
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
  const groups = form.draft?.groups ?? view.groups;
  const routes = form.draft?.routes ?? view.routes;
  const dirty = changed(form);
  // A change of who is in a group is a privileged change: the service asks
  // for a valid wallet session and this confirmation.
  const groupsChanged = JSON.stringify(groups) !== JSON.stringify(view.groups);
  const editGroups = view.canEditGroups;
  const editRoutes = view.canEditRoutes;
  async function save() {
    if (!form || !view) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const next = await saveFollowUpSettings(account, room, {
        revision: view.revision,
        groups,
        routes,
        ...(groupsChanged ? { confirmed: true as const } : {}),
      });
      setForm({ view: next, draft: null });
      setConfirmedGroups(false);
      setMessage(r.saved);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }
  const edit = (change: (draft: Draft) => Draft) => {
    setMessage("");
    setForm(
      (previous) =>
        previous && {
          view: previous.view,
          draft: change(
            previous.draft ?? {
              groups: previous.view.groups,
              routes: previous.view.routes,
            },
          ),
        },
    );
  };
  const setGroups = (
    change: (list: SupportFollowUpGroup[]) => SupportFollowUpGroup[],
  ) => {
    setConfirmedGroups(false);
    edit((draft) => ({ ...draft, groups: change(draft.groups) }));
  };
  const setRoutes = (
    change: (list: SupportFollowUpRoute[]) => SupportFollowUpRoute[],
  ) => edit((draft) => ({ ...draft, routes: change(draft.routes) }));
  const setGroup = (index: number, patch: Partial<SupportFollowUpGroup>) =>
    setGroups((list) =>
      list.map((item, at) => (at === index ? { ...item, ...patch } : item)),
    );
  const setRoute = (index: number, patch: Partial<SupportFollowUpRoute>) =>
    setRoutes((list) =>
      list.map((item, at) => (at === index ? { ...item, ...patch } : item)),
    );
  const unused = SUPPORT_HANDOFF_REASONS.filter(
    (reason) => !routes.some((route) => route.reason === reason),
  );
  // Stored settings that failed their check can be replaced as they are.
  const canSave =
    (dirty || view.status === "unreadable") &&
    (!groupsChanged || confirmedGroups);
  return (
    <Card id="follow-up-routing" title={r.title} description={r.lede}>
      <UnsavedChanges dirty={dirty} />
      <div className={own.form}>
        {view.status === "unreadable" && (
          <p className={styles.error} role="alert">
            {r.unreadable}
          </p>
        )}
        {editGroups && context.manager && (
          <Specialists
            context={context}
            specialists={view.eligible.specialists}
            name={name}
            onChanged={() => setRefresh((value) => value + 1)}
          />
        )}
        <h4>{r.groups}</h4>
        <p className={styles.detailMuted}>{r.groupsHelp}</p>
        {groups.map((group, index) => (
          <fieldset
            key={group.id}
            className={own.form}
            disabled={!editGroups || busy}
          >
            <label className={styles.detailField}>
              {r.groupName}
              <input
                maxLength={FOLLOW_UP_LIMITS.groupNameChars}
                value={group.name}
                onChange={(event) =>
                  setGroup(index, { name: event.target.value })
                }
              />
            </label>
            <label className={styles.detailField}>
              {r.people}
              <select
                multiple
                value={group.members}
                onChange={(event) =>
                  setGroup(index, {
                    members: [...event.target.selectedOptions].map(
                      (option) => option.value as ChatPrincipalId,
                    ),
                  })
                }
              >
                {people.map((id) => (
                  <option key={id} value={id}>
                    {name(id)}
                  </option>
                ))}
              </select>
            </label>
            {editGroups && (
              <button
                type="button"
                className="button small quiet"
                onClick={() => {
                  setGroups((list) => list.filter((_, at) => at !== index));
                  setRoutes((list) =>
                    list.filter((route) => route.group !== group.id),
                  );
                }}
              >
                {r.removeGroup}
              </button>
            )}
          </fieldset>
        ))}
        {editGroups && groups.length < FOLLOW_UP_LIMITS.groups && (
          <button
            type="button"
            className="button small secondary"
            disabled={busy}
            onClick={() =>
              setGroups((list) => [
                ...list,
                { id: groupId(), name: "", members: [] },
              ])
            }
          >
            {r.addGroup}
          </button>
        )}
        <h4>{r.rules}</h4>
        {groups.length === 0 ? (
          <p className={styles.detailMuted}>{r.noGroups}</p>
        ) : (
          routes.map((route, index) => (
            <fieldset
              key={route.reason}
              className={own.form}
              disabled={!editRoutes || busy}
            >
              <div className={own.tabs}>
                <label className={styles.detailField}>
                  {r.reason}
                  <select
                    value={route.reason}
                    onChange={(event) =>
                      setRoute(index, {
                        reason: event.target.value as SupportHandoffReason,
                      })
                    }
                  >
                    {[route.reason, ...unused].map((reason) => (
                      <option key={reason} value={reason}>
                        {REASON_TEXT[reason]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={styles.detailField}>
                  {r.type}
                  <select
                    value={route.type}
                    onChange={(event) =>
                      setRoute(index, {
                        type: event.target.value as SupportFollowUpType,
                      })
                    }
                  >
                    {SUPPORT_FOLLOW_UP_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {FOLLOW_UP_TYPE_LABELS[type]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={styles.detailField}>
                  {r.group}
                  <select
                    value={route.group}
                    onChange={(event) =>
                      setRoute(index, { group: event.target.value })
                    }
                  >
                    {groups.map((group) => (
                      <option key={group.id} value={group.id}>
                        {group.name || group.id}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className={own.tabs}>
                <label className={styles.detailField}>
                  {r.memberSees}
                  <input
                    maxLength={FOLLOW_UP_LIMITS.labelChars}
                    placeholder={r.memberSeesDefault}
                    value={route.publicLabel ?? ""}
                    onChange={(event) =>
                      setRoute(index, {
                        publicLabel: event.target.value || null,
                      })
                    }
                  />
                </label>
                <label className={styles.detailField}>
                  {r.nextDays}
                  <input
                    type="number"
                    min={1}
                    max={FOLLOW_UP_LIMITS.nextUpdateMaxDays}
                    value={route.nextUpdateDays}
                    onChange={(event) =>
                      setRoute(index, {
                        nextUpdateDays: Number(event.target.value),
                      })
                    }
                  />
                </label>
                <label className={styles.detailField}>
                  {r.dueDays}
                  <input
                    type="number"
                    min={1}
                    max={FOLLOW_UP_LIMITS.dueMaxDays}
                    value={route.dueDays ?? ""}
                    onChange={(event) =>
                      setRoute(index, {
                        dueDays: event.target.value
                          ? Number(event.target.value)
                          : null,
                      })
                    }
                  />
                </label>
              </div>
              <label className={own.check}>
                <input
                  type="checkbox"
                  checked={route.memberVisible}
                  onChange={(event) =>
                    setRoute(index, { memberVisible: event.target.checked })
                  }
                />
                {r.show}
              </label>
              {editRoutes && (
                <button
                  type="button"
                  className="button small quiet"
                  onClick={() =>
                    setRoutes((list) => list.filter((_, at) => at !== index))
                  }
                >
                  {r.removeRule}
                </button>
              )}
            </fieldset>
          ))
        )}
        {editRoutes && groups.length > 0 && unused.length > 0 && (
          <button
            type="button"
            className="button small secondary"
            disabled={busy}
            onClick={() =>
              setRoutes((list) => [
                ...list,
                {
                  reason: unused[0],
                  type: "strategy",
                  group: groups[0].id,
                  publicLabel: null,
                  nextUpdateDays: FOLLOW_UP_LIMITS.defaultNextUpdateDays,
                  dueDays: null,
                  memberVisible: true,
                },
              ])
            }
          >
            {r.addRule}
          </button>
        )}
        {editGroups && groupsChanged && (
          <label className={own.check}>
            <input
              type="checkbox"
              checked={confirmedGroups}
              disabled={busy}
              onChange={(event) => setConfirmedGroups(event.target.checked)}
            />
            {CONFIRM_GROUPS}
          </label>
        )}
        {(editGroups || editRoutes) && (
          <div>
            <button
              type="button"
              className="button"
              disabled={busy || !canSave}
              onClick={() => void save()}
            >
              {busy ? r.saving : r.save}
            </button>
          </div>
        )}
        {message && <p role="status">{message}</p>}
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </div>
    </Card>
  );
}
