"use client";

import { useEffect, useState, type FormEvent } from "react";
import { chatMutation } from "@/lib/chat-api";
import { roomPath } from "@/lib/community-client";
import { prepareAvatarImage } from "@/lib/profile-image";
import { uploadTokenImage } from "@/lib/token-image";
import { validateCropImage } from "@/lib/token-image-crop";
import { Card, Field, Spinner, ui } from "@/components/ui/ui";
import { WorkspaceMark } from "./app-frame";
import type { WorkspaceContext } from "./support-workspace";
import { UnsavedChanges } from "./unsaved-changes";
import layout from "./workspace-settings.module.css";

export function WorkspaceIcon({ context }: { context: WorkspaceContext }) {
  const { room, account, workspace } = context;
  const [file, setFile] = useState<File>();
  const [preview, setPreview] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (!file) {
      setPreview(undefined);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  async function saveImage(read: () => Promise<Blob>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const image = await uploadTokenImage(
        await prepareAvatarImage(await read(), "contain"),
      );
      await chatMutation(account as never, roomPath(room, "profile"), {
        image,
      });
      setFile(undefined);
      setNotice("Logo saved.");
      context.reload();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The logo could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  }
  function save(event: FormEvent) {
    event.preventDefault();
    if (file) void saveImage(async () => file);
  }
  return (
    <form onSubmit={(event) => void save(event)}>
      <UnsavedChanges dirty={Boolean(file)} />
      <Card
        id="workspace-logo"
        title="Workspace logo"
        description="Shown in the workspace list and support header."
        bodyClassName={layout.panelBody}
        footer={
          <>
            <span>
              {notice && (
                <span className={layout.feedback} role="status">
                  {notice}
                </span>
              )}
              {error && (
                <span className={layout.feedback} role="alert">
                  {error}
                </span>
              )}
            </span>
            <button type="submit" className="button" disabled={!file || busy}>
              {busy && <Spinner />}Save logo
            </button>
          </>
        }
      >
        <div className={layout.logoPreview}>
          <WorkspaceMark
            name={workspace.name}
            image={preview ?? workspace.image}
          />
          <Field label="Logo" hint="PNG, JPEG, WebP or GIF under 5 MB.">
            <input
              className={ui.input}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              disabled={busy}
              onChange={(event) => {
                setError("");
                setNotice("");
                const next = event.target.files?.[0];
                event.target.value = "";
                if (!next) return;
                setFile(undefined);
                try {
                  validateCropImage(next);
                  setFile(next);
                } catch (reason) {
                  setError(
                    reason instanceof Error
                      ? reason.message
                      : "Choose an image under 5 MB.",
                  );
                }
              }}
            />
          </Field>
        </div>
      </Card>
    </form>
  );
}
