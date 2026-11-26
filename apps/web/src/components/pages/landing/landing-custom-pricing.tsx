"use client";

import type { SupportForm } from "@/lib/support-widget-form";
import styles from "./landing-pricing.module.css";

const quoteForm: SupportForm = {
  title: "Custom pricing",
  text: "Share your app and expected case or AI usage. Our team will reply here.",
  message: "I’d like a custom pricing quote.",
  fields: [
    { id: "website", label: "App website", type: "website", required: true },
    { id: "cases", label: "Cases per month" },
    { id: "ai", label: "AI usage or needs" },
  ],
};

const prepare = () => window.dispatchEvent(new Event("templ:prepare-support"));

export function CustomPricingLink() {
  return (
    <a
      href="#support"
      className={styles.quoteLink}
      aria-haspopup="dialog"
      data-templ-conversion="talk_to_us_clicked"
      onPointerEnter={prepare}
      onFocus={prepare}
      onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        const unhandled = window.dispatchEvent(
          new CustomEvent("templ:open-support", {
            cancelable: true,
            detail: { trigger: event.currentTarget, form: quoteForm },
          }),
        );
        if (!unhandled) event.preventDefault();
      }}
    >
      Ask about volume pricing
    </a>
  );
}
