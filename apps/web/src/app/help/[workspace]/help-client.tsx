"use client";

import { CRYPTO_SUPPORT_WORKSPACE } from "@templ/chat/support-models";
import { CRYPTO_DESK, cryptoDeskLink, cryptoDeskSources } from "@/lib/crypto-desk";
import { addCryptoChatMenu, addOwnChatMenu } from "@/lib/support-widget-visitor-menu";
import { useRelease } from "@/lib/release-context";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CryptoChatLanguageStore } from "@/lib/crypto-chat-language";
import type { cryptoLanguagePickers } from "@/lib/crypto-chat-language-picker";
import type { localizeCryptoChat } from "@/lib/crypto-chat-localizer";
import type { CryptoChatString } from "@/lib/crypto-chat-strings";
import type { cryptoVoiceNotes } from "@/lib/crypto-voice-loader";
import { loadTemplSupportWidget } from "@/lib/templ-support";
import { currentWidgetAssets } from "@/lib/current-widget-assets";
import { hostedGuestReturn } from "@/lib/hosted-guest-return";
import { claimHostedPolicyRead } from "@/lib/hosted-policy-read";
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
const unsubscribed = () => () => {};
export type HostedSupportChatProps = {
  workspace: string;
  name: string;
  nonce?: string;
  frameRequired: boolean;
  verifiedSites?: string[];
};

type LanguageControls = {
  store: CryptoChatLanguageStore;
  pickers: typeof cryptoLanguagePickers;
  localize: typeof localizeCryptoChat;
  voiceNotes: typeof cryptoVoiceNotes;
};

export function HostedSupportChat({
  workspace, name, nonce, frameRequired, verifiedSites = [], languageControls,
}: HostedSupportChatProps & { languageControls?: LanguageControls }) {
  const release = useRelease();
  const signInNetworks = widgetSignInNetworks(release);
  const ownSupport = workspace === release.templSupport?.workspaceId;
  const cryptoDesk = workspace === CRYPTO_SUPPORT_WORKSPACE;
  const language = languageControls?.store;
  const languageState = useSyncExternalStore(language?.subscribe ?? unsubscribed, () => language?.state, () => undefined);
  const t = (text: CryptoChatString) => languageState?.strings.get(text) ?? text;
  const foreign = languageState?.enabled && languageState.shown.code !== "en" ? languageState.shown : undefined;

  const [accent, setAccent] = useState<WidgetAccent>();
  const container = useRef<HTMLDivElement>(null);
  const widget = useRef<ReturnType<typeof mountSupportWidget> | null>(null);
  const policyRead = useRef<typeof fetch | undefined>(undefined);
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
    let localized: (() => void) | undefined;
    async function load() {
      const wallet = supportPageWallet(currentNetwork.current);
      // The page's HTML started the widget's first policy read. This chat
      // takes it once, so a retry or a later page reads again.
      if (!frameRequired) policyRead.current ??= claimHostedPolicyRead(workspace);
      const policyFetch = frameRequired ? undefined : policyRead.current;
      const transport = language?.transport(policyFetch) ?? policyFetch;
      const returning = frameRequired ? undefined : hostedGuestReturn(
        workspace, currentWidgetAssets.sourceSha256.slice(0, 16), wallet, opening.signal, undefined, transport,
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
      const motion = cryptoDesk ? window.matchMedia("(prefers-reduced-motion: reduce)") : undefined;
      const deskLogo = () => motion?.matches ? CRYPTO_DESK.stillLogo : CRYPTO_DESK.logo;
      mounted = widgetModule.mountSupportWidget({
        workspace,
        apiUrl: SITE.community,
        container: container.current,
        wallet,
        walletForNetwork: family => (cryptoDesk && !frameRequired) || signInNetworks.includes(family) ? supportPageWallet(family) : null,
        ...(cryptoDesk && !frameRequired ? {
          verifyBitcoin: async host => (await import("@/lib/support-page-bitcoin")).verifyBitcoin(host),
        } : {}),
        accountWalletRequired: setAccountWalletRequired,
        styleNonce: nonce,
        appearanceChanged: (saved) => setAccent(saved.accent),
        label: cryptoDesk ? CRYPTO_DESK.name : name,
        ...(cryptoDesk ? {
          intro: { title: "Ask about Bitcoin, Solana, Ethereum, layer 2s, DeFi or wallets." },
          appearance: { logo: deskLogo() },
          walletShareHint: "Share a wallet to ask about its activity in this chat. You can also paste any public address.",
        } : {}),
        ...(cryptoDesk && !frameRequired ? { namedLinks: cryptoDeskLink, reviewSources: cryptoDeskSources, confirmCryptoTransactionLinks: true } : {}),
        chatFirst: true,
        transactionField: false,
        guestPath: `/help/${workspace}`,
        conversationDrawers: true,
        ...(!frameRequired && (ownSupport || cryptoDesk) ? {
          decorateOwnMenu: cryptoDesk ? (host, actions) => {
            const refresh = addCryptoChatMenu(host, actions);
            const pickers = languageControls?.pickers(host, actions, languageControls.store);
            // Requests carry the same build id as this page's other widget requests.
            const voiceNotes = languageControls?.voiceNotes(
              host, languageControls.store, currentWidgetAssets.sourceSha256.slice(0, 16),
            );
            return () => {
              refresh();
              pickers?.();
              voiceNotes?.();
            };
          } : addOwnChatMenu,
        } : {}),
      }, transport && { fetch: transport }, returning);
      motion?.addEventListener("change", () => mounted?.setAppearance({ logo: deskLogo() }), { signal: opening.signal });
      const shadow = container.current.querySelector("[data-templ-support]")?.shadowRoot;
      if (languageControls && shadow) localized = languageControls.localize(shadow, languageControls.store);
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
      localized?.();
      localized = undefined;
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
      localized?.();
      mounted?.destroy();
      opening.abort();
      widget.current = null;
    };
  }, [workspace, name, nonce, frameRequired, retry, signInNetworks, ownSupport, cryptoDesk, language, languageControls]);
  return (
    <SupportChatFrame workspace={workspace} accent={accent} label={cryptoDesk ? t(CRYPTO_DESK.name) : `Support for ${name}`}
      siteAppearance={ownSupport} lang={foreign?.code} dir={foreign?.dir}>
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
          aria-label={t("Wallet network")}
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
              {t(value === "evm" ? "EVM wallet" : "Solana wallet")}
            </button>
          ))}
        </div>
      )}
      {state !== "ready" && <SupportChatLoading name={cryptoDesk ? t(CRYPTO_DESK.name) : name}
        logo={cryptoDesk ? CRYPTO_DESK.logo : undefined}
        reducedMotionLogo={cryptoDesk ? CRYPTO_DESK.stillLogo : undefined}
        translate={foreign && (text => languageState?.strings.get(text) ?? text)}
        retry={state === "failed" ? () => { setState("loading"); setRetry(value => !value); } : undefined} />}
      <div
        ref={container}
        hidden={state !== "ready"}
        className={styles.chat}
        aria-label={t("Support conversation")}
      />
    </SupportChatFrame>
  );
}
