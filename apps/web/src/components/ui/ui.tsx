"use client";

import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import {
  IconAlertTriangle,
  IconCheck,
  IconCircleCheck,
  IconCopy,
  IconInfoCircle,
} from "@tabler/icons-react";
import styles from "./ui.module.css";

export { styles as ui };

type Tone = "neutral" | "brand" | "warning" | "info" | "danger";

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  display = false,
  titleId,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Brand display face, for welcome and empty-workspace moments. */
  display?: boolean;
  titleId?: string;
}) {
  return (
    <header className={styles.pageHeader}>
      <div>
        {eyebrow && <div className={styles.eyebrow}>{eyebrow}</div>}
        <h1
          id={titleId}
          className={`${styles.pageTitle} ${display ? styles.displayTitle : ""}`}
        >
          {title}
        </h1>
        {description && <p className={styles.pageDescription}>{description}</p>}
      </div>
      {actions && <div className={styles.pageActions}>{actions}</div>}
    </header>
  );
}

export function Card({
  title,
  description,
  actions,
  footer,
  children,
  className,
  bodyClassName,
  as: Tag = "section",
  ...rest
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
  as?: "section" | "div" | "article";
} & Omit<HTMLAttributes<HTMLElement>, "title">) {
  const titleId = useId();
  return (
    <Tag
      className={`${styles.card} ${className ?? ""}`}
      aria-labelledby={title && Tag === "section" ? titleId : undefined}
      {...rest}
    >
      {(title || actions) && (
        <div className={styles.cardHeader}>
          <div>
            {title && (
              <h2 id={titleId} className={styles.cardTitle}>
                {title}
              </h2>
            )}
            {description && (
              <p className={styles.cardDescription}>{description}</p>
            )}
          </div>
          {actions}
        </div>
      )}
      {children !== undefined && children !== null && (
        <div className={`${styles.cardBody} ${bodyClassName ?? ""}`}>
          {children}
        </div>
      )}
      {footer && <div className={styles.cardFooter}>{footer}</div>}
    </Tag>
  );
}

export function Badge({
  tone = "neutral",
  dot = false,
  children,
  className,
}: {
  tone?: Tone;
  dot?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={`${styles.badge} ${className ?? ""}`} data-tone={tone}>
      {dot && <span className={styles.dot} aria-hidden="true" />}
      {children}
    </span>
  );
}

/** A labelled control. The label wraps the control; the hint and error sit
 * outside it and describe the control, so its accessible name stays short. */
export function Field({
  label,
  hint,
  error,
  optional = false,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  optional?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  const described = [hint ? `${id}-hint` : "", error ? `${id}-error` : ""]
    .filter(Boolean)
    .join(" ");
  const control =
    described && isValidElement<{ "aria-describedby"?: string }>(children)
      ? cloneElement(children, { "aria-describedby": described })
      : children;
  return (
    <div className={`${styles.field} ${className ?? ""}`}>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>
          <span>{label}</span>
          {optional && <span className={styles.fieldOptional}>Optional</span>}
        </span>
        {control}
      </label>
      {hint && (
        <span id={`${id}-hint`} className={styles.fieldHint}>
          {hint}
        </span>
      )}
      {error && (
        <span id={`${id}-error`} className={styles.fieldError} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

export function Callout({
  tone = "neutral",
  icon,
  children,
  className,
  role,
}: {
  tone?: Tone;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
  role?: "status" | "alert" | "note";
}) {
  const fallback =
    tone === "danger" || tone === "warning" ? (
      <IconAlertTriangle aria-hidden="true" />
    ) : tone === "brand" ? (
      <IconCircleCheck aria-hidden="true" />
    ) : (
      <IconInfoCircle aria-hidden="true" />
    );
  return (
    <div
      className={`${styles.callout} ${className ?? ""}`}
      data-tone={tone}
      role={role}
    >
      {icon === null ? null : (icon ?? fallback)}
      <div>{children}</div>
    </div>
  );
}

async function writeClipboard(text: string) {
  await navigator.clipboard.writeText(text);
}

/** Copies text and confirms in place. Falls back to selecting the text. */
export function CopyButton({
  value,
  label = "Copy",
  copiedLabel = "Copied",
  className,
  onCopied,
}: {
  value: string;
  label?: string;
  copiedLabel?: string;
  className?: string;
  onCopied?: () => void;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = window.setTimeout(() => setState("idle"), 2400);
    return () => window.clearTimeout(timer);
  }, [state]);
  return (
    <button
      type="button"
      className={`${styles.copyButton} ${className ?? ""}`}
      data-copied={state === "copied"}
      onClick={() =>
        void writeClipboard(value)
          .then(() => {
            setState("copied");
            onCopied?.();
          })
          .catch(() => setState("failed"))
      }
    >
      {state === "copied" ? (
        <IconCheck aria-hidden="true" />
      ) : (
        <IconCopy aria-hidden="true" />
      )}
      <span aria-live="polite">
        {state === "copied"
          ? copiedLabel
          : state === "failed"
            ? "Select to copy"
            : label}
      </span>
    </button>
  );
}

export function CopyBlock({
  label,
  code,
  copyLabel = "Copy",
  onCopied,
}: {
  label: ReactNode;
  code: string;
  copyLabel?: string;
  onCopied?: () => void;
}) {
  return (
    <div className={styles.copyBlock}>
      <div className={styles.copyBlockHead}>
        <span>{label}</span>
        <CopyButton value={code} label={copyLabel} onCopied={onCopied} />
      </div>
      <pre tabIndex={0}>
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function CopyInline({ value, label }: { value: string; label: string }) {
  return (
    <div className={styles.copyInline}>
      <code title={value}>{value}</code>
      <CopyButton value={value} label={label} />
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  children,
  actions,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`${styles.empty} ${className ?? ""}`}>
      {icon && (
        <span className={styles.emptyIcon} aria-hidden="true">
          {icon}
        </span>
      )}
      <h2 className={styles.emptyTitle}>{title}</h2>
      {children && <p className={styles.emptyBody}>{children}</p>}
      {actions && <div className={styles.emptyActions}>{actions}</div>}
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className={styles.stat}>
      <span className={styles.statLabel}>{label}</span>
      <span className={styles.statValue}>{value}</span>
      {hint && <span className={styles.statHint}>{hint}</span>}
    </div>
  );
}

export function Meter({
  value,
  max,
  label,
}: {
  value: number;
  max: number;
  label: string;
}) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  return (
    <div
      className={styles.meter}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.min(value, max)}
      data-tone={ratio >= 1 ? "danger" : ratio >= 0.8 ? "warning" : undefined}
    >
      <span style={{ width: `${ratio * 100}%` }} />
    </div>
  );
}

export function ActivityDots() {
  return (
    <span className={styles.activityDots} aria-hidden="true">
      <i /><i /><i />
    </span>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <span className={styles.spin} style={{ width: size }} aria-hidden="true" />
  );
}

export function Skeleton({
  width = "100%",
  height = 14,
  className,
}: {
  width?: number | string;
  height?: number | string;
  className?: string;
}) {
  return (
    <span
      className={`${styles.skeleton} ${className ?? ""}`}
      style={{ width, height }}
      aria-hidden="true"
    />
  );
}
