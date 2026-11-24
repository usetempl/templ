"use client";

import { useRelease } from "@/lib/release-context";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  IconArrowRight,
  IconCode,
  IconInbox,
  IconSparkles,
} from "@tabler/icons-react";
import type { ChatPrincipalId, ChatVisibility } from "@templ/chat/principal";
import { DEFAULT_ACCENT } from "@templ/chat/appearance";
import { useChatAuth } from "@/lib/chat-auth";
import { isChatSignInCanceled } from "@/lib/chat-auth-cancellation";
import { rememberCreatedRoomFollow } from "@/lib/chat-subscriptions";
import { peekCommunitySession } from "@/lib/community-auth";
import { chatMutation } from "@/lib/chat-api";
import { roomPath } from "@/lib/community-client";
import { walletError } from "@/lib/wallet";
import { newChatMessageId } from "@/lib/chat-outbox";
import {
  createNativeRoom,
  isNativeRoomId,
  type NativeRoomDraft,
  type NativeRoomSetup,
} from "@/lib/native-room";
import { workspaceCreationEnabled } from "@/lib/release-public";
import { RESOLVED_CASES_DOCS } from "@/lib/product-offer";
import { PRODUCT_LIMITS } from "@templ/chat/plans";
import { DEFAULT_WALLET_IDENTIFICATION, readWalletIdentification, type WalletIdentification } from "@templ/chat/widget-wallet";
import { WalletIdentificationFields } from "./wallet-identification-fields";
import { TalkToTempl } from "./talk-to-templ";
import { trackEvent } from "@/lib/analytics";
import { copy as t } from "@/lib/copy";
import { Callout, Field, Spinner, ui } from "./ui/ui";
import { useActionToast } from "./action-toast";
import styles from "./native-chat-create.module.css";

const pendingKey = (account: string) =>
  `templ:native-room-create:${account.toLowerCase()}`;
/** Initial roles for a new support workspace. */
const SETUP: NativeRoomSetup = {
  roles: [],
};
const VISIBILITY: ChatVisibility = "public";
type CreationDraft = NativeRoomDraft & { walletIdentification?: WalletIdentification };

const NEXT_STEPS = [
  {
    icon: IconCode,
    title: "Open your team's chat",
    body: "Send a test question from your shareable link. You can add the widget to your site later.",
  },
  {
    icon: IconInbox,
    title: "Answer from your inbox",
    body: "Every case lands in one private inbox for your team.",
  },
];

export function NativeChatCreate({
  available: suppliedAvailable,
  showPlanAfterCreate = false,
}: {
  available?: boolean;
  showPlanAfterCreate?: boolean;
}) {
  const RELEASE = useRelease();
  const available = suppliedAvailable ?? workspaceCreationEnabled(RELEASE);

  const auth = useChatAuth();
  const { show, toast } = useActionToast();
  const account = auth.session?.principalId;
  const router = useRouter();
  const nameInput = useRef<HTMLInputElement>(null);
  const [hasName, setHasName] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<CreationDraft>();
  const [walletIdentification, setWalletIdentification] = useState(DEFAULT_WALLET_IDENTIFICATION);
  const [error, setError] = useState("");
  const [createdRoom, setCreatedRoom] = useState<string>();
  const inFlight = useRef(false);
  const lifetime = useRef(true);
  useEffect(() => {
    // A visitor can type into the server-rendered field before React starts.
    setHasName(Boolean(nameInput.current?.value.trim()));
  }, [pending?.id]);
  useEffect(() => {
    lifetime.current = true;
    return () => {
      lifetime.current = false;
    };
  }, []);
  useEffect(() => {
    setPending(undefined);
    setCreatedRoom(undefined);
    setError("");
    if (!account) return;
    try {
      const saved = JSON.parse(
        sessionStorage.getItem(pendingKey(account)) ?? "null",
      ) as CreationDraft | null;
      if (
        saved &&
        isNativeRoomId(saved.id) &&
        saved.expectedPrincipalId?.toLowerCase() === account.toLowerCase() &&
        saved.visibility === VISIBILITY &&
        typeof saved.name === "string" &&
        saved.name.length <= 80 &&
        Array.isArray(saved.setup?.roles) &&
        saved.setup.roles.length === 0 &&
        Object.keys(saved.setup).every((key) => key === "roles")
      ) {
        setPending(saved);
        setWalletIdentification(readWalletIdentification(saved.walletIdentification) ?? DEFAULT_WALLET_IDENTIFICATION);
      }
    } catch {
      /* A saved draft never authorizes creation on its own. */
    }
  }, [account]);
  function assertCurrent(account: ChatPrincipalId) {
    if (
      !lifetime.current ||
      peekCommunitySession()?.principalId.toLowerCase() !==
        account.toLowerCase()
    )
      throw new Error(t("shell.common.accountChanged"));
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!available) {
      show(t("shell.create.unavailable"));
      return;
    }
    const name = nameInput.current?.value.trim() ?? "";
    if (inFlight.current || (!pending && !name)) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    trackEvent("create_submitted");
    try {
      const { principalId: account } = await auth.signIn();
      assertCurrent(account);
      let draft = pending;
      if (!draft) {
        draft = {
          id: newChatMessageId(),
          name,
          setup: SETUP,
          expectedPrincipalId: account,
          visibility: VISIBILITY,
          accentColor: DEFAULT_ACCENT,
          walletIdentification,
        };
        // Keep the same intent after a lost response or page reload.
        try {
          sessionStorage.setItem(pendingKey(account), JSON.stringify(draft));
        } catch {
          /* The in-memory intent still supports retries in this tab. */
        }
        setPending(draft);
      }
      const { walletIdentification: choices = DEFAULT_WALLET_IDENTIFICATION, ...roomDraft } = draft;
      const room = await createNativeRoom(roomDraft);
      assertCurrent(account);
      setCreatedRoom(room.id);
      if (room.followed !== false) rememberCreatedRoomFollow(account, room);
      await chatMutation(account, roomPath(`room:${room.id}`, "widget"), {
        hostedPage: true,
        walletIdentification: choices,
        initializeOnly: true,
        confirmed: true,
      });
      assertCurrent(account);
      trackEvent("create_completed");
      try {
        sessionStorage.removeItem(pendingKey(account));
      } catch {
        /* Creation is already confirmed. */
      }
      router.push(`/inbox/${room.id}?tab=${showPlanAfterCreate ? "plan" : "home"}`);
    } catch (reason) {
      trackEvent("create_failed");
      if (lifetime.current && !isChatSignInCanceled(reason))
        setError(walletError(reason) || t("shell.create.failed"));
    } finally {
      inFlight.current = false;
      if (lifetime.current) setBusy(false);
    }
  }
  return (
    <div className={styles.page}>
      <section className={styles.main} aria-labelledby="create-title">
        <p className={styles.eyebrow}>
          <IconSparkles aria-hidden="true" /> New workspace
        </p>
        <h1 id="create-title">Create your team’s chat</h1>
        <p className={styles.lede}>
          Choose a team name to open your trial inbox and a support link.
          Anyone with the link can start a private conversation with your team.
        </p>
        {!available && (
          <div id="create-unavailable">
            <Callout role="status">{t("shell.create.unavailable")}</Callout>
          </div>
        )}
        <form onSubmit={(event) => void submit(event)} className={styles.form}>
          <Field
            label={t("shell.create.name")}
            hint="Visitors see it in your support chat. You can change it later."
          >
            <input
              className={`${ui.input} ${styles.nameInput}`}
              key={pending?.id ?? "new"}
              ref={nameInput}
              defaultValue={pending?.name ?? ""}
              disabled={busy || Boolean(pending)}
              onChange={(event) => setHasName(Boolean(event.currentTarget.value.trim()))}
              maxLength={80}
              required
              autoComplete="off"
              placeholder="Your protocol"
            />
          </Field>
          <WalletIdentificationFields value={walletIdentification} onChange={setWalletIdentification}
            disabled={!available || busy || !!pending} />
          {error && (
            <Callout tone="danger" role="alert">
              {error} {createdRoom && <a href={`/inbox/${createdRoom}?tab=home`}>Open your workspace</a>}
            </Callout>
          )}
          <button
            type="submit"
            className={`button large ${styles.submit}`}
            disabled={
              !available || busy || auth.restoring || (!pending && !hasName)
            }
            aria-disabled={!available || undefined}
            aria-describedby={!available ? "create-unavailable" : undefined}
            aria-busy={busy}
            onClick={(event) => {
              if (!available) {
                event.preventDefault();
                show(t("shell.create.unavailable"));
              }
            }}
          >
            {busy && <Spinner />}
            {busy
              ? t("shell.create.creating")
              : pending
                ? t("shell.create.retry")
                : "Create your chat"}
            {!busy && <IconArrowRight aria-hidden="true" />}
          </button>
          {!account && !auth.restoring && (
            <p className={styles.note}>
              You’ll sign in before creating your workspace.
            </p>
          )}
        </form>
        <p className={styles.terms}>
          Test {PRODUCT_LIMITS.freeSupportTickets} tickets free, with{" "}
          {PRODUCT_LIMITS.freeTeamRepliesPerTicket} team replies per ticket.
          Templ AI is off during free tests.{" "}
          <a href={RESOLVED_CASES_DOCS}>What counts as an answered case</a>
        </p>
        <TalkToTempl label="Chat with Templ">Chat with Templ</TalkToTempl>
      </section>
      <aside className={styles.next} aria-labelledby="create-next-title">
        <h2 id="create-next-title">After you create it</h2>
        <ol>
          {NEXT_STEPS.map(({ icon: Icon, title, body }, index) => (
            <li key={title}>
              <span className={styles.stepIcon}>
                <Icon aria-hidden="true" />
              </span>
              <div>
                <strong>
                  {index + 1}. {title}
                </strong>
                <p>{body}</p>
              </div>
            </li>
          ))}
        </ol>
      </aside>
      {toast}
    </div>
  );
}
