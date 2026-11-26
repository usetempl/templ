"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { UnsavedChanges } from "./unsaved-changes";
import { IconUserPlus } from "@tabler/icons-react";
import { canManageWorkspace } from "@templ/chat/moderation-permissions";
import { SUPPORT_TEAM_ROLES, standardTeamRole } from "@templ/chat/team-roles";
import type {
  ChatRole,
  ChatRoomId,
  ChatState,
  ModeratorPermission,
} from "@templ/chat/index";
import {
  normalizeChatPrincipal,
  type ChatPrincipalId,
} from "@templ/chat/principal";
import { isSolanaAddress } from "@templ/chat/solana";
import { chatMutation } from "@/lib/chat-api";
import { communityFetch, roomPath } from "@/lib/community-client";
import { memberLabel, useMemberProfiles } from "@/lib/member-profiles";
import { readAccountWallets } from "@/lib/wallet-links";
import { useDismissDialog } from "@/lib/use-dismiss-dialog";
import { SITE } from "@/lib/site-environment";
import {
  Badge,
  Callout,
  Card,
  CopyInline,
  Field,
  PageHeader,
  Skeleton,
  Spinner,
  ui,
} from "@/components/ui/ui";
import { Identicon } from "@/components/ui/identicon";
import type { WorkspaceContext } from "./support-workspace";
import { AI_AGENT_SECTION } from "./workspace-ai";
import styles from "./workspace.module.css";
import team from "./workspace-team.module.css";
import { WorkspaceTeamInvites } from "./workspace-team-invites";

/** `roleIds` are the roles the account holds; the worker lists them for
 * the manager. */
type Moderator = {
  wallet: string;
  permissions: string[];
  roleIds: string[];
  templStaff?: true;
};
export type TeamKind = "member" | "lead" | "admin" | "agent";
/** One known role per teammate. AI agents only read and answer. */
export const TEAM_ROLES: Record<
  TeamKind,
  { id: string; name: string; permissions: ModeratorPermission[] }
> = Object.fromEntries(
  Object.entries({
    member: "support-member",
    lead: "support-lead",
    admin: "support-admin",
    agent: "ai-agent",
  }).map(([kind, id]) => [
    kind,
    {
      id,
      name: SUPPORT_TEAM_ROLES[id as keyof typeof SUPPORT_TEAM_ROLES].name,
      permissions: [
        ...SUPPORT_TEAM_ROLES[id as keyof typeof SUPPORT_TEAM_ROLES]
          .permissions,
      ],
    },
  ]),
) as Record<
  TeamKind,
  { id: string; name: string; permissions: ModeratorPermission[] }
>;
/** Stored support-staff assignments stay until the owner changes them here. */
export const SUPPORT_STAFF_ROLE_ID = "support-staff";
const MANAGED_ROLE_IDS = [
  ...Object.values(TEAM_ROLES).map((role) => role.id),
  SUPPORT_STAFF_ROLE_ID,
];
/** The label replies from a registered AI agent carry. Bot names follow the
 * display-name rules, which reserve words such as "support" and "team". */
const AGENT_NAME = "AI agent";
/** The AI label is stored by account ID, which a Solana address doesn't give
 * the page. */
const AGENT_BY_ID =
  "Add an AI agent by account ID or a wallet it signed in with.";

const MATRIX: {
  label: string;
  roles: [boolean, boolean, boolean, boolean, boolean];
}[] = [
  { label: "Read and answer cases", roles: [true, true, true, true, true] },
  {
    label: "Add tags and internal notes",
    roles: [true, true, true, true, true],
  },
  {
    label: "Ask a user to verify their wallet",
    roles: [true, true, true, true, true],
  },
  { label: "Download a case", roles: [true, true, true, true, true] },
  { label: "Assign cases to others", roles: [true, true, true, false, false] },
  {
    label: "Edit saved replies and read reports",
    roles: [true, true, true, false, false],
  },
  {
    label: "Take over a claimed case",
    roles: [true, false, false, false, false],
  },
  {
    label: "Change workspace settings and manage team access",
    roles: [true, true, false, false, false],
  },
];

/** The workspace's roles as the worker has them now. The page's copy of the
 * workspace state can predate a role this page just created. */
async function readRoles(room: ChatRoomId, signal?: AbortSignal) {
  const state = await communityFetch<ChatState>(
    roomPath(room, "channels"),
    undefined,
    signal,
  );
  return state.roles;
}
/** Manual roles that let someone read chats. Removing access ends each. */
const supportRolesOf = (roles: readonly ChatRole[]) =>
  roles.filter(
    (role) =>
      role.mode === "manual" &&
      role.moderationPermissions?.includes("handleConversations"),
  );
const samePermissions = (
  held: readonly string[] | undefined,
  wanted: readonly string[],
) =>
  (held ?? []).length === wanted.length &&
  wanted.every((permission) => held?.includes(permission));

export function WorkspaceTeam({ context }: { context: WorkspaceContext }) {
  const { room, account, state, workspace } = context;
  const canAdmin = canManageWorkspace(
    state.viewer,
    state.bots?.some((bot) => bot.principalId === account),
  );
  const [loaded, setLoaded] = useState<{
    key: string;
    moderators?: Moderator[];
    bots?: string[];
    /** Who holds the AI support role, by lowercase id. */
    agents?: Set<string>;
    /** The wallets the signed-in account proved. */
    ownWallets?: string[];
    error?: string;
  }>();
  const [refresh, setRefresh] = useState(0);
  const key = `${room}:${account}:${context.revision}:${refresh}`;
  const current = loaded?.key === key ? loaded : undefined;
  // The workspace's roles are already on the page; only the list of who
  // holds them and the AI labels are read here.
  const agentRoleMode = state.roles.find(
    (role) => role.id === TEAM_ROLES.agent.id,
  )?.mode;
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const signedIn = normalizeChatPrincipal(account);
        const [data, registered, ownWallets] = await Promise.all([
          communityFetch<{ moderators: Moderator[] }>(
            roomPath(room, "moderation"),
            undefined,
            controller.signal,
          ),
          communityFetch<{ bots: { principalId: string }[] }>(
            roomPath(room, "bots"),
            undefined,
            controller.signal,
          ).catch(() => ({ bots: [] })),
          signedIn
            ? readAccountWallets(signedIn, controller.signal)
                .then(({ wallets }) => wallets.map((wallet) => wallet.address))
                .catch(() => [])
            : [],
        ]);
        const staffEntries = data.moderators.filter((entry) =>
          entry.permissions.includes("handleConversations"),
        );
        const agents = new Set<string>();
        // A role this page made is manual. The page's copy of the roles can
        // predate one made here a moment ago, so a missing role still counts.
        if (agentRoleMode === undefined || agentRoleMode === "manual")
          for (const entry of staffEntries)
            if (
              Array.isArray(entry.roleIds) &&
              entry.roleIds.includes(TEAM_ROLES.agent.id)
            )
              agents.add(entry.wallet.toLowerCase());
        if (!controller.signal.aborted)
          setLoaded({
            key,
            moderators: data.moderators,
            bots: registered.bots.map((bot) => bot.principalId.toLowerCase()),
            agents,
            ownWallets,
          });
      } catch (reason) {
        if (!controller.signal.aborted)
          setLoaded({
            key,
            error:
              reason instanceof Error
                ? reason.message
                : "The team could not load.",
          });
      }
    })();
    return () => controller.abort();
  }, [room, key, account, agentRoleMode]);
  const staff = (current?.moderators ?? []).filter((entry) =>
    entry.permissions.includes("handleConversations"),
  );
  const staffIds = new Set(
    staff.map((entry) => normalizeChatPrincipal(entry.wallet)?.toLowerCase()),
  );
  /** The Owner's account and, for the signed-in Owner, the wallets it proved.
   * A person, so it never carries the AI label. */
  const ownerIds = new Set(
    [
      workspace.manager,
      ...(state.viewer.isManager
        ? [
            account,
            state.viewer.principalId,
            state.viewer.wallet,
            ...(current?.ownWallets ?? []),
          ]
        : []),
    ]
      .map((id) => normalizeChatPrincipal(id)?.toLowerCase())
      .filter((id): id is string => Boolean(id)),
  );
  const isOwner = (id: string) => ownerIds.has(id.toLowerCase());
  const visibleStaff = staff.filter((entry) => {
    const id = normalizeChatPrincipal(entry.wallet);
    return id !== null && !isOwner(id);
  });
  /** Owner ids that currently carry the AI label. */
  const labeledOwner = (current?.bots ?? []).filter(isOwner);
  /** Registered agents without case access. */
  const unattached = (current?.bots ?? [])
    .map((id) => normalizeChatPrincipal(id))
    .filter(
      (id): id is ChatPrincipalId =>
        Boolean(id) && !staffIds.has(id!.toLowerCase()) && !isOwner(id!),
    );
  const ids = [
    workspace.manager,
    ...staff
      .map((entry) => normalizeChatPrincipal(entry.wallet))
      .filter((id): id is ChatPrincipalId => Boolean(id)),
    ...unattached,
  ];
  const profiles = useMemberProfiles(ids);

  const [principal, setPrincipal] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [agent, setAgent] = useState(false);
  const [lead, setLead] = useState(false);
  const [admin, setAdmin] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  /** The result of a change made from the list, shown under it. */
  const [listStatus, setListStatus] = useState<{
    alert: boolean;
    text: string;
  } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [changingRole, setChangingRole] = useState<{
    id: ChatPrincipalId;
    kind: TeamKind;
  } | null>(null);
  const [templConfirm, setTemplConfirm] = useState<{
    resolve(confirmed: boolean): void;
  } | null>(null);
  const templDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = templDialog.current;
    if (templConfirm) dialog?.showModal();
    return () => dialog?.close();
  }, [templConfirm]);
  const confirmTemplPerson = () =>
    new Promise<boolean>((resolve) => {
      setTemplConfirm({ resolve });
    });
  const answerTemplConfirm = (confirmed: boolean) => {
    templConfirm?.resolve(confirmed);
    setTemplConfirm(null);
  };
  const dismissTempl = useDismissDialog(() => answerTemplConfirm(false));
  const inFlight = useRef(false);
  const entered = principal.trim();
  // A Solana wallet goes to the worker as typed. The worker finds the
  // account that proved it inside the grant; the page never looks a wallet
  // up.
  const solanaTarget = isSolanaAddress(entered) ? entered : null;
  const valid: string | null = normalizeChatPrincipal(entered) ?? solanaTarget;
  // The AI label needs an account ID or a 0x address, so a Solana address
  // always adds a person.
  const asAgent = agent && !solanaTarget;

  /** Saves or removes the AI label, then reads the list back so the page
   * never reports a label the worker did not store. */
  async function saveAgentLabel(target: ChatPrincipalId, labeled: boolean) {
    await chatMutation(
      account as never,
      roomPath(
        room,
        labeled ? "bots" : `bots/${encodeURIComponent(target)}/remove`,
      ),
      labeled
        ? { principalId: target, displayName: AGENT_NAME, confirmed: true }
        : { confirmed: true },
    ).catch((reason: unknown) => {
      // Already labeled (409) or already unlabeled (404): the read-back decides.
      if ((reason as { status?: number }).status !== (labeled ? 409 : 404))
        throw reason;
    });
    const { bots } = await communityFetch<{
      bots: { principalId: string }[];
    }>(roomPath(room, "bots"));
    if (
      bots.some(
        (bot) => bot.principalId.toLowerCase() === target.toLowerCase(),
      ) !== labeled
    )
      throw new Error(
        labeled
          ? "The AI label wasn’t saved. Try again."
          : "The AI label is still there. Try again.",
      );
  }

  /** The support roles this account holds now, asked of the worker. */
  async function heldRoles(target: ChatPrincipalId, roles: ChatRole[]) {
    const held: string[] = [];
    for (const role of roles) {
      const grant = await communityFetch<{ manual: boolean }>(
        roomPath(
          room,
          `roles/${role.id}/grant?principalId=${encodeURIComponent(target)}`,
        ),
      );
      if (grant.manual) held.push(role.id);
    }
    return held;
  }

  async function assign(
    roleId: string,
    target: ChatPrincipalId,
    granted: boolean,
    templStaffConfirmed = false,
  ) {
    await chatMutation(
      account as never,
      roomPath(room, `roles/${roleId}/assign`),
      {
        principalId: target,
        granted,
        confirmed: true,
        ...(templStaffConfirmed ? { templStaffConfirmed: true } : {}),
      },
    );
  }

  /** Grants a role to the account that proved a Solana wallet. The worker
   * finds that account inside the grant, refuses a wallet no account proved,
   * and answers with the account ID the team list shows. */
  async function grantToSolanaWallet(roleId: string, wallet: string) {
    const grant = (templStaffConfirmed = false) =>
      chatMutation<{ principalId?: unknown }>(
        account as never,
        roomPath(room, `roles/${roleId}/assign`),
        {
          principalId: wallet,
          granted: true,
          confirmed: true,
          ...(templStaffConfirmed ? { templStaffConfirmed: true } : {}),
        },
      );
    let result;
    try {
      result = await grant();
    } catch (reason) {
      if (
        (reason as { details?: { reason?: string } })?.details?.reason !==
        "templ-staff-confirmation"
      )
        throw reason;
      if (!(await confirmTemplPerson()))
        throw new Error("Team access did not change.");
      result = await grant(true);
    }
    return normalizeChatPrincipal(result?.principalId);
  }

  /** Creates the kind's role the first time, and refuses to use one whose
   * powers were changed elsewhere. */
  async function ensureRole(kind: TeamKind, roles: readonly ChatRole[]) {
    const wanted = TEAM_ROLES[kind];
    const existing = roles.find((role) => role.id === wanted.id);
    if (!existing) {
      await chatMutation(account as never, roomPath(room, "roles"), {
        id: wanted.id,
        name: wanted.name,
        mode: "manual",
        moderationPermissions: wanted.permissions,
        confirmed: true,
      });
      return;
    }
    if (
      existing.mode !== "manual" ||
      existing.enabled === false ||
      !samePermissions(existing.moderationPermissions, wanted.permissions)
    )
      throw new Error(
        `The “${existing.name}” role doesn’t match what this page expects, so access didn’t change. Ask Templ for help.`,
      );
  }

  /** The account's current powers in this workspace, read back after a
   * change. Null when the list shows it under another id. */
  async function powersOf(target: ChatPrincipalId) {
    const { moderators } = await communityFetch<{ moderators: Moderator[] }>(
      roomPath(room, "moderation"),
    );
    const entry = moderators.find(
      (item) => item.wallet.toLowerCase() === target.toLowerCase(),
    );
    return entry ? entry.permissions : null;
  }

  /** Whether the worker has the AI label on this account now. */
  async function labeledNow(target: ChatPrincipalId) {
    const { bots } = await communityFetch<{
      bots: { principalId: string }[];
    }>(roomPath(room, "bots"));
    return bots.some(
      (bot) => bot.principalId.toLowerCase() === target.toLowerCase(),
    );
  }

  /** Gives the account one known role. An AI agent gets its
   * label before its access, so it never answers without it; a person never
   * keeps the label. Returns a warning when another role still adds powers.
   * The target is an account ID, a 0x address or a Solana wallet. */
  async function setKind(
    target: string,
    kind: TeamKind,
  ): Promise<string | null> {
    const owner =
      kind === "agent"
        ? "That’s the Owner’s account. A person can’t be labeled an AI agent."
        : "That’s the Owner’s account. The Owner already has every power.";
    let id = normalizeChatPrincipal(target);
    if (id && isOwner(id)) throw new Error(owner);
    if (!id && kind === "agent") throw new Error(AGENT_BY_ID);
    let templStaffConfirmed = false;
    if (id && kind !== "agent") {
      const grant = await communityFetch<{ templStaff?: true }>(
        roomPath(
          room,
          `roles/${TEAM_ROLES[kind].id}/grant?principalId=${encodeURIComponent(target)}`,
        ),
      );
      if (grant.templStaff) {
        templStaffConfirmed = await confirmTemplPerson();
        if (!templStaffConfirmed)
          throw new Error("Team access did not change.");
      }
    }
    const roles = await readRoles(room);
    const managed = roles.filter((role) => MANAGED_ROLE_IDS.includes(role.id));
    let labeled: boolean;
    let held: string[];
    if (id) {
      const currentHeld = state.viewer.isManager
        ? null
        : await heldRoles(id, roles);
      if (
        currentHeld?.some(
          (roleId) =>
            !standardTeamRole(roles.find((role) => role.id === roleId)!),
        )
      )
        throw new Error("Ask the owner to change this person's custom roles.");
      // Asked of the worker before any change, not of the page's list,
      // which can be reloading or missing.
      labeled = kind === "agent" ? false : await labeledNow(id);
      await ensureRole(kind, roles);
      held =
        currentHeld?.filter((roleId) => MANAGED_ROLE_IDS.includes(roleId)) ??
        (await heldRoles(id, managed));
      if (kind === "agent")
        await saveAgentLabel(id, true).catch((reason: unknown) => {
          // The worker's own reason when it gave one; the read-back's otherwise.
          const detail =
            reason instanceof Error &&
            reason.message &&
            !reason.message.startsWith("The AI label")
              ? reason.message
              : "Try again.";
          throw new Error(
            `No access was given, because the AI label wasn’t saved. ${detail}`,
          );
        });
      await assign(TEAM_ROLES[kind].id, id, true, templStaffConfirmed);
    } else {
      // A Solana wallet: the grant comes first, and the rest of the change
      // uses the account ID the worker answers with.
      await ensureRole(kind, roles);
      id = await grantToSolanaWallet(TEAM_ROLES[kind].id, target);
      if (!id) return null;
      if (isOwner(id)) {
        await assign(TEAM_ROLES[kind].id, id, false);
        throw new Error(owner);
      }
      labeled = await labeledNow(id);
      held = await heldRoles(id, managed);
    }
    for (const roleId of held)
      if (roleId !== TEAM_ROLES[kind].id) await assign(roleId, id, false);
    if (labeled) await saveAgentLabel(id, false);
    const powers = await powersOf(id);
    if (!powers) return null;
    const extra = powers.filter(
      (permission) =>
        !TEAM_ROLES[kind].permissions.includes(permission as never),
    );
    return extra.length
      ? "Saved, but another role still gives this account more powers. Ask Templ for help."
      : null;
  }

  /** Runs one change with the shared busy state, then reloads the list. */
  async function run(
    marker: string,
    work: () => Promise<{ text: string; warning?: string | null }>,
    report: (status: { alert: boolean; text: string }) => void,
  ) {
    if (inFlight.current || !canAdmin) return false;
    inFlight.current = true;
    setBusy(marker);
    setError("");
    setNotice("");
    setListStatus(null);
    try {
      const result = await work();
      report(
        result.warning
          ? { alert: true, text: result.warning }
          : { alert: false, text: result.text },
      );
      return true;
    } catch (reason) {
      report({
        alert: true,
        text:
          reason instanceof Error
            ? reason.message
            : "Team access could not change.",
      });
      return false;
    } finally {
      // The list reads roles, access and labels back from the worker.
      setRefresh((value) => value + 1);
      inFlight.current = false;
      setBusy(null);
    }
  }
  const toList = (status: { alert: boolean; text: string }) =>
    setListStatus(status);
  const toForm = (status: { alert: boolean; text: string }) =>
    status.alert ? setError(status.text) : setNotice(status.text);

  async function add(target: string) {
    const kind: TeamKind = asAgent
      ? "agent"
      : admin
        ? "admin"
        : lead
          ? "lead"
          : "member";
    const added = await run(
      target,
      async () => ({
        warning: await setKind(target, kind),
        text:
          kind === "agent"
            ? "AI agent added. It can read and answer cases, and users see “AI agent” on its replies."
            : kind === "admin"
              ? "Admin added."
              : kind === "lead"
                ? "Support lead added."
                : "Teammate added.",
      }),
      toForm,
    );
    if (added) {
      setConfirmed(false);
      setAgent(false);
      setLead(false);
      setAdmin(false);
      setPrincipal("");
    }
  }

  /** Ends every support role the account holds. For an AI agent, the label
   * goes too, after the access. */
  async function remove(target: ChatPrincipalId, labeled: boolean) {
    await run(
      `remove:${target}`,
      async () => {
        const held = await heldRoles(
          target,
          supportRolesOf(await readRoles(room)),
        );
        if (!held.length && !labeled)
          throw new Error(
            "This account’s access comes from a role this page doesn’t manage. Ask Templ for help.",
          );
        for (const id of held) await assign(id, target, false);
        if ((await powersOf(target))?.includes("handleConversations"))
          throw new Error("This account can still read cases. Try again.");
        if (labeled) {
          const failure = await saveAgentLabel(target, false).then(
            () => null,
            (reason: unknown) =>
              reason instanceof Error ? reason.message : "",
          );
          if (failure !== null)
            throw new Error(
              `Access removed, but the AI label is still there. ${failure} Choose “Remove agent” again.`,
            );
          return { text: "Agent removed. It can’t read or answer cases now." };
        }
        return { text: "Access removed." };
      },
      toList,
    );
    setRemoving(null);
  }

  const workspaceLink = `${SITE.origin}/inbox/${context.id}`;
  const rowActions = (
    id: ChatPrincipalId,
    confirmLabel: string,
    labeled: boolean,
  ) =>
    changingRole?.id === id ? (
      <div className={styles.stack}>
        <p>
          Change this account to{" "}
          {changingRole.kind === "admin"
            ? "Admin"
            : changingRole.kind === "lead"
              ? "Support lead"
              : "Team"}
          ?
        </p>
        <p className={styles.muted}>
          {changingRole.kind === "admin"
            ? "Admins can change settings, AI sources and team access."
            : changingRole.kind === "lead"
              ? "Support leads can assign cases, edit saved replies and read reports."
              : "Team members can read and answer cases."}
        </p>
        <div className={styles.row}>
          <button
            type="button"
            className="button small"
            disabled={busy !== null}
            onClick={() =>
              void run(
                `role:${id}`,
                async () => {
                  const warning = await setKind(id, changingRole.kind);
                  setChangingRole(null);
                  return { warning, text: "Team role updated." };
                },
                toList,
              )
            }
          >
            {busy === `role:${id}` && <Spinner />}Confirm role
          </button>
          <button
            type="button"
            className="button small secondary"
            disabled={busy !== null}
            onClick={() => setChangingRole(null)}
          >
            Keep role
          </button>
        </div>
      </div>
    ) : removing === id ? (
      <span className={styles.row}>
        <button
          type="button"
          className="button small destructive"
          disabled={busy !== null}
          onClick={() => void remove(id, labeled)}
        >
          {busy === `remove:${id}` && <Spinner />}
          {confirmLabel}
        </button>
        <button
          type="button"
          className="button small quiet"
          onClick={() => setRemoving(null)}
        >
          Keep
        </button>
      </span>
    ) : null;

  return (
    <div data-workspace-settings="" className={`${styles.page} ${styles.pageNarrow}`}>
      <UnsavedChanges dirty={Boolean(principal.trim())} />
      <PageHeader
        eyebrow="Team"
        title="Who answers support"
        description="People and AI agents you add can read and answer cases. Admins manage team access."
      />
      {templConfirm && (
        <dialog
          ref={templDialog}
          className={team.confirm}
          aria-labelledby="templ-person-title"
          {...dismissTempl}
        >
          <h2 id="templ-person-title">Give Templ access</h2>
          <p>
            This person works at Templ. They can read and answer every case this
            role allows.
          </p>
          <div className={styles.row}>
            <button
              type="button"
              className="button"
              onClick={() => answerTemplConfirm(true)}
            >
              Give access
            </button>
            <button
              type="button"
              className="button quiet"
              onClick={() => answerTemplConfirm(false)}
            >
              Cancel
            </button>
          </div>
        </dialog>
      )}
      <div className={`${styles.stack} ${team.stack}`}>
        {state.features?.teamInvites === true && canAdmin && (
          <WorkspaceTeamInvites
            key={`${room}:${account}`}
            context={context}
            prepareRole={async (roleId) => {
              await ensureRole(
                roleId === "support-admin"
                  ? "admin"
                  : roleId === "support-lead"
                    ? "lead"
                    : "member",
                await readRoles(room),
              );
            }}
          />
        )}
        <Card
          title="Team"
          description={
            current?.moderators
              ? `${visibleStaff.length + 1} ${visibleStaff.length ? "accounts" : "account"} with access to cases`
              : undefined
          }
        >
          {!current ? (
            <div className={styles.stack} style={{ gap: 12 }}>
              <Skeleton height={44} />
              <Skeleton height={44} />
            </div>
          ) : current.error ? (
            <p className={styles.error} role="alert">
              {current.error}
            </p>
          ) : (
            <ul className={styles.memberList}>
              <MemberRow
                id={workspace.manager}
                name={memberLabel(
                  profiles.get(workspace.manager.toLowerCase()),
                  workspace.manager,
                )}
                profile={profiles.get(workspace.manager.toLowerCase())}
                you={workspace.manager === account}
                badges={
                  <>
                    <Badge tone="brand">Owner</Badge>
                    {labeledOwner.length > 0 && (
                      <Badge tone="warning">{AGENT_NAME}</Badge>
                    )}
                  </>
                }
                warning={
                  labeledOwner.length > 0 && (
                    <Callout tone="warning" className={styles.roleWarning}>
                      Users see “AI agent” on the Owner’s replies.{" "}
                      <button
                        type="button"
                        className="button small"
                        disabled={busy !== null}
                        onClick={() =>
                          void run(
                            "fix:owner",
                            async () => {
                              for (const id of labeledOwner)
                                await saveAgentLabel(
                                  normalizeChatPrincipal(id)!,
                                  false,
                                );
                              return { text: "AI label removed." };
                            },
                            toList,
                          )
                        }
                      >
                        {busy === "fix:owner" && <Spinner />}
                        Remove the AI label
                      </button>
                    </Callout>
                  )
                }
              />
              {visibleStaff.map((entry) => {
                const id = normalizeChatPrincipal(entry.wallet);
                if (!id || isOwner(id)) return null;
                const profile = profiles.get(id.toLowerCase());
                const labeled =
                  current.bots?.includes(id.toLowerCase()) ?? false;
                const inAgentRole =
                  current.agents?.has(id.toLowerCase()) ?? false;
                const isLead = entry.permissions.includes("manageSupport");
                const isAdmin = entry.permissions.includes("manageWorkspace");
                const extra = entry.permissions.some(
                  (permission) => permission !== "handleConversations",
                );
                const isAgent = labeled || inAgentRole;
                const warning = !isAgent
                  ? null
                  : !labeled
                    ? {
                        text: `This account has the ${TEAM_ROLES.agent.name} role, but its replies don’t say “AI agent” yet.`,
                        action: "Add the AI label",
                        run: () =>
                          run(
                            `fix:${id}`,
                            async () => {
                              await saveAgentLabel(id, true);
                              return {
                                text: "Labeled. Users see “AI agent” on its replies.",
                              };
                            },
                            toList,
                          ),
                      }
                    : !inAgentRole || extra
                      ? {
                          text: extra
                            ? isLead
                              ? "This agent can also assign cases to others and edit saved replies."
                              : "This agent can do more than read and answer cases."
                            : `This agent isn’t in the ${TEAM_ROLES.agent.name} role yet.`,
                          action: `Move to the ${TEAM_ROLES.agent.name} role`,
                          run: () =>
                            run(
                              `fix:${id}`,
                              async () => ({
                                warning: await setKind(id, "agent"),
                                text: "Moved. The agent can read and answer cases, and nothing more.",
                              }),
                              toList,
                            ),
                        }
                      : null;
                return (
                  <MemberRow
                    key={id}
                    id={id}
                    name={memberLabel(profile, id)}
                    profile={profile}
                    you={id === account}
                    link={
                      isAgent && (
                        <a
                          className={styles.inlineLink}
                          href={`?tab=knowledge#${AI_AGENT_SECTION}`}
                          onClick={(event) => {
                            event.preventDefault();
                            context.go("knowledge", null, AI_AGENT_SECTION);
                          }}
                        >
                          Choose how AI works on new cases
                        </a>
                      )
                    }
                    badges={
                      <>
                        {isAgent ? (
                          <Badge tone="info">{AGENT_NAME}</Badge>
                        ) : (
                          <Badge>
                            {isAdmin
                              ? "Admin"
                              : isLead
                                ? "Support lead"
                                : "Team"}
                          </Badge>
                        )}
                        {entry.templStaff && <Badge>Templ</Badge>}
                        {isAgent && isLead && (
                          <Badge tone="warning">Lead powers</Badge>
                        )}
                        {entry.permissions.includes("messageMembers") && (
                          <Badge>Can message users</Badge>
                        )}
                      </>
                    }
                    action={
                      rowActions(
                        id,
                        isAgent ? "Remove agent" : "Remove access",
                        labeled,
                      ) ?? (
                        <span className={styles.row}>
                          {!isAgent && !isAdmin && (
                            <button
                              type="button"
                              className="button small quiet"
                              disabled={busy !== null}
                              onClick={() =>
                                setChangingRole({
                                  id,
                                  kind: isLead ? "member" : "lead",
                                })
                              }
                            >
                              {busy === `lead:${id}` && <Spinner />}
                              {isLead
                                ? "Remove lead powers"
                                : "Make support lead"}
                            </button>
                          )}
                          {!isAgent && (
                            <button
                              type="button"
                              className="button small quiet"
                              disabled={busy !== null}
                              onClick={() =>
                                setChangingRole({
                                  id,
                                  kind: isAdmin ? "lead" : "admin",
                                })
                              }
                            >
                              {busy === `admin:${id}` && <Spinner />}
                              {isAdmin ? "Make support lead" : "Make admin"}
                            </button>
                          )}
                          <button
                            type="button"
                            className="button small quiet"
                            disabled={busy !== null}
                            onClick={() => setRemoving(id)}
                          >
                            {isAgent ? "Remove agent" : "Remove"}
                          </button>
                        </span>
                      )
                    }
                    warning={
                      warning && (
                        <Callout tone="warning" className={styles.roleWarning}>
                          {warning.text}{" "}
                          <button
                            type="button"
                            className="button small"
                            disabled={busy !== null}
                            onClick={() => void warning.run()}
                          >
                            {busy === `fix:${id}` && <Spinner />}
                            {warning.action}
                          </button>
                        </Callout>
                      )
                    }
                  />
                );
              })}
              {unattached.map((id) => {
                const profile = profiles.get(id.toLowerCase());
                return (
                  <MemberRow
                    key={id}
                    id={id}
                    name={memberLabel(profile, id)}
                    profile={profile}
                    you={id === account}
                    badges={
                      <>
                        <Badge tone="info">{AGENT_NAME}</Badge>
                        <Badge>No access</Badge>
                      </>
                    }
                    action={
                      rowActions(id, "Remove agent", true) ?? (
                        <button
                          type="button"
                          className="button small quiet"
                          disabled={busy !== null}
                          onClick={() => setRemoving(id)}
                        >
                          Remove agent
                        </button>
                      )
                    }
                  />
                );
              })}
            </ul>
          )}
          {listStatus && (
            <p
              className={listStatus.alert ? styles.error : styles.status}
              role={listStatus.alert ? "alert" : "status"}
              style={{ marginTop: 12 }}
            >
              {listStatus.text}
            </p>
          )}
          {!current?.error && current && staff.length === 0 && (
            <p className={styles.muted} style={{ marginTop: 6 }}>
              Only you have access. Add a teammate below.
            </p>
          )}
        </Card>

        <Card
          title="Add a teammate"
          description="Ask your teammate to sign in to Templ and send you the account ID from their account menu. A 0x or Solana wallet they signed in with works too."
          footer={
            <>
              <div className={styles.stack} style={{ gap: 8 }}>
                <Field label="Team role">
                  <select
                    className={ui.input}
                    value={
                      asAgent
                        ? "agent"
                        : admin
                          ? "admin"
                          : lead
                            ? "lead"
                            : "member"
                    }
                    disabled={busy !== null}
                    onChange={(event) => {
                      setAgent(event.target.value === "agent");
                      setAdmin(event.target.value === "admin");
                      setLead(event.target.value === "lead");
                      setConfirmed(false);
                    }}
                  >
                    <option value="member">Team</option>
                    <option value="lead">Support lead</option>
                    <option value="admin">Admin</option>
                    <option value="agent" disabled={Boolean(solanaTarget)}>
                      AI agent
                    </option>
                  </select>
                </Field>
                <p className={styles.muted}>
                  {asAgent
                    ? "AI agents can read and answer cases. Users see the AI agent label."
                    : admin
                      ? "Admins manage settings, AI sources and team access."
                      : lead
                        ? "Support leads assign cases, edit saved replies and read reports."
                        : "Team members can read and answer cases."}
                </p>
                {solanaTarget && <p className={styles.muted}>{AGENT_BY_ID}</p>}
                <label className={ui.check}>
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(event) => setConfirmed(event.target.checked)}
                    disabled={!valid}
                  />
                  I checked this account. It can read and answer this
                  workspace’s private cases.
                </label>
              </div>
              <button
                type="button"
                className="button"
                disabled={!valid || !confirmed || busy !== null}
                onClick={() => valid && void add(valid)}
              >
                {busy && busy === valid ? (
                  <Spinner />
                ) : (
                  <IconUserPlus aria-hidden="true" />
                )}
                Give access
              </button>
            </>
          }
        >
          <Field
            label="Account ID or wallet"
            hint={
              entered && !valid
                ? undefined
                : "Example: account:0199…, 0x71…a42f or a Solana wallet"
            }
            error={
              entered && !valid
                ? "That isn’t an account ID, EVM wallet or Solana wallet."
                : undefined
            }
          >
            <input
              className={`${ui.input} ${ui.mono}`}
              value={principal}
              onChange={(event) => {
                // The confirmation covers one account; the role choices stay.
                setPrincipal(event.target.value);
                setConfirmed(false);
              }}
              placeholder="account:…, 0x… or Solana wallet"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          {notice && (
            <p
              className={styles.status}
              role="status"
              style={{ marginTop: 12 }}
            >
              {notice}
            </p>
          )}
          {error && (
            <p className={styles.error} role="alert" style={{ marginTop: 12 }}>
              {error}
            </p>
          )}
        </Card>

        <Card title="What each role can do">
          <div className={styles.matrixScroll}>
            <table className={styles.matrix}>
              <thead>
                <tr>
                  <th scope="col">
                    <span className="visually-hidden">Action</span>
                  </th>
                  <th scope="col">Owner</th>
                  <th scope="col">Admin</th>
                  <th scope="col">Support lead</th>
                  <th scope="col">Team</th>
                  <th scope="col">AI agent</th>
                </tr>
              </thead>
              <tbody>
                {MATRIX.map((row) => (
                  <tr key={row.label}>
                    <th scope="row">{row.label}</th>
                    {row.roles.map((allowed, index) => (
                      <td key={index} data-allowed={allowed}>
                        <span aria-hidden="true">{allowed ? "✓" : "–"}</span>
                        <span className="visually-hidden">
                          {allowed ? "Yes" : "No"}
                        </span>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className={styles.muted}>
            Admins manage the workspace and team. Only owners manage billing and
            ownership.
          </p>
        </Card>

        <Card
          title="Workspace link"
          description="Send this to teammates after you give them access. Opening it adds the workspace to their list."
        >
          <CopyInline value={workspaceLink} label="Copy link" />
        </Card>

        <Callout className={team.accountNote}>
          Your own account ID is <code>{account}</code>. Paying for Templ or
          having a display name doesn’t let anyone read cases. Removing someone
          ends their access right away, even to cases assigned to them.
        </Callout>
      </div>
    </div>
  );
}

function MemberRow({
  id,
  name,
  profile,
  you,
  badges,
  action,
  warning,
  link,
}: {
  id: string;
  name: string;
  profile?: Parameters<typeof Identicon>[0]["profile"];
  you: boolean;
  badges: ReactNode;
  action?: ReactNode;
  warning?: ReactNode;
  /** A link under the account, such as an AI agent's settings. */
  link?: ReactNode;
}) {
  return (
    <li className={styles.memberRow}>
      <Identicon seed={id} profile={profile} size={38} radius={12} />
      <div>
        <strong>
          {name}
          {you && " (you)"}
        </strong>
        <small title={id}>{id}</small>
        {link && <div>{link}</div>}
        {warning}
      </div>
      <div className={styles.badges}>{badges}</div>
      {action}
    </li>
  );
}
