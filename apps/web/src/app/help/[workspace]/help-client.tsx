"use client";

import { addOwnChatMenu } from "@/lib/support-widget-visitor-menu";
import { useRelease } from "@/lib/release-context";
import { useEffect, useRef, useState } from "react";
import { loadTemplSupportWidget } from "@/lib/templ-support";
import { SUPPORT_WIDGET_LATEST } from "@/lib/support-widget-release";
import { supportPageWallet } from "@/lib/support-page-wallet";
import type { mountSupportWidget } from "@/lib/support-widget";
import { SITE } from "@/lib/site-environment";
import { widgetSignInNetworks } from "@/lib/support-availability";
import { trackEvent } from "@/lib/analytics";
import { SupportChatFrame, SupportChatLoading } from "./support-chat-frame";
import type { WidgetAccent } from "@/lib/support-widget-appearance";
import styles from "./help.module.css";

type WidgetModule = { mountSupportWidget: typeof mountSupportWidget };
export function HostedSupportChat({
  workspace,
  name,
  nonce,
  frameRequired,
  verifiedSites = [],
}: {
  workspace: string;
  name: string;
  nonce?: string;
  frameRequired: boolean;
  verifiedSites?: string[];
}) {
  const release = useRelease();
  const WIDGET_SIGN_IN_NETWORKS = widgetSignInNetworks(release);

  const [accent, setAccent] = useState<WidgetAccent>();
  const container = useRef<HTMLDivElement>(null);
  const widget = useRef<ReturnType<typeof mountSupportWidget> | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [retry, setRetry] = useState(false);
  const [accountWalletRequired, setAccountWalletRequired] = useState(false);
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
        walletForNetwork: family => widgetSignInNetworks(release).includes(family) ? supportPageWallet(family) : null,
        accountWalletRequired: setAccountWalletRequired,
        styleNonce: nonce,
        appearanceChanged: (saved) => setAccent(saved.accent),
        label: name,
        chatFirst: true,
        guestPath: `/help/${workspace}`,
        conversationDrawers: true,
        ...(workspace === release.templSupport?.workspaceId && !frameRequired ? { decorateOwnMenu: addOwnChatMenu } : {}),
      });
      widget.current = mounted;
      await mounted.open(false);
      if (disposed) return;
      const root = container.current?.querySelector("[data-templ-support]")?.shadowRoot;
      if (!frameRequired && (!root || root.querySelector(".error")?.textContent))
        throw new Error("The conversation could not load.");
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
  }, [workspace, name, nonce, frameRequired, retry, release]);
  return (
    <SupportChatFrame workspace={workspace} accent={accent} label={`Support for ${name}`} siteAppearance={workspace === release.templSupport?.workspaceId}>
      {state === "ready" && <details className={styles.channelInfo}>
        <summary>About this support link</summary>
        {verifiedSites.length ? <p>Verified sites: {verifiedSites.map(site => <a key={site} href={site} rel="noreferrer">{new URL(site).hostname} </a>)}</p>
          : <p>Templ has not verified a website for this workspace.</p>}
      </details>}
      {state === "ready" && (frameRequired || accountWalletRequired) && WIDGET_SIGN_IN_NETWORKS.length > 1 && (
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
      {state !== "ready" && <SupportChatLoading name={name}
        retry={state === "failed" ? () => { setState("loading"); setRetry(value => !value); } : undefined} />}
      <div
        ref={container}
        hidden={state !== "ready"}
        className={styles.chat}
        aria-label="Support conversation"
      />
    </SupportChatFrame>
  );
}
