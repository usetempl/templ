import { CRYPTO_SUPPORT_WORKSPACE } from "@templ/chat/support-models";
import type { CryptoChatLanguageStore } from "./crypto-chat-language";
import type { TailHost } from "./support-widget";

/** Voice notes belong to the hosted crypto desk alone, and only while its own policy
 * answer turns them on. Every other workspace and embed keeps the text composer. */
export const cryptoVoiceNotesOn = ({ options, policy }: Pick<TailHost, "options" | "policy">) =>
  Boolean(CRYPTO_SUPPORT_WORKSPACE) && options.workspace === CRYPTO_SUPPORT_WORKSPACE && !!options.container && policy?.hosted === true &&
  "cryptoVoiceNotes" in policy && policy.cryptoVoiceNotes === true;

function canRecord() {
  const allowed = (document as Document & { featurePolicy?: { allowsFeature?(name: string): boolean } })
    .featurePolicy?.allowsFeature?.("microphone");
  return globalThis.isSecureContext !== false && allowed !== false &&
    typeof AudioContext === "function" && typeof AudioWorkletNode === "function" &&
    typeof navigator.mediaDevices?.getUserMedia === "function";
}

export function cryptoVoiceNotes(host: TailHost, store: CryptoChatLanguageStore, build: string) {
  let mounted: { refresh(): void } | undefined;
  let loading = false;
  let attempts = 0;
  async function load() {
    loading = true;
    attempts++;
    try {
      const { mountCryptoVoiceNotes } = await import("./crypto-voice-notes");
      if (host.lifetime?.aborted) return;
      mounted = mountCryptoVoiceNotes(host, store, { build });
      mounted.refresh();
    } catch {
      // A later render tries again, three times at most; the text composer works meanwhile.
      loading = false;
    }
  }
  return () => {
    if (mounted) mounted.refresh();
    else if (!loading && attempts < 3 && cryptoVoiceNotesOn(host) && canRecord()) void load();
  };
}
