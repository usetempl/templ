"use client";

import { IconArrowRight } from "@tabler/icons-react";
import { appApprovalForm } from "@/lib/app-approval-request";
import { trackEvent } from "@/lib/analytics";

export function AppApprovalRequestButton({
  workspace,
  appUrl = "",
  className,
  services = false,
}: {
  workspace?: string;
  appUrl?: string;
  className?: string;
  services?: boolean;
}) {
  return (
    <button
      type="button"
      className={className ?? "button secondary"}
      onPointerEnter={() =>
        window.dispatchEvent(new CustomEvent("templ:prepare-support"))
      }
      onFocus={() =>
        window.dispatchEvent(new CustomEvent("templ:prepare-support"))
      }
      onClick={(event) => {
        trackEvent("app_access_requested");
        window.dispatchEvent(
          new CustomEvent("templ:open-support", {
            detail: {
              trigger: event.currentTarget,
              form: appApprovalForm({ appUrl, workspace, services }),
            },
          }),
        );
      }}
    >
      Request full access <IconArrowRight size={18} aria-hidden="true" />
    </button>
  );
}
