"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { IconArrowRight } from "@tabler/icons-react";
import { WebsitePracticeChat } from "./website-practice-chat";
import { PRODUCT_LIMITS } from "@templ/chat/plans";
import { useChatAuth } from "@/lib/chat-auth";
import { isChatSignInCanceled } from "@/lib/chat-auth-cancellation";
import { communityFetch, CommunityApiError } from "@/lib/community-client";
import { useRelease } from "@/lib/release-context";
import { workspaceCreationEnabled } from "@/lib/release-public";
import { trackEvent } from "@/lib/analytics";
import { ActivityDots, Callout, Field, ui } from "./ui/ui";
import styles from "./native-chat-create.module.css";

type Brand = { name: string; accent: string; logo: string };
type Preview = {
  previewId: string;
  site: string;
  brand: Brand;
  icon: string;
  ready: boolean;
  suggestion?: string;
  remaining: number;
  confirmed: boolean;
};
type Restored = Preview | { claiming: true; previewId: string } | null;
/** Each failure shows beside the action that caused it. */
type Failure = { text: string; at: "chat" | "brand" | "page" };

// The service writes its errors for visitors. Browsers do not.
function errorText(reason: unknown) {
  if (!(reason instanceof Error)) return "Try again.";
  return /^(Abort|Timeout|Type|Syntax)Error$/.test(reason.name)
    ? "Templ could not be reached. Try again."
    : reason.message;
}
const refusedSecret = (reason: unknown) =>
  reason instanceof CommunityApiError &&
  (reason.details as { reason?: unknown } | undefined)?.reason ===
    "secret-refused";
function siteHost(site: string) {
  try {
    const url = site.trim().replace(/^https?:\/\//i, "");
    return new URL("https://" + url).hostname.replace(/^www\./, "");
  } catch {
    // The server shows the validation error for an invalid address.
    return "";
  }
}

export function WebsiteOnboarding({ nextPlan }: { nextPlan: boolean }) {
  const auth = useChatAuth();
  const router = useRouter();
  const available = workspaceCreationEnabled(useRelease());
  const [site, setSite] = useState("");
  const restart = useRef(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [brand, setBrand] = useState<Brand | null>(null);
  const [claiming, setClaiming] = useState("");

  const [busy, setBusy] = useState("");
  const [error, setError] = useState<Failure | null>(null);
  const [slowScan, setSlowScan] = useState(false);
  const scanning = busy === "start";
  useEffect(() => {
    if (!scanning) return;
    const timer = window.setTimeout(() => setSlowScan(true), 8000);
    return () => window.clearTimeout(timer);
  }, [scanning]);
  const lock = useRef(false);
  const interacted = useRef(false);
  const unsent = useRef("");

  const view = claiming ? "save" : preview || scanning ? "chat" : "site";
  const heading = useRef<HTMLHeadingElement>(null);
  const siteInput = useRef<HTMLInputElement>(null);
  const shown = useRef(view);
  useEffect(() => {
    if (shown.current === view) return;
    shown.current = view;
    // A restored preview leaves focus where the visitor put it.
    if (!interacted.current) return;
    (view === "site" ? siteInput.current : heading.current)?.focus();
  }, [view]);

  function showPreview(value: Preview) {
    restart.current = false;
    setPreview(value);
    setBrand(value.brand);
    setSite(value.site);
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

  function reset() {
    restart.current = true;
    interacted.current = true;
    setPreview(null);
    setBrand(null);
    setClaiming("");
    setError(null);
  }
  async function run(
    action: string,
    work: () => Promise<void>,
    at: Failure["at"] = "page",
  ) {
    if (lock.current) return;
    lock.current = true;
    interacted.current = true;
    setBusy(action);
    setError(null);
    try {
      await work();
    } catch (reason) {
      if (!isChatSignInCanceled(reason))
        setError({ text: errorText(reason), at });
      if (reason instanceof CommunityApiError && reason.status === 410) {
        restart.current = true;
        setPreview(null);
        setBrand(null);
        setClaiming("");
      }
    } finally {
      lock.current = false;
      setBusy("");
    }
  }
  function start(event: FormEvent) {
    event.preventDefault();
    void run("start", async () => {
      setSlowScan(false);
      const scan = () =>
        communityFetch<Preview>("/onboarding/start", {
          site,
          restart: restart.current,
        });
      try {
        showPreview(await scan());
      } catch (reason) {
        // An earlier preview in this browser holds another website. This one replaces it.
        if (
          !(reason instanceof CommunityApiError) ||
          reason.status !== 409 ||
          restart.current
        )
          throw reason;
        restart.current = true;
        showPreview(await scan());
      }
    });
  }
  const edited =
    !!preview &&
    !!brand &&
    (brand.name !== preview.brand.name ||
      brand.logo !== preview.brand.logo ||
      brand.accent !== preview.brand.accent);
  async function confirmBrand() {
    if (!brand || !preview) throw new Error("Enter your website first.");
    if (preview.confirmed && !edited) return preview;
    const result = await communityFetch<Preview>("/onboarding/confirm", {
      ...brand,
      previewId: preview.previewId,
    });
    showPreview(result);
    return result;
  }
  function applyBrand(event: FormEvent) {
    event.preventDefault();
    void run(
      "brand",
      async () => {
        await confirmBrand();
      },
      "brand",
    );
  }
  async function ask(
    question: string,
    requestId: string,
    onReceipt: () => void,
  ): Promise<string> {
    if (lock.current || !preview || !brand)
      throw new Error("The preview is not ready.");
    // The widget's own Retry reaches this without the composer's checks.
    const blocked = !preview.ready
      ? "AI couldn’t read this page."
      : !preview.remaining
        ? "You’ve used your free AI questions."
        : !brand.name.trim()
          ? "Enter a chat name."
          : "";
    if (blocked) {
      setError({ text: blocked, at: "chat" });
      throw new Error(blocked);
    }
    lock.current = true;
    setBusy("ask");
    setError(null);
    let sent = false;
    try {
      // Unfinished appearance edits wait for Apply or Save. They cannot fail a question.
      const current = preview.confirmed ? preview : await confirmBrand();
      sent = true;
      const reply = await communityFetch<{
        answer: string | null;
        remaining: number;
      }>(
        "/onboarding/ask",
        { question, requestId, previewId: current.previewId, receipt: true },
        undefined,
        onReceipt,
      );
      setPreview({ ...current, remaining: reply.remaining });
      return (
        reply.answer ||
        "I can’t answer that from your website or docs. In your live chat, I’d hand it to your team."
      );
    } catch (reason) {
      const latest = await communityFetch<Restored>(
        "/onboarding/read",
        {},
      ).catch(() => null);
      if (latest && "brand" in latest) setPreview(latest);
      if (reason instanceof CommunityApiError && reason.status === 410) reset();
      // The widget shows its own line for a refused question and deletes the draft.
      if (!sent || !refusedSecret(reason))
        setError({ text: errorText(reason), at: "chat" });
      throw reason;
    } finally {
      lock.current = false;
      setBusy("");
    }
  }
  function save() {
    void run("signin", async () => {
      if (!claiming) await confirmBrand();
      const session = await auth.signIn();
      setBusy("save");
      trackEvent("create_submitted");
      try {
        const { id } = await communityFetch<{ id: string }>(
          "/onboarding/claim",
          {
            previewId: claiming || preview?.previewId,
            expectedPrincipalId: session.principalId,
          },
        );
        trackEvent("create_completed");
        router.push("/inbox/" + id + "?tab=" + (nextPlan ? "plan" : "home"));
      } catch (reason) {
        // Once an account holds the preview, the service accepts only its save.
        const latest = await communityFetch<Restored>(
          "/onboarding/read",
          {},
        ).catch(() => null);
        if (latest && "claiming" in latest) {
          setClaiming(latest.previewId);
          setPreview(null);
          setBrand(null);
        }
        throw reason;
      }
    });
  }
  const disabled = !!busy || !available;
  const named = !!brand?.name.trim();
  const host = preview ? siteHost(preview.site) : "";
  // The fallback names the scanned website, so editing the chat name cannot change it.
  const suggestion =
    preview?.suggestion || (host ? "What can I do with " + host + "?" : "");
  return (
    <div className={styles.page}>
      <section className={styles.main} aria-labelledby="create-title">
        <h1 id="create-title" ref={heading} tabIndex={-1}>
          {view === "save"
            ? "Save your workspace"
            : view === "chat"
              ? "Try your support chat"
              : "Try Templ with your website"}
        </h1>
        {view === "site" && (
          <>
            <p className={styles.lede}>
              See your chat and ask AI about your site. No sign-in needed.
            </p>
            <form className={styles.form} onSubmit={start}>
              <Field label="Your website" error={error?.text}>
                <input
                  ref={siteInput}
                  className={ui.input}
                  autoComplete="url"
                  inputMode="url"
                  enterKeyHint="go"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="example.com"
                  value={site}
                  onChange={(e) => {
                    interacted.current = true;
                    setSite(e.target.value);
                    setError(null);
                  }}
                  maxLength={2048}
                  required
                />
              </Field>
              <button
                className={"button " + styles.submit}
                disabled={disabled || !site.trim()}
              >
                Preview your chat <IconArrowRight aria-hidden />
              </button>
            </form>
            <p className={styles.terms}>
              <Link href={"/create?manual=1" + (nextPlan ? "&next=plan" : "")}>
                Set up without a website
              </Link>
            </p>
          </>
        )}
        {view === "chat" && (
          <>
            {scanning && (
              <div
                className={styles.scanMessage}
                role="status"
                aria-atomic="true"
              >
                <strong className={styles.activityStatus}>
                  <ActivityDots />
                  {slowScan
                    ? "Still reading your website…"
                    : "Looking for your logo and docs…"}
                </strong>
                <span>You can write your first question while you wait.</span>
              </div>
            )}
            <WebsitePracticeChat
              name={brand?.name.trim() || siteHost(site) || "Your team"}
              accent={brand?.accent}
              icon={
                preview && brand?.logo === preview.brand.logo
                  ? preview.icon
                  : ""
              }
              canSend={
                !disabled && !!preview?.ready && preview.remaining > 0 && named
              }
              scanning={scanning}
              suggestion={suggestion}
              draft={unsent}
              ask={ask}
            />
            {preview && (
              <p className={styles.practiceNote}>
                <span className={styles.activityStatus} role="status">
                  {!preview.ready
                    ? "AI couldn’t read this page."
                    : preview.remaining +
                      " of " +
                      PRODUCT_LIMITS.freeAiPracticeQuestions +
                      " free questions left"}
                </span>
                {!preview.ready && (
                  <button
                    type="button"
                    className={styles.textButton}
                    disabled={disabled}
                    onClick={reset}
                  >
                    Try a public docs page
                  </button>
                )}
                <a
                  href="https://docs.usetempl.com/ai#practice-privacy"
                  target="_blank"
                  rel="noreferrer"
                >
                  Who processes my questions?
                </a>
              </p>
            )}
            {error?.at === "chat" && (
              <Callout className={styles.feedback} tone="danger" role="alert">
                {error.text}
              </Callout>
            )}
          </>
        )}
        {view === "chat" && preview && brand && (
          <>
            <form className={styles.brandForm} onSubmit={applyBrand}>
              <fieldset className={styles.brandFields} disabled={disabled}>
                <legend>Chat appearance</legend>
                <Field label="Chat name" error={!named && "Enter a chat name."}>
                  <input
                    className={ui.input}
                    required
                    maxLength={80}
                    value={brand.name}
                    onChange={(e) => setBrand({ ...brand, name: e.target.value })}
                  />
                </Field>
                <Field
                  label="Icon URL"
                  optional
                  hint={
                    brand.logo && brand.logo !== preview.brand.logo
                      ? "Apply changes to see this icon."
                      : undefined
                  }
                >
                  <input
                    className={ui.input}
                    type="url"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    value={brand.logo}
                    placeholder="https://example.com/icon.png"
                    onChange={(e) => setBrand({ ...brand, logo: e.target.value })}
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
              </fieldset>
              <button
                className="button secondary"
                disabled={disabled || !edited || !named}
              >
                {busy === "brand" && <ActivityDots />}
                {busy === "brand" ? "Applying…" : "Apply changes"}
              </button>
              {error?.at === "brand" && (
                <Callout className={styles.feedback} tone="danger" role="alert">
                  {error.text}
                </Callout>
              )}
            </form>
            <button
              type="button"
              className={styles.textButton}
              disabled={disabled}
              onClick={reset}
            >
              Change website
            </button>
          </>
        )}
        {(view === "save" || preview) && (
          <div className={styles.save}>
            <button
              type="button"
              className="button"
              disabled={disabled || auth.restoring || (!!brand && !named)}
              onClick={save}
            >
              {(busy === "signin" || busy === "save") && <ActivityDots />}
              {busy === "save"
                ? "Saving your workspace…"
                : auth.session
                  ? "Save workspace"
                  : "Sign in to keep your workspace"}
            </button>
          </div>
        )}
        {view === "save" && (
          <button
            type="button"
            className={styles.textButton}
            disabled={disabled}
            onClick={reset}
          >
            Change website
          </button>
        )}
        {!available && (
          <Callout className={styles.feedback} role="status">
            Workspace setup is unavailable. Try again later.
          </Callout>
        )}
        {view !== "site" && error?.at === "page" && (
          <Callout className={styles.feedback} tone="danger" role="alert">
            {error.text}
          </Callout>
        )}
      </section>
    </div>
  );
}
