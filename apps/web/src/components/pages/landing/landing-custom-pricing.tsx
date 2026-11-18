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
        event.preventDefault();
        window.dispatchEvent(
          new CustomEvent("templ:open-support", {
            detail: { trigger: event.currentTarget, form: quoteForm },
          }),
        );
      }}
    >
      contact us
    </a>
  );
}
