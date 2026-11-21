"use client";

import { useEffect, useRef, useState } from "react";
import { CONVERSATION_STYLE } from "@/lib/support-widget-chat-style";
import type {
  SupportDemoOptions,
  SupportWidgetAppearance,
  mountSupportDemo,
} from "@/lib/support-widget";

/** The renderer protocol teams install, with an in-memory demo transport.
 * It loads on first use so the page doesn't carry it up front. */
export function SupportWidgetDemo({
  className,
  label,
  onMessage,
  appearance,
  onError,
  previewLauncher = false,
  scenario,
  animateScenario = false,
  presentation = false,
}: {
  className?: string;
  label?: string;
  onMessage?: SupportDemoOptions["onMessage"];
  appearance?: SupportWidgetAppearance;
  onError?: () => void;
  previewLauncher?: boolean;
  scenario?: SupportDemoOptions["scenario"];
  animateScenario?: boolean;
  presentation?: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const listener = useRef(onMessage);
  const errorListener = useRef(onError);
  const currentAppearance = useRef(appearance);
  const widget = useRef<ReturnType<typeof mountSupportDemo>>(undefined);
  useEffect(() => {
    listener.current = onMessage;
    errorListener.current = onError;
    currentAppearance.current = appearance;
    widget.current?.setAppearance(appearance ?? {});
  }, [onMessage, onError, appearance]);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  useEffect(() => {
    let active = true;
    let demo: ReturnType<typeof mountSupportDemo> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let authorObserver: MutationObserver | undefined;
    void Promise.race([
      import("@/lib/support-widget"),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Chat could not load.")),
          10_000,
        );
      }),
    ])
      .then((module) => {
        if (!active || !container.current) return;
        demo = module.mountSupportDemo(container.current, {
          label,
          appearance: currentAppearance.current,
          previewLauncher,
          scenario,
          onMessage: (message) => listener.current?.(message),
        });
        const root = container.current.firstElementChild?.shadowRoot;
        if (root) {
          if (scenario === "conversation") {
            root.querySelector(".panel")?.classList.add("conversation-chat");
            const labelExample = () => {
              const subtitle = root.querySelector(".sub");
              if (subtitle && subtitle.textContent !== "You, Templ AI, Founder")
                subtitle.textContent = "You, Templ AI, Founder";
              for (const author of root.querySelectorAll(
                ".message:not(.own) > small",
              ))
                if (author.firstChild?.textContent === "AI agent")
                  author.firstChild.textContent = "Templ AI";
            };
            labelExample();
            authorObserver = new MutationObserver(labelExample);
            authorObserver.observe(root, { childList: true, subtree: true });
          }
          if (presentation && scenario === "failed-transaction") {
            const title = root.querySelector(".titles strong");
            if (title) title.textContent = label ?? "Templ support";
            root
              .querySelector(".panel")
              ?.setAttribute("aria-label", label ?? "Templ support");
            root.querySelector(".demo-notice")?.remove();
            root.querySelector(".panel")?.removeAttribute("aria-description");
            const nameTeam = () => {
              for (const author of root.querySelectorAll(
                ".message:not(.own) > small",
              ))
                if (author.firstChild?.textContent === "Sample app")
                  author.firstChild.textContent = "Support team";
            };
            nameTeam();
            authorObserver = new MutationObserver(nameTeam);
            authorObserver.observe(root, { childList: true, subtree: true });
          }
          const style = document.createElement("style");
          style.textContent =
            (scenario === "conversation"
              ? CONVERSATION_STYLE +
                ".panel[data-demo=conversation]{height:100%;min-height:0;border:0;box-shadow:none;border-radius:0}.panel[data-demo=conversation] :is(.chat-options,.demo-label){display:none}.panel[data-demo=conversation] .message{animation:none}"
              : "") +
            ".avatar.logo{background:transparent;border-radius:0}.avatar.logo img{object-fit:contain}" +
            (scenario === "failed-transaction"
              ? ".panel[data-demo=failed-transaction]{border-radius:0;height:100%}.panel[data-demo=failed-transaction] .body{flex:1;min-height:0}.panel[data-demo=failed-transaction] .demo-notice{margin-top:0}"
              : "") +
            (presentation
              ? ".panel[data-demo=failed-transaction]{--b:#000;--b2:#000}.panel[data-demo=failed-transaction] .demo-context{border-width:2px;border-radius:0}.panel[data-demo=failed-transaction] .demo-result{border-radius:0}"
                + ".panel[data-demo=conversation] .body{overflow:clip;overscroll-behavior:auto;scrollbar-width:none}"
              : "") +
            (animateScenario && scenario === "failed-transaction"
              ? "@keyframes demo-step{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}" +
                "@media(prefers-reduced-motion:no-preference){" +
                ".message.own{animation:demo-step 500ms cubic-bezier(.16,1,.3,1) 250ms both}" +
                ".demo-context{animation:demo-step 600ms cubic-bezier(.16,1,.3,1) 1000ms both}" +
                ".message:not(.own){animation:demo-step 600ms cubic-bezier(.16,1,.3,1) 2100ms both}}"
              : "");
          root.append(style);
        }
        widget.current = demo;
        setStatus("ready");
      })
      .catch(() => {
        if (active) {
          console.warn("TEMPL_SUPPORT_FAILURE", {
            route: "widget-preview",
            step: "widget-load",
            cause: "chunk-load",
          });
          errorListener.current?.();
          setStatus("error");
        }
      })
      .finally(() => clearTimeout(timer));
    return () => {
      active = false;
      clearTimeout(timer);
      authorObserver?.disconnect();
      demo?.destroy();
      widget.current = undefined;
    };
  }, [
    attempt,
    label,
    previewLauncher,
    scenario,
    animateScenario,
    presentation,
  ]);
  return (
    <div className={className} style={{ position: "relative" }}>
      <div ref={container} style={{ height: "100%" }} />
      {status !== "ready" && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "grid",
            placeContent: "center",
            gap: 16,
            textAlign: "center",
          }}
        >
          <p role="status">
            {status === "error"
              ? "The chat demo could not load."
              : "Loading chat…"}
          </p>
          {status === "error" && (
            <button
              type="button"
              className="button secondary small"
              onClick={() => {
                setStatus("loading");
                setAttempt((value) => value + 1);
              }}
            >
              Try again
            </button>
          )}
        </div>
      )}
    </div>
  );
}
