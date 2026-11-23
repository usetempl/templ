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
      <TeamWebsiteForm context={context} saved={saved} onSave={setSaved} />
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

function TeamWebsiteForm({ context, saved, onSave }: {
  context: WorkspaceContext;
  saved?: WorkspaceSupportProfiles;
  onSave(value: WorkspaceSupportProfiles): void;
}) {
  const [edit, setEdit] = useState<{ name: string; website: string }>();
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const value = edit ?? saved?.teamLink ?? { name: "", website: "" };
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!edit || busy) return;
    setBusy(true);
    setFeedback("");
    try {
      const result = await chatMutation<{ supportProfiles: WorkspaceSupportProfiles }>(
        context.account as never, roomPath(context.room, "profile"), {
          contactRole: "founder", confirmed: true, profileRevision: saved?.revision ?? 0,
          teamLink: value.website.trim() || value.name.trim()
            ? { name: value.name.trim(), website: value.website.trim() } : null,
        },
      );
      onSave(result.supportProfiles);
      setEdit(undefined);
      setFeedback("Team link saved.");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Could not save the team link.");
    } finally { setBusy(false); }
  }
  return <form onSubmit={submit}>
    <UnsavedChanges dirty={!!edit} />
    <Card title="Team website" description="Visitors can open your website from the chat menu." bodyClassName={styles.panelBody}>
      <Field label="Name in the chat footer"><input className={ui.input} maxLength={48}
        value={value.name} required={!!value.website} disabled={busy}
        onChange={event => setEdit({ ...value, name: event.target.value })} /></Field>
      <Field label="Team website"><input className={ui.input} type="url" placeholder="https://example.com"
        value={value.website} required={!!value.name} disabled={busy}
        onChange={event => setEdit({ ...value, website: event.target.value })} /></Field>
      <button type="submit" className="button" disabled={busy || !edit}>Save team link</button>
      {feedback && <p role="status">{feedback}</p>}
    </Card>
  </form>;
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
