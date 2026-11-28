"use client";

import { useEffect, useMemo } from "react";
import { createCryptoChatLanguage } from "@/lib/crypto-chat-language";
import { cryptoLanguagePickers } from "@/lib/crypto-chat-language-picker";
import { localizeCryptoChat } from "@/lib/crypto-chat-localizer";
import { cryptoVoiceNotes } from "@/lib/crypto-voice-loader";
import { SITE } from "@/lib/site-environment";
import { HostedSupportChat, type HostedSupportChatProps } from "./help-client";

export function CryptoHostedChat(props: HostedSupportChatProps) {
  const { workspace } = props;
  const languageControls = useMemo(() => ({
    store: createCryptoChatLanguage(workspace, SITE.community),
    pickers: cryptoLanguagePickers,
    localize: localizeCryptoChat,
    voiceNotes: cryptoVoiceNotes,
  }), [workspace]);
  useEffect(() => {
    const link = document.querySelector<HTMLAnchorElement>('a.skip-link[href="#main-content"]');
    if (!link) return;
    const original = link.textContent;
    const lang = link.lang;
    const dir = link.dir;
    const update = () => {
      const { enabled, shown } = languageControls.store.state;
      link.textContent = enabled ? languageControls.store.t("Skip to content") : original;
      link.lang = enabled ? shown.code : lang;
      link.dir = enabled ? shown.dir : dir;
    };
    update();
    const unsubscribe = languageControls.store.subscribe(update);
    return () => {
      unsubscribe();
      link.textContent = original;
      link.lang = lang;
      link.dir = dir;
    };
  }, [languageControls]);
  return <HostedSupportChat {...props} languageControls={languageControls} />;
}
