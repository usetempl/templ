"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { IconArrowRight, IconArrowUp } from "@tabler/icons-react";
import { PRODUCT_LIMITS } from "@templ/chat/plans";
import { useChatAuth } from "@/lib/chat-auth";
import { isChatSignInCanceled } from "@/lib/chat-auth-cancellation";
import { communityFetch, CommunityApiError } from "@/lib/community-client";
import { useRelease } from "@/lib/release-context";
import { workspaceCreationEnabled } from "@/lib/release-public";
import { trackEvent } from "@/lib/analytics";
import { Callout, Field, ui } from "./ui/ui";
import styles from "./native-chat-create.module.css";

type Brand = { name: string; accent: string; logo: string };
type Preview = {
  previewId: string;
  site: string;
  brand: Brand;
  icon: string;
  ready: boolean;
  remaining: number;
  confirmed: boolean;
};
type Restored = Preview | { claiming: true; previewId: string } | null;
type Turn = { question: string; answer: string | null };

export function WebsiteOnboarding({ nextPlan }: { nextPlan: boolean }) {
  const auth = useChatAuth();
  const router = useRouter();
  const available = workspaceCreationEnabled(useRelease());
  const [site, setSite] = useState("");
  const restart = useRef(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [brand, setBrand] = useState<Brand | null>(null);
  const [claiming, setClaiming] = useState("");
  const [editing, setEditing] = useState(false);
  const [fieldsOpen, setFieldsOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const lock = useRef(false);
  const interacted = useRef(false);
  const attempt = useRef<{ question: string; id: string } | null>(null);

  function showPreview(value: Preview) {
    restart.current = false;
    setPreview(value);
    setBrand(value.brand);
    setSite(value.site);
    setEditing(!value.confirmed);
    setFieldsOpen(false);
  }
  useEffect(() => {
    const abort = new AbortController();
    void communityFetch<Restored>("/onboarding/read", {}, abort.signal)
      .then((value) => {
        if (!value || abort.signal.aborted || interacted.current) return;
        if ("claiming" in value) setClaiming(value.previewId);
        else showPreview(value);
      })
      .catch((reason: unknown) => {
        if (reason instanceof CommunityApiError && reason.status === 410)
          restart.current = true;
      });
    return () => abort.abort();
  }, []);

  async function run(action: string, work: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    interacted.current = true;
    setBusy(action);
    setError("");
    try {
      await work();
    } catch (reason) {
      if (!isChatSignInCanceled(reason))
        setError(reason instanceof Error ? reason.message : "Try again.");
      if (reason instanceof CommunityApiError && reason.status === 410) {
        restart.current = true;
        setPreview(null);
        setBrand(null);
        setClaiming("");
        setTurns([]);
      }
    } finally {
      lock.current = false;
      setBusy("");
    }
  }
  function start(event: FormEvent) {
    event.preventDefault();
    void run("start", async () => {
      showPreview(
        await communityFetch<Preview>("/onboarding/start", {
          site,
          restart: restart.current,
        }),
      );
      setTurns([]);
      attempt.current = null;
    });
  }
  function confirm(event: FormEvent) {
    event.preventDefault();
    if (brand)
      void run("confirm", async () => {
        showPreview(
          await communityFetch<Preview>("/onboarding/confirm", {
            ...brand,
            previewId: preview?.previewId,
          }),
        );
      });
  }
  function ask(event: FormEvent) {
    event.preventDefault();
    const text = question.trim();
    if (!preview || !text) return;
    void run("ask", async () => {
      if (attempt.current?.question !== text)
        attempt.current = { question: text, id: crypto.randomUUID() };
      try {
        const reply = await communityFetch<{
          answer: string | null;
          remaining: number;
        }>("/onboarding/ask", {
          question: text,
          requestId: attempt.current.id,
          previewId: preview.previewId,
        });
        setTurns((current) => [
          ...current,
          { question: text, answer: reply.answer },
        ]);
        setPreview({ ...preview, remaining: reply.remaining });
        setQuestion("");
        attempt.current = null;
      } catch (reason) {
        const current = await communityFetch<Restored>(
          "/onboarding/read",
          {},
        ).catch(() => null);
        if (current && "brand" in current) setPreview(current);
        if (reason instanceof CommunityApiError && reason.status === 409)
          attempt.current = null;
        throw reason;
      }
    });
  }
  function save() {
    void run("save", async () => {
      const session = await auth.signIn();
      trackEvent("create_submitted");
      const { id } = await communityFetch<{ id: string }>("/onboarding/claim", {
        previewId: claiming || preview?.previewId,
        expectedPrincipalId: session.principalId,
      });
      trackEvent("create_completed");
      router.push("/inbox/" + id + "?tab=" + (nextPlan ? "plan" : "home"));
    });
  }
  const disabled = !!busy || !available;
  const reset = () => {
    restart.current = true;
    interacted.current = true;
    setPreview(null);
    setBrand(null);
    setClaiming("");
    setError("");
    setTurns([]);
    setQuestion("");
  };
  return (
    <div className={styles.page}>
      <section className={styles.main} aria-labelledby="create-title">
        <h1 id="create-title">
          {claiming
            ? "Save your workspace"
            : preview
              ? editing
                ? "Make it yours"
                : "Try your support chat"
              : "Try Templ with your website"}
        </h1>
        {!preview && !claiming && (
          <>
            <p className={styles.lede}>
              See your chat and ask AI about your site. No sign-in needed.
            </p>
            <form className={styles.form} onSubmit={start}>
              <Field label="Your website">
                <input
                  className={ui.input}
                  autoComplete="url"
                  inputMode="url"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="example.com"
                  value={site}
                  onChange={(e) => {
                    interacted.current = true;
                    setSite(e.target.value);
                  }}
                  maxLength={2048}
                  required
                />
              </Field>
              <button
                className={"button " + styles.submit}
                disabled={disabled || !site.trim()}
              >
                {busy === "start"
                  ? "Reading your website…"
                  : "Preview your chat"}{" "}
                <IconArrowRight aria-hidden />
              </button>
            </form>
            <p className={styles.terms}>
              <Link href={"/create?manual=1" + (nextPlan ? "&next=plan" : "")}>
                Set up without a website
              </Link>
            </p>
          </>
        )}
        {preview && brand && (
          <>
            <div className={styles.preview}>
              <header className={styles.previewHeader}>
                <span
                  className={styles.previewIcon}
                  style={{ borderColor: brand.accent }}
                >
                  {preview.icon && brand.logo === preview.brand.logo ? (
                    // Data from the bounded website import, shown only as an image.
                    <img alt="" width={36} height={36} src={preview.icon} />
                  ) : (
                    (brand.name.trim()[0] || "?").toUpperCase()
                  )}
                </span>
                <div>
                  <strong>{brand.name || "Your team"}</strong>
                  <span>{new URL(preview.site).hostname}</span>
                </div>
                {!fieldsOpen && (
                  <button
                    type="button"
                    className={styles.textButton}
                    disabled={disabled}
                    onClick={() => {
                      setEditing(true);
                      setFieldsOpen(true);
                    }}
                  >
                    Edit brand
                  </button>
                )}
              </header>
              {editing ? (
                <form className={styles.previewBody} onSubmit={confirm}>
                  {fieldsOpen && (
                    <>
                      <Field label="Chat name">
                        <input
                          className={ui.input}
                          required
                          maxLength={80}
                          value={brand.name}
                          onChange={(e) =>
                            setBrand({ ...brand, name: e.target.value })
                          }
                        />
                      </Field>
                      <Field label="Icon URL" optional>
                        <input
                          className={ui.input}
                          type="url"
                          value={brand.logo}
                          placeholder="https://example.com/icon.png"
                          onChange={(e) =>
                            setBrand({ ...brand, logo: e.target.value })
                          }
                        />
                      </Field>
                      <Field label="Accent color">
                        <input
                          className={styles.colorInput}
                          type="color"
                          value={brand.accent}
                          onChange={(e) =>
                            setBrand({ ...brand, accent: e.target.value })
                          }
                        />
                      </Field>
                    </>
                  )}
                  <div className={styles.actions}>
                    <button
                      className="button"
                      disabled={disabled || !brand.name.trim()}
                    >
                      {busy === "confirm" ? "Saving…" : "Use this brand"}
                    </button>
                    <button
                      type="button"
                      disabled={disabled}
                      className={styles.textButton}
                      onClick={reset}
                    >
                      Change website
                    </button>
                  </div>
                </form>
              ) : (
                <div className={styles.previewBody}>
                  {preview.ready ? (
                    <>
                      <div className={styles.transcript} aria-live="polite">
                        {turns.map((turn, i) => (
                          <div key={i}>
                            <p className={styles.question}>{turn.question}</p>
                            <p>
                              {turn.answer ||
                                "I couldn’t find an answer on this page."}
                            </p>
                          </div>
                        ))}
                      </div>
                      <form onSubmit={ask} className={styles.practice}>
                        <Field label="Ask about your website">
                          <input
                            className={ui.input}
                            value={question}
                            maxLength={800}
                            onChange={(e) => setQuestion(e.target.value)}
                            placeholder="What does your product do?"
                            disabled={busy === "ask" || !preview.remaining}
                          />
                        </Field>
                        <button
                          className="button"
                          aria-label="Ask AI"
                          disabled={
                            disabled || !preview.remaining || !question.trim()
                          }
                        >
                          <IconArrowUp aria-hidden />
                        </button>
                      </form>
                      <p className={styles.note} role="status">
                        {busy === "ask"
                          ? "Finding an answer…"
                          : preview.remaining +
                            " of " +
                            PRODUCT_LIMITS.freeAiPracticeQuestions +
                            " free questions left"}
                        {" · "}
                        <a
                          href="https://docs.usetempl.com/ai#practice-privacy"
                          target="_blank"
                          rel="noreferrer"
                        >
                          Practice privacy
                        </a>
                      </p>
                    </>
                  ) : (
                    <p>
                      AI couldn’t read this page.{" "}
                      <button className={styles.textButton} onClick={reset}>
                        Try a public docs page
                      </button>
                    </p>
                  )}
                </div>
              )}
            </div>
          </>
        )}
        {(claiming || (preview?.confirmed && !editing)) && (
          <div className={styles.save}>
            <button
              className="button"
              disabled={disabled || auth.restoring}
              onClick={save}
            >
              {busy === "save"
                ? "Saving your workspace…"
                : auth.session
                  ? "Save workspace"
                  : "Sign in to keep your workspace"}
            </button>
          </div>
        )}
        {!available && (
          <Callout role="status">
            Workspace setup is unavailable. Try again later.
          </Callout>
        )}
        {error && (
          <Callout tone="danger" role="alert">
            {error}
          </Callout>
        )}
      </section>
    </div>
  );
}
