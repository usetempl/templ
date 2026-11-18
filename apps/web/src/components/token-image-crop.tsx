"use client";

import { useEffect, useId, useRef, useState } from "react";
import { IconRefresh } from "@tabler/icons-react";
import {
  constrainCrop,
  CROP_SIZE,
  exportTokenCrop,
  INITIAL_CROP,
  MAX_CROP_ZOOM,
  MIN_CROP_ZOOM,
  paintTokenCrop,
  validateCropImage,
  type CropPosition,
} from "@/lib/token-image-crop";
import { copy as t, type MessageKey } from "@/lib/copy";
import styles from "./token-image-crop.module.css";
import { LoadingSpinner, Skeleton } from "./loading-state";
import { useDismissDialog } from "@/lib/use-dismiss-dialog";

type Props = {
  file: File;
  title?: string;
  onCancel: () => void;
  onUse: (file: File) => Promise<void>;
};
/** An error the dialog raised itself, or the message a failed export carried. */
type CropError = { key: MessageKey } | { text: string };

export function TokenImageCrop({ file, title, onCancel, onUse }: Props) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [bitmap, setBitmap] = useState<ImageBitmap>();
  const [crop, setCrop] = useState<CropPosition>(INITIAL_CROP);
  const [error, setError] = useState<CropError | null>(null);
  const [saving, setSaving] = useState(false);
  const revision = useRef({ value: 0 });
  const exporting = useRef(false);
  const drag = useRef<{
    pointer: number;
    x: number;
    y: number;
    side: number;
    crop: CropPosition;
  } | null>(null);

  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement as HTMLElement | null;
    element?.showModal();
    return () => {
      element?.close();
      previous?.focus();
    };
  }, []);

  useEffect(() => {
    let active = true;
    let decoded: ImageBitmap | undefined;
    const lifetime = revision.current;
    setBitmap(undefined);
    setCrop(INITIAL_CROP);
    setError(null);
    setSaving(false);
    exporting.current = false;
    const current = ++lifetime.value;
    void (async () => {
      try {
        validateCropImage(file);
        const image = await createImageBitmap(file);
        if (!active) {
          image.close();
          return;
        }
        decoded = image;
        if (!image.width || !image.height) throw new Error("Invalid image.");
        setBitmap(image);
      } catch {
        if (active && current === lifetime.value)
          setError({ key: "shell.crop.openFailed" });
      }
    })();
    return () => {
      active = false;
      lifetime.value++;
      decoded?.close();
    };
  }, [file]);

  useEffect(() => {
    if (!bitmap || !canvas.current) return;
    try {
      paintTokenCrop(canvas.current, bitmap, crop);
    } catch {
      setError({ key: "shell.crop.displayFailed" });
    }
  }, [bitmap, crop]);

  function cancel() {
    revision.current.value++;
    onCancel();
  }
  const dismiss = useDismissDialog(cancel);

  async function applyImage() {
    if (!bitmap || exporting.current) return;
    exporting.current = true;
    setSaving(true);
    setError(null);
    const current = revision.current.value;
    try {
      const image = await exportTokenCrop(bitmap, crop);
      if (current !== revision.current.value) return;
      await onUse(image);
    } catch (reason) {
      if (current === revision.current.value)
        setError(
          reason instanceof Error
            ? { text: reason.message }
            : { key: "shell.crop.saveFailed" },
        );
    } finally {
      if (current === revision.current.value) {
        exporting.current = false;
        setSaving(false);
      }
    }
  }

  const heading = title ?? t("shell.crop.title");
  const errorText = error ? ("key" in error ? t(error.key) : error.text) : "";
  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-hint`}
      {...dismiss}
    >
      <div className={styles.header}>
        <h2 id={`${id}-title`}>{heading}</h2>
        <p id={`${id}-hint`}>{t("shell.crop.hint")}</p>
      </div>
      <div className={styles.content}>
        <div
          className={styles.frame}
          role="group"
          aria-label={t("shell.crop.position")}
          aria-describedby={`${id}-keyboard`}
          tabIndex={0}
          onPointerDown={(event) => {
            if (
              !bitmap ||
              saving ||
              (event.pointerType === "mouse" && event.button !== 0)
            )
              return;
            const side = event.currentTarget.getBoundingClientRect().width;
            if (!side) return;
            event.currentTarget.focus();
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = {
              pointer: event.pointerId,
              x: event.clientX,
              y: event.clientY,
              side,
              crop,
            };
          }}
          onPointerMove={(event) => {
            const start = drag.current;
            if (
              !bitmap ||
              saving ||
              !start ||
              start.pointer !== event.pointerId
            )
              return;
            setCrop(
              constrainCrop(bitmap, {
                ...start.crop,
                x: start.crop.x + (event.clientX - start.x) / start.side,
                y: start.crop.y + (event.clientY - start.y) / start.side,
              }),
            );
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
          onLostPointerCapture={() => {
            drag.current = null;
          }}
          onKeyDown={(event) => {
            const directions: Record<string, [number, number]> = {
              ArrowLeft: [-1, 0],
              ArrowRight: [1, 0],
              ArrowUp: [0, -1],
              ArrowDown: [0, 1],
            };
            const direction = directions[event.key];
            if (!direction || !bitmap || saving) return;
            event.preventDefault();
            const step = event.shiftKey ? 0.1 : 0.02;
            setCrop((current) =>
              constrainCrop(bitmap, {
                ...current,
                x: current.x + direction[0] * step,
                y: current.y + direction[1] * step,
              }),
            );
          }}
        >
          <canvas
            ref={canvas}
            width={CROP_SIZE}
            height={CROP_SIZE}
            aria-label={t("shell.crop.preview")}
            role="img"
          />
          <span className={styles.circle} aria-hidden="true" />
          {!bitmap && (
            <span
              className={styles.loading}
              role="status"
              aria-label={
                errorText
                  ? t("shell.crop.unavailable")
                  : t("shell.crop.opening")
              }
            >
              {errorText ? (
                t("shell.crop.unavailable")
              ) : (
                <>
                  <span className={styles.srOnly}>
                    {t("shell.crop.opening")}
                  </span>
                  <Skeleton height="100%" />
                </>
              )}
            </span>
          )}
        </div>
        <span className={styles.srOnly} id={`${id}-keyboard`}>
          {t("shell.crop.keyboard")}
        </span>
        <div className={styles.controls}>
          <label htmlFor={`${id}-zoom`}>{t("shell.crop.zoom")}</label>
          <input
            id={`${id}-zoom`}
            className={styles.zoom}
            type="range"
            min={MIN_CROP_ZOOM}
            max={MAX_CROP_ZOOM}
            step={0.01}
            value={crop.zoom}
            aria-valuetext={t("shell.crop.zoomValue", {
              percent: Math.round(crop.zoom * 100),
            })}
            disabled={!bitmap || saving}
            onChange={(event) => {
              if (bitmap)
                setCrop((current) =>
                  constrainCrop(bitmap, {
                    ...current,
                    zoom: Number(event.target.value),
                  }),
                );
            }}
          />
          <span
            className={styles.zoomValue}
            aria-hidden="true"
            data-testid="zoom-value"
          >
            {Math.round(crop.zoom * 100)}%
          </span>
          <button
            type="button"
            className={styles.reset}
            disabled={!bitmap || saving}
            onClick={() => setCrop(INITIAL_CROP)}
          >
            <IconRefresh size={16} aria-hidden="true" /> {t("shell.crop.reset")}
          </button>
        </div>
        {errorText && (
          <p className={styles.error} role="alert">
            {errorText}
          </p>
        )}
        <div className={styles.actions}>
          <button type="button" className="button secondary" onClick={cancel}>
            {t("shell.common.cancel")}
          </button>
          <button
            type="button"
            className="button"
            disabled={!bitmap || saving}
            onClick={() => void applyImage()}
          >
            {saving && <LoadingSpinner />}
            {saving ? t("shell.crop.preparing") : t("shell.crop.use")}
          </button>
        </div>
      </div>
    </dialog>
  );
}
