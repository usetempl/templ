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
import { Callout, Field, ui } from "./ui/ui";
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
  const [error, setError] = useState("");
  const [slowScan, setSlowScan] = useState(false);
  const scanning = busy === "start";
  useEffect(() => {
    if (!scanning) return;
    const timer = window.setTimeout(() => setSlowScan(true), 8000);
    return () => window.clearTimeout(timer);
  }, [scanning]);
  const lock = useRef(false);
  const interacted = useRef(false);

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
      showPreview(
        await communityFetch<Preview>("/onboarding/start", {
          site,
          restart: restart.current,
        }),
      );
    });
  }
  async function confirmBrand() {
    if (!brand || !preview) throw new Error("Enter your website first.");
    if (
      preview.confirmed &&
      brand.name === preview.brand.name &&
      brand.logo === preview.brand.logo &&
      brand.accent === preview.brand.accent
    )
      return preview;
    const result = await communityFetch<Preview>("/onboarding/confirm", {
      ...brand,
      previewId: preview.previewId,
    });
    showPreview(result);
    return result;
  }
  async function ask(question: string, requestId: string): Promise<string> {
    if (
      lock.current ||
      !preview?.ready ||
      !preview.remaining ||
      !brand?.name.trim()
    )
      throw new Error("The preview is not ready.");
    lock.current = true;
    setBusy("ask");
    setError("");
    try {
      const confirmed = await confirmBrand();
      const reply = await communityFetch<{
        answer: string | null;
        remaining: number;
      }>("/onboarding/ask", {
        question,
        requestId,
        previewId: confirmed.previewId,
      });
      setPreview({ ...confirmed, remaining: reply.remaining });
      return reply.answer || "I couldn’t find that in the website or docs.";
    } catch (reason) {
      const current = await communityFetch<Restored>(
        "/onboarding/read",
        {},
      ).catch(() => null);
      if (current && "brand" in current) setPreview(current);
      if (reason instanceof CommunityApiError && reason.status === 410) reset();
      setError(reason instanceof Error ? reason.message : "Try again.");
      throw reason;
    } finally {
      lock.current = false;
      setBusy("");
    }
  }
  function save() {
    void run("save", async () => {
      if (!claiming) await confirmBrand();
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
  const suggestion =
    preview?.suggestion ||
    (brand ? "What can I do with " + brand.name + "?" : "");
  const reset = () => {
    restart.current = true;
    interacted.current = true;
    setPreview(null);
    setBrand(null);
    setClaiming("");
    setError("");
  };
  let scanHost = "";
  if (scanning) {
    try {
      const url = site.trim().replace(/^https?:\/\//i, "");
      scanHost = new URL("https://" + url).hostname;
    } catch {
      // The server shows the validation error for an invalid address.
    }
  }
  return (
    <div className={styles.page}>
      <section className={styles.main} aria-labelledby="create-title">
        <h1 id="create-title">
          {claiming
            ? "Save your workspace"
            : preview || scanning
              ? "Try your support chat"
              : "Try Templ with your website"}
        </h1>
        {!scanning && !preview && !claiming && (
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
                  autoCorrect="off"
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
        {(scanning || (preview && brand)) && (
          <>
            {scanning && (
              <div
                className={styles.scanMessage}
                role="status"
                aria-atomic="true"
              >
                <span className={styles.scanDots} aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                <strong>
                  {slowScan
                    ? "Still reading your website…"
                    : "Looking for your logo and docs…"}
                </strong>
                <span>You can write your first question while you wait.</span>
              </div>
            )}
            <WebsitePracticeChat
              name={brand?.name.trim() || scanHost || "Your team"}
              accent={brand?.accent}
              icon={
                preview && brand?.logo === preview.brand.logo
                  ? preview.icon
                  : ""
              }
              canSend={
                !disabled &&
                !!preview?.ready &&
                preview.remaining > 0 &&
                !!brand?.name.trim()
              }
              suggestion={suggestion}
              ask={ask}
            />
            {preview && (
              <p className={styles.practiceNote} role="status">
                {preview.ready ? (
                  busy === "ask" ? (
                    "Finding an answer…"
                  ) : (
                    preview.remaining +
                    " of " +
                    PRODUCT_LIMITS.freeAiPracticeQuestions +
                    " free questions left"
                  )
                ) : (
                  <>
                    AI couldn’t read this page.{" "}
                    <button className={styles.textButton} onClick={reset}>
                      Try a public docs page
                    </button>
                  </>
                )}
                {" · "}
                <a
                  href="https://docs.usetempl.com/ai#practice-privacy"
                  target="_blank"
                  rel="noreferrer"
                >
                  Practice privacy
                </a>
              </p>
            )}
          </>
        )}
        {preview && brand && (
          <>
            <fieldset className={styles.brandFields} disabled={disabled}>
              <legend>Chat appearance</legend>
              <Field label="Chat name">
                <input
                  className={ui.input}
                  required
                  maxLength={80}
                  value={brand.name}
                  onChange={(e) => setBrand({ ...brand, name: e.target.value })}
                />
              </Field>
              <Field label="Icon URL" optional>
                <input
                  className={ui.input}
                  type="url"
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
              className={styles.textButton}
              disabled={disabled}
              onClick={reset}
            >
              Change website
            </button>
          </>
        )}
        {(claiming || preview) && (
          <div className={styles.save}>
            <button
              className="button"
              disabled={
                disabled || auth.restoring || (!!brand && !brand.name.trim())
              }
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
          <Callout className={styles.feedback} role="status">
            Workspace setup is unavailable. Try again later.
          </Callout>
        )}
        {error && (
          <Callout className={styles.feedback} tone="danger" role="alert">
            {error}
          </Callout>
        )}
      </section>
    </div>
  );
}
