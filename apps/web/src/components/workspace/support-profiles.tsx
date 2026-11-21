"use client";

import { useState, type FormEvent } from "react";
import type {
  SupportContactRole,
  WorkspaceSupportProfiles,
} from "@templ/chat/support";
import { chatMutation } from "@/lib/chat-api";
import { roomPath } from "@/lib/community-client";
import { prepareAvatarImage } from "@/lib/profile-image";
import { uploadTokenImage } from "@/lib/token-image";
import { validateCropImage } from "@/lib/token-image-crop";
import { Card, Field, Spinner, ui } from "@/components/ui/ui";
import { WorkspaceMark } from "./app-frame";
import { UnsavedChanges } from "./unsaved-changes";
import type { WorkspaceContext } from "./support-workspace";
import styles from "./workspace-settings.module.css";

export function SupportProfiles({
  context,
  initial,
  connected,
}: {
  context: WorkspaceContext;
  initial?: WorkspaceSupportProfiles;
  connected: boolean;
}) {
  const [saved, setSaved] = useState(initial);
  return (
    <section
      id="support-profiles"
      aria-label="Support profiles"
      className={styles.sections}
    >
      {(["founder", "assistant"] as const).map((role) => (
        <ContactForm
          key={role}
          role={role}
          context={context}
          saved={saved}
          onSave={setSaved}
          connected={connected}
        />
      ))}
    </section>
  );
}

function ContactForm({
  role,
  context,
  saved,
  onSave,
  connected,
}: {
  role: SupportContactRole;
  context: WorkspaceContext;
  saved?: WorkspaceSupportProfiles;
  onSave(value: WorkspaceSupportProfiles): void;
  connected: boolean;
}) {
  const assistant = role === "assistant",
    label = assistant ? "AI assistant" : "Founder";
  const contact = saved?.[role],
    originalName = contact?.name ?? "";
  const [name, setName] = useState<string>();
  const [file, setFile] = useState<File | null>();
  const [enabled, setEnabled] = useState<boolean>();
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const originalEnabled = saved?.assistantEnabled ?? true;
  const dirty =
    (name !== undefined && name !== originalName) ||
    file !== undefined ||
    (assistant && enabled !== undefined && enabled !== originalEnabled);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !dirty) return;
    setBusy(true);
    setError("");
    setFeedback("");
    try {
      const image = file
        ? await uploadTokenImage(await prepareAvatarImage(file))
        : file;
      const result = await chatMutation<{
        supportProfiles: WorkspaceSupportProfiles;
      }>(context.account as never, roomPath(context.room, "profile"), {
        contactRole: role,
        profileRevision: saved?.revision ?? 0,
        confirmed: true,
        ...(name === undefined ? {} : { name: name.trim() || null }),
        ...(file === undefined ? {} : { image }),
        ...(assistant && enabled !== undefined
          ? { assistantEnabled: enabled }
          : {}),
      });
      onSave(result.supportProfiles);
      setName(undefined);
      setFile(undefined);
      setEnabled(undefined);
      setFeedback("Profile saved.");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The profile could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={save}>
      <UnsavedChanges dirty={dirty} />
      <Card
        title={label}
        description="Visitors see this name and photo in the chat."
        bodyClassName={styles.panelBody}
        footer={
          <>
            <span>
              {error ? (
                <span className={styles.feedback} role="alert">
                  {error}
                </span>
              ) : (
                <span className={styles.feedback} role="status">
                  {feedback}
                </span>
              )}
            </span>
            <button type="submit" className="button" disabled={!dirty || busy}>
              {busy && <Spinner />}Save {assistant ? "assistant" : "founder"}{" "}
              profile
            </button>
          </>
        }
      >
        <Field label="Display name">
          <input
            className={ui.input}
            value={name ?? originalName}
            maxLength={48}
            placeholder={label}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <div className={styles.logoPreview}>
          <WorkspaceMark
            name={name || originalName || label}
            image={file === null ? null : (contact?.image ?? null)}
          />
          <Field
            label="Photo"
            hint={
              file ? file.name : "Choose a PNG, JPEG, WebP or GIF under 5 MB."
            }
          >
            <input
              type="file"
              className={ui.input}
              accept="image/png,image/jpeg,image/webp,image/gif"
              disabled={busy}
              onChange={(event) => {
                const selected = event.target.files?.[0];
                event.target.value = "";
                if (!selected) return;
                try {
                  validateCropImage(selected);
                  setFile(selected);
                  setError("");
                } catch (cause) {
                  setError(
                    cause instanceof Error
                      ? cause.message
                      : "Choose another photo.",
                  );
                }
              }}
            />
          </Field>
          {(contact?.image || file) && (
            <button
              type="button"
              className="button quiet"
              disabled={busy}
              onClick={() => setFile(null)}
            >
              Remove photo
            </button>
          )}
        </div>
        {assistant && (
          <Field
            label="AI replies"
            hint={
              connected
                ? "Turn this off to hide the assistant and stop AI work for this workspace."
                : "Set up your responder in AI before it can answer visitors."
            }
          >
            <label>
              <input
                type="checkbox"
                checked={enabled ?? originalEnabled}
                disabled={busy}
                onChange={(event) => setEnabled(event.target.checked)}
              />{" "}
              Allow the assistant to answer
            </label>
          </Field>
        )}
      </Card>
    </form>
  );
}
