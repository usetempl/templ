"use client";

import { useEffect, useId, useRef, useState } from "react";
import { IconTrash, IconUpload, IconX } from "@tabler/icons-react";
import type { ChatPrincipalId } from "@templ/chat/principal";
import {
  DISPLAY_NAME_MAX,
  DISPLAY_NAME_MIN,
  PROFILE_CHANGES_PER_DAY,
  normalizeDisplayName,
  type MemberProfile,
  type ProfileUpdate,
} from "@templ/chat/profiles";
import { chatMutation, requireChatSession } from "@/lib/chat-api";
import { communityFetch } from "@/lib/community-client";
import { forgetMemberProfile } from "@/lib/member-profiles";
import { uploadTokenImage } from "@/lib/token-image";
import { AVATAR_SIZE, prepareAvatarImage } from "@/lib/profile-image";
import { validateCropImage } from "@/lib/token-image-crop";
import { walletError } from "@/lib/wallet";
import { useActionToast } from "./action-toast";
import { LoadingSpinner } from "./loading-state";
import { MemberAvatar } from "./member-identity";
import { TokenImageCrop } from "./token-image-crop";
import { useDismissDialog } from "@/lib/use-dismiss-dialog";
import { copy, copy as t, type MessageKey, type Params } from "@/lib/copy";
import styles from "./profile-settings-dialog.module.css";

/** The viewer's own profile. A display name is a label anyone can
 * choose; the picture goes through the same authenticated `/media` upload the
 * room icon uses. None of it changes what the account may do. Only a
 * workspace manager labels an account as an AI agent. */
export { PROFILE_SETTINGS_EVENT } from "./profile-settings-event";
export type OwnProfile = MemberProfile & { changesLeftToday: number };
/** `t` for the plain helpers here; the English text when a caller passes none. */
type CopyFormatter = (key: MessageKey, params?: Params) => string;

/** Empty clears the name. Anything else must pass the shared rules, whose
 * own message is shown as it came. */
function nameIssue(value: string, t: CopyFormatter = copy): string {
  if (!value.trim()) return "";
  try {
    normalizeDisplayName(value);
    return "";
  } catch (reason) {
    return reason instanceof Error
      ? reason.message
      : t("room.profile.chooseAnotherName");
  }
}

export function ProfileSettingsDialog({
  account,
  onClose,
}: {
  account: ChatPrincipalId;
  onClose: () => void;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const alive = useRef(true);
  const fileInput = useRef<HTMLInputElement>(null);
  const { show, toast } = useActionToast();
  const [profile, setProfile] = useState<OwnProfile>();
  const [loadError, setLoadError] = useState("");
  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState<string | null>(null);
  // An uploaded picture stays private until the profile is saved, so the
  // dialog shows the local copy until then.
  const [preview, setPreview] = useState<string>();
  const [cropping, setCropping] = useState<File>();
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const revision = useRef(0);
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );

  useEffect(() => {
    alive.current = true;
    const element = dialog.current;
    const previous = document.activeElement as HTMLElement | null;
    element?.showModal();
    return () => {
      alive.current = false;
      element?.close();
      previous?.focus();
    };
  }, []);
  useEffect(() => {
    const current = ++revision.current;
    setProfile(undefined);
    setLoadError("");
    void (async () => {
      try {
        await requireChatSession(account);
        const own = await communityFetch<OwnProfile>(
          `/auth/profile?expectedPrincipalId=${encodeURIComponent(account)}`,
        );
        if (!alive.current || current !== revision.current) return;
        setProfile(own);
        setName(own.displayName ?? "");
        setAvatar(own.avatar ?? null);
      } catch (reason) {
        if (!alive.current || current !== revision.current) return;
        setLoadError(walletError(reason));
      }
    })();
  }, [account]);

  const issue = nameIssue(name, t);
  const update: ProfileUpdate = {};
  if (profile) {
    const currentName = profile.displayName ?? null;
    if (!issue) {
      const normalized = name.trim() ? normalizeDisplayName(name) : null;
      if (normalized !== currentName) update.displayName = normalized;
    }
    if (avatar !== (profile.avatar ?? null)) update.avatar = avatar;
  }
  const dirty = Object.keys(update).length > 0;
  const busy = saving || uploading || Boolean(cropping);
  const changesLeft = profile?.changesLeftToday ?? PROFILE_CHANGES_PER_DAY;

  function choose(file?: File) {
    if (!file) return;
    setError("");
    try {
      validateCropImage(file);
      setCropping(file);
    } catch (reason) {
      setError(walletError(reason));
    }
  }
  async function save() {
    if (!profile || !dirty || issue || busy) return;
    const current = revision.current;
    setSaving(true);
    setError("");
    try {
      const saved = await chatMutation<OwnProfile>(
        account,
        "/auth/profile",
        update,
      );
      if (!alive.current || current !== revision.current) return;
      forgetMemberProfile(account);
      setPreview(undefined);
      setProfile(saved);
      setName(saved.displayName ?? "");
      setAvatar(saved.avatar ?? null);
      show(t("room.profile.saved"));
    } catch (reason) {
      if (!alive.current || current !== revision.current) return;
      setError(walletError(reason));
    } finally {
      if (alive.current && current === revision.current) setSaving(false);
    }
  }

  // Busy covers a save, an upload and the open crop picker.
  const dismiss = useDismissDialog(onClose, { disabled: busy });
  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby={`${id}-title`}
      {...dismiss}
    >
      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <header className={styles.header}>
          <h2 id={`${id}-title`}>{t("room.profile.title")}</h2>
          <button
            type="button"
            className={styles.close}
            aria-label={t("room.profile.close")}
            disabled={saving}
            onClick={onClose}
          >
            <IconX size={18} aria-hidden="true" />
          </button>
        </header>
        {loadError ? (
          <p className={styles.error} role="alert">
            {loadError}
          </p>
        ) : !profile ? (
          <p className={styles.loading}>
            <LoadingSpinner /> {t("room.profile.loading")}
          </p>
        ) : (
          <div className={styles.fields}>
            <div className={styles.avatarRow}>
              <span className={styles.avatarFrame}>
                <MemberAvatar
                  principalId={account}
                  profile={{ ...profile, avatar: preview ?? avatar }}
                  size="md"
                />
              </span>
              <div className={styles.avatarActions}>
                <span className={styles.label}>
                  {t("room.profile.picture")}
                </span>
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  hidden
                  aria-label={t("room.profile.choosePicture")}
                  onChange={(event) => {
                    choose(event.target.files?.[0]);
                    event.target.value = "";
                  }}
                />
                <div className={styles.buttons}>
                  <button
                    type="button"
                    disabled={busy}
                    className={styles.secondary}
                    onClick={() => fileInput.current?.click()}
                  >
                    {uploading ? <LoadingSpinner /> : <IconUpload size={16} />}
                    {avatar
                      ? t("room.profile.changePicture")
                      : t("room.profile.addPicture")}
                  </button>
                  {avatar && (
                    <button
                      type="button"
                      disabled={busy}
                      className={styles.destructive}
                      onClick={() => {
                        setError("");
                        setAvatar(null);
                        setPreview(undefined);
                      }}
                    >
                      <IconTrash size={16} /> {t("room.profile.removePicture")}
                    </button>
                  )}
                </div>
                <span className={styles.help}>
                  {t("room.profile.pictureHelp", { size: AVATAR_SIZE })}
                </span>
              </div>
            </div>
            <div className={styles.field}>
              <label htmlFor={`${id}-name`} className={styles.label}>
                {t("room.profile.displayName")}
              </label>
              <input
                id={`${id}-name`}
                type="text"
                value={name}
                maxLength={DISPLAY_NAME_MAX * 2}
                autoComplete="nickname"
                spellCheck={false}
                disabled={busy}
                aria-invalid={Boolean(issue)}
                aria-describedby={`${id}-name-help`}
                placeholder={t("room.profile.namePlaceholder")}
                onChange={(event) => {
                  setError("");
                  setName(event.target.value);
                }}
              />
              <span
                id={`${id}-name-help`}
                className={issue ? styles.issue : styles.help}
                role={issue ? "alert" : undefined}
              >
                {issue ||
                  t("room.profile.nameHelp", {
                    min: DISPLAY_NAME_MIN,
                    max: DISPLAY_NAME_MAX,
                  })}
              </span>
            </div>
            <p className={styles.quota} data-remaining={changesLeft}>
              {changesLeft === 0
                ? t("room.profile.changesUsed", {
                    count: PROFILE_CHANGES_PER_DAY,
                  })
                : t("room.profile.changesLeft", {
                    left: changesLeft,
                    count: PROFILE_CHANGES_PER_DAY,
                  })}
            </p>
            {error && (
              <p className={styles.error} role="alert">
                {error}
              </p>
            )}
            <div className={styles.footer}>
              <button
                type="button"
                className={styles.secondary}
                disabled={saving}
                onClick={onClose}
              >
                {t("room.profile.closeButton")}
              </button>
              <button
                type="submit"
                className={styles.primary}
                disabled={!dirty || Boolean(issue) || busy}
              >
                {saving ? <LoadingSpinner /> : null}
                {t("room.profile.save")}
              </button>
            </div>
          </div>
        )}
      </form>
      {cropping && (
        <TokenImageCrop
          file={cropping}
          title={t("room.profile.frame")}
          onCancel={() => setCropping(undefined)}
          onUse={async (file) => {
            const current = revision.current;
            setUploading(true);
            try {
              const prepared = await prepareAvatarImage(file);
              await requireChatSession(account);
              const url = await uploadTokenImage(prepared);
              if (!alive.current || current !== revision.current) return;
              setAvatar(url);
              setPreview(URL.createObjectURL(prepared));
              setError("");
            } finally {
              if (alive.current && current === revision.current)
                setUploading(false);
            }
            setCropping(undefined);
          }}
        />
      )}
      {toast}
    </dialog>
  );
}
