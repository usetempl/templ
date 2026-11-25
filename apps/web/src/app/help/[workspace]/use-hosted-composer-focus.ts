import { useEffect, type RefObject } from "react";

export function useHostedComposerFocus(
  container: RefObject<HTMLDivElement | null>,
  ready: boolean,
  frameWidget?: RefObject<{ open(): unknown } | null>,
) {
  useEffect(() => {
    if (!ready) return;
    const frame = requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active && active !== document.body && active !== document.documentElement)
        return;
      const root = container.current?.querySelector("[data-templ-support]")?.shadowRoot;
      const input = root?.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Message to the support team"]',
      );
      if (input && !input.disabled && input.getClientRects().length)
        input.focus({ preventScroll: true });
      else if (root?.querySelector("iframe"))
        void frameWidget?.current?.open();
    });
    return () => cancelAnimationFrame(frame);
  }, [container, ready, frameWidget]);
}
