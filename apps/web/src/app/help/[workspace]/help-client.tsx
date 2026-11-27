"use client";

import { CRYPTO_SUPPORT_WORKSPACE } from "@templ/chat/support-models";
import { addCryptoChatMenu, addOwnChatMenu } from "@/lib/support-widget-visitor-menu";
import { useRelease } from "@/lib/release-context";
import { useEffect, useRef, useState } from "react";
import { loadTemplSupportWidget } from "@/lib/templ-support";
import { currentWidgetAssets } from "@/lib/current-widget-assets";
import { hostedGuestReturn } from "@/lib/hosted-guest-return";
import { supportPageWallet } from "@/lib/support-page-wallet";
import type { mountSupportWidget } from "@/lib/support-widget";
import { SITE } from "@/lib/site-environment";
import { widgetSignInNetworks } from "@/lib/support-availability";
import { trackEvent } from "@/lib/analytics";
import { SupportChatFrame, SupportChatLoading } from "./support-chat-frame";
import type { WidgetAccent } from "@/lib/support-widget-appearance";
import { useHostedComposerFocus } from "./use-hosted-composer-focus";
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
  const signInNetworks = widgetSignInNetworks(release);
  const ownSupport = workspace === release.templSupport?.workspaceId;
  const cryptoDesk = workspace === CRYPTO_SUPPORT_WORKSPACE;

  const [accent, setAccent] = useState<WidgetAccent>();
  const container = useRef<HTMLDivElement>(null);
  const widget = useRef<ReturnType<typeof mountSupportWidget> | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  useHostedComposerFocus(container, state === "ready", frameRequired ? widget : undefined);
  const [retry, setRetry] = useState(false);
  const [accountWalletRequired, setAccountWalletRequired] = useState(false);
  const [network, setNetwork] = useState(signInNetworks[0]);
  const currentNetwork = useRef(network);
  useEffect(() => {
    const opening = new AbortController();
    let disposed = false;
    let mounted: ReturnType<typeof mountSupportWidget> | undefined;
    async function load() {
      const wallet = supportPageWallet(currentNetwork.current);
      const returning = frameRequired ? undefined : hostedGuestReturn(
        workspace, currentWidgetAssets.sourceSha256.slice(0, 16), wallet, opening.signal,
      );
      let widgetModule: WidgetModule;
      if (frameRequired) {
        const asset = currentWidgetAssets.framehost?.path;
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
        wallet,
        walletForNetwork: family => signInNetworks.includes(family) ? supportPageWallet(family) : null,
        accountWalletRequired: setAccountWalletRequired,
        styleNonce: nonce,
        appearanceChanged: (saved) => setAccent(saved.accent),
        label: name,
        ...(cryptoDesk ? {
          intro: { title: "Ask about Bitcoin, Solana, Ethereum, layer 2s, DeFi or wallets." },
        } : {}),
        chatFirst: true,
        transactionField: false,
        guestPath: `/help/${workspace}`,
        conversationDrawers: true,
        ...(!frameRequired && (ownSupport || cryptoDesk) ? {
          decorateOwnMenu: cryptoDesk ? addCryptoChatMenu : addOwnChatMenu,
        } : {}),
      }, undefined, returning);
      widget.current = mounted;
      await mounted.open(false);
      if (disposed) return;
      const root = container.current?.querySelector("[data-templ-support]")?.shadowRoot;
      if (!frameRequired && (!root || root.querySelector(".error")?.textContent))
        throw new Error("The conversation could not load.");
      trackEvent("hosted_support_opened");
      setState("ready");
    }
    void load().catch(() => {
      if (disposed) return;
      mounted?.destroy();
      opening.abort();
      mounted = undefined;
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
      opening.abort();
      widget.current = null;
    };
  }, [workspace, name, nonce, frameRequired, retry, signInNetworks, ownSupport, cryptoDesk]);
  return (
    <SupportChatFrame workspace={workspace} accent={accent} label={`Support for ${name}`} siteAppearance={ownSupport}>
      {!cryptoDesk && state === "ready" && (
        <p className={styles.channelInfo}>
          {verifiedSites.length ? <>Verified sites{": "}{verifiedSites.map((site, i) => (
            <span key={site}>{i > 0 && ", "}<a href={site} rel="noreferrer">{new URL(site).hostname}</a></span>
          ))}</> : "This workspace has no verified website."}
        </p>
      )}
      {state === "ready" && (frameRequired || accountWalletRequired) && signInNetworks.length > 1 && (
        <div
          className={styles.network}
          role="group"
          aria-label="Wallet network"
        >
          {signInNetworks.map((value) => (
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
      {cryptoDesk && (
        <footer className={styles.cryptoFooter}>
          <a href="/create" target="_blank" rel="noopener noreferrer">
            Get this chat for your site <span aria-hidden="true">↗</span>
          </a>
        </footer>
      )}
    </SupportChatFrame>
  );
}
