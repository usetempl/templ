"use client";

import { useRelease } from "@/lib/release-context";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";
import { useRouter } from "next/navigation";
import { IconArrowRight } from "@tabler/icons-react";
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
import { PRODUCT_LIMITS } from "@templ/chat/plans";
import {
  DEFAULT_WALLET_IDENTIFICATION,
  readWalletIdentification,
  type WalletIdentification,
} from "@templ/chat/widget-wallet";
import { OnboardingWalletFields } from "./wallet-identification-fields";
import { trackEvent } from "@/lib/analytics";
import { copy as t } from "@/lib/copy";
import { Callout, Field, ui } from "./ui/ui";
import { useActionToast } from "./action-toast";
import styles from "./native-chat-create.module.css";

const pendingKey = (account: string) =>
  `templ:native-room-create:${account.toLowerCase()}`;
/** Initial roles for a new support workspace. */
const SETUP: NativeRoomSetup = {
  roles: [],
};
const VISIBILITY: ChatVisibility = "public";
type CreationDraft = NativeRoomDraft & {
  walletIdentification?: WalletIdentification;
};

const NEW_WORKSPACE_WALLETS: WalletIdentification = {
  enabled: false,
  evm: true,
  solana: true,
};

function savedDraft(account?: string) {
  if (!account) return null;
  try {
    return sessionStorage.getItem(pendingKey(account));
  } catch {
    return null;
  }
}
function parseDraft(
  raw: string | null,
  account?: string,
): CreationDraft | undefined {
  if (!raw || !account) return;
  try {
    const draft: CreationDraft = JSON.parse(raw);
    if (
      draft &&
      isNativeRoomId(draft.id) &&
      draft.expectedPrincipalId?.toLowerCase() === account.toLowerCase() &&
      draft.visibility === VISIBILITY &&
      typeof draft.name === "string" &&
      draft.name.length <= 80 &&
      Array.isArray(draft.setup?.roles) &&
      draft.setup.roles.length === 0 &&
      Object.keys(draft.setup).every((key) => key === "roles")
    )
      return draft;
  } catch {
    /* Ignore incomplete saved drafts. */
  }
}
function subscribeDraft(onChange: () => void) {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}
const noSavedDraft = () => null;

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
  const [activeDraft, setPending] = useState<CreationDraft>();
  const stored = useSyncExternalStore(
    subscribeDraft,
    () => savedDraft(account),
    noSavedDraft,
  );
  const restored = useMemo(
    () => parseDraft(stored, account),
    [stored, account],
  );
  const pending =
    activeDraft && activeDraft.expectedPrincipalId === account
      ? activeDraft
      : restored;
  const [error, setError] = useState("");
  const [createdRoom, setCreatedRoom] = useState<string>();
  const inFlight = useRef(false);
  const lifetime = useRef(true);
  const [draftOwner, setDraftOwner] = useState(account);
  if (draftOwner !== account) {
    setDraftOwner(account);
    if (draftOwner) {
      setPending(undefined);
    }
    setCreatedRoom(undefined);
    setError("");
  }
  const attachNameInput = useCallback((node: HTMLInputElement | null) => {
    nameInput.current = node;
    if (node) setHasName(Boolean(node.value.trim()));
  }, []);
  useEffect(() => {
    lifetime.current = true;
    return () => {
      lifetime.current = false;
    };
  }, []);
  function assertCurrent(account: ChatPrincipalId) {
    if (
      !lifetime.current ||
      peekCommunitySession()?.principalId.toLowerCase() !==
        account.toLowerCase()
    )
      throw new Error(t("shell.common.accountChanged"));
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!available) {
      show(t("shell.create.unavailable"));
      return;
    }
    const name = nameInput.current?.value.trim() ?? "";
    if (inFlight.current || (!pending && !name)) return;
    const fields = new FormData(event.currentTarget);
    const walletIdentification = fields.has("visitorWallets")
      ? { enabled: true, evm: fields.has("evm"), solana: fields.has("solana") }
      : NEW_WORKSPACE_WALLETS;
    inFlight.current = true;
    setBusy(true);
    setError("");
    trackEvent("create_submitted");
    try {
      const { principalId: account } = await auth.signIn();
      assertCurrent(account);
      let draft =
        pending?.expectedPrincipalId === account
          ? pending
          : parseDraft(savedDraft(account), account);
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
      const {
        walletIdentification: choices = DEFAULT_WALLET_IDENTIFICATION,
        ...roomDraft
      } = draft;
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
      router.push(
        `/inbox/${room.id}?tab=${showPlanAfterCreate ? "plan" : "home"}`,
      );
    } catch (reason) {
      inFlight.current = false;
      if (lifetime.current) setBusy(false);
      trackEvent("create_failed");
      if (lifetime.current && !isChatSignInCanceled(reason))
        setError(walletError(reason) || t("shell.create.failed"));
    }
  }
  return (
    <div className={styles.page}>
      <section className={styles.main} aria-labelledby="create-title">
        <h1 id="create-title">Create your team’s chat</h1>
        <p className={styles.lede}>
          Anyone with the link can start a private conversation with your team.
        </p>
        {!available && (
          <div id="create-unavailable">
            <Callout role="status">{t("shell.create.unavailable")}</Callout>
          </div>
        )}
        <form onSubmit={(event) => void submit(event)} className={styles.form}>
          <Field label={t("shell.create.name")}>
            <input
              className={`${ui.input} ${styles.nameInput}`}
              key={pending?.id ?? "new"}
              ref={attachNameInput}
              defaultValue={pending?.name ?? ""}
              disabled={busy || Boolean(pending)}
              onChange={(event) =>
                setHasName(Boolean(event.currentTarget.value.trim()))
              }
              maxLength={80}
              required
              autoComplete="off"
            />
          </Field>
          <OnboardingWalletFields
            key={pending?.id ?? draftOwner ?? "guest"}
            value={
              pending
                ? (readWalletIdentification(pending.walletIdentification) ??
                  DEFAULT_WALLET_IDENTIFICATION)
                : NEW_WORKSPACE_WALLETS
            }
            disabled={!available || busy || !!pending}
          />
          {error && (
            <Callout tone="danger" role="alert">
              {error}{" "}
              {createdRoom && (
                <a href={`/inbox/${createdRoom}?tab=home`}>
                  Open your workspace
                </a>
              )}
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
            {busy && <span aria-hidden="true" className={styles.creatingMark}>
              <i /><i /><i /><i />
            </span>}
            {busy
              ? t("shell.create.creating")
              : pending && error
                ? t("shell.create.retry")
                : pending
                  ? "Continue creating"
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
          Try {PRODUCT_LIMITS.freeSupportTickets} free tickets with up to {PRODUCT_LIMITS.freeTeamRepliesPerTicket} team replies each.
          {" "}Ask AI {PRODUCT_LIMITS.freeAiPracticeQuestions} private questions about your docs.
        </p>
      </section>
      {toast}
    </div>
  );
}
