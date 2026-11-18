"use client";

import { useRelease } from "@/lib/release-context";
import { useEffect, useRef, useState } from "react";
import { loadTemplSupportWidget } from "@/lib/templ-support";
import { SUPPORT_WIDGET_LATEST } from "@/lib/support-widget-release";
import { supportPageWallet } from "@/lib/support-page-wallet";
import type { mountSupportWidget } from "@/lib/support-widget";
import { SITE } from "@/lib/site-environment";
import { widgetSignInNetworks } from "@/lib/support-availability";
import { trackEvent } from "@/lib/analytics";
import styles from "./help.module.css";

type WidgetModule = { mountSupportWidget: typeof mountSupportWidget };
export function HostedSupportChat({
  workspace,
  name,
  nonce,
  frameRequired,
}: {
  workspace: string;
  name: string;
  nonce?: string;
  frameRequired: boolean;
}) {
  const WIDGET_SIGN_IN_NETWORKS = widgetSignInNetworks(useRelease());

  const container = useRef<HTMLDivElement>(null);
  const widget = useRef<ReturnType<typeof mountSupportWidget> | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [retry, setRetry] = useState(false);
  const [network, setNetwork] = useState(WIDGET_SIGN_IN_NETWORKS[0]);
  const currentNetwork = useRef(network);
  useEffect(() => {
    let disposed = false;
    let mounted: ReturnType<typeof mountSupportWidget> | undefined;
    trackEvent("hosted_support_opened");
    async function load() {
      let widgetModule: WidgetModule;
      if (frameRequired) {
        const asset = SUPPORT_WIDGET_LATEST.chunks.framehost?.path;
        if (!asset) throw new Error("Support page unavailable");
        widgetModule = await import(
          /* webpackIgnore: true */ /* turbopackIgnore: true */ new globalThis.URL(
            asset,
            window.location.origin,
          ).href
        );
      } else widgetModule = await loadTemplSupportWidget();
      if (disposed || !container.current) return;
      mounted = widgetModule.mountSupportWidget({
        workspace,
        apiUrl: SITE.community,
        container: container.current,
        wallet: supportPageWallet(currentNetwork.current),
        styleNonce: nonce,
        label: name,
        appearance: { theme: "dark", accent: "#2854c5" },
      });
      widget.current = mounted;
      mounted.open();
      setState("ready");
    }
    void load().catch(() => {
      if (disposed) return;
      setState("failed");
      trackEvent("hosted_support_failed");
      console.warn(
        JSON.stringify({
          event: "TEMPL_SUPPORT_FAILURE",
          route: "hosted-support-page",
          reason: "widget-load",
        }),
      );
    });
    return () => {
      disposed = true;
      mounted?.destroy();
      widget.current = null;
    };
  }, [workspace, name, nonce, frameRequired, retry]);
  return (
    <>
      {WIDGET_SIGN_IN_NETWORKS.length > 1 && (
        <div
          className={styles.network}
          role="group"
          aria-label="Wallet network"
        >
          {WIDGET_SIGN_IN_NETWORKS.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={network === value}
              onClick={() => {
                currentNetwork.current = value;
                setNetwork(value);
                widget.current?.setWallet(supportPageWallet(value));
                trackEvent("hosted_support_network_changed");
              }}
            >
              {value === "evm" ? "EVM wallet" : "Solana wallet"}
            </button>
          ))}
        </div>
      )}
      {state === "loading" && <p role="status">Loading support…</p>}
      {state === "failed" && (
        <div role="alert">
          <p>Support could not load.</p>
          <button
            className="button quiet"
            type="button"
            onClick={() => {
              setState("loading");
              setRetry(!retry);
            }}
          >
            Try again
          </button>
        </div>
      )}
      <div
        ref={container}
        className={styles.chat}
        aria-label="Support conversation"
      />
    </>
  );
}
