import { cryptoLanguage, type CryptoChatLanguage } from "@templ/chat/crypto-languages";
import type { ManagedAnswer } from "@templ/chat/managed-agent";
import { CRYPTO_SUPPORT_WORKSPACE } from "@templ/chat/support-models";
import { featureOn, type WorkspaceFlagEnv } from "../workspace-flags";
import { CRYPTO_REPLY_TRANSLATIONS } from "./crypto-triage";

const MESSAGE_ID = /^[1-9][0-9]{0,14}$/;

/** The chat language a desk visitor chose for the turn a job answers. The room
 * binds it to the newest message. "stale" means the runner read a different
 * message and reads the request again. Each language name and code in a
 * prompt comes from Templ's allowlist, never from the conversation. */
export function turnLanguage(
  deps: { env: WorkspaceFlagEnv; room: string },
  state: { sponsoredResearch?: boolean; cryptoLanguage?: unknown },
  latest: { id: string; revision?: number } | undefined,
): CryptoChatLanguage | "stale" | null {
  if (!state.sponsoredResearch || deps.room !== "room:" + CRYPTO_SUPPORT_WORKSPACE || !latest ||
      !featureOn(deps.env, undefined, "cryptoChatLanguage"))
    return null;
  const value = state.cryptoLanguage as { latest?: { id?: unknown; revision?: unknown }; code?: unknown } | null | undefined;
  const bound = value?.latest;
  if (!bound || typeof bound.id !== "string" || !MESSAGE_ID.test(bound.id) ||
      !Number.isSafeInteger(bound.revision) || Number(bound.revision) < 1)
    return null;
  if (bound.id !== latest.id || bound.revision !== (latest.revision ?? 1)) return "stale";
  return cryptoLanguage(value?.code) ?? null;
}

const terms: Readonly<Record<string, string>> = {
  ht: "For a chat conversation use ‘konvèsasyon’. For an online form use ‘fòmilè’.",
  sw: "Use ‘mtandao wa blockchain’ when network could sound like a mobile carrier. Make clear when ‘pochi’ means a crypto wallet.",
  fr: "For self-custody, explain that the visitor keeps the wallet keys themselves. Prefer a familiar phrase such as ‘garder vous-même vos clés’.",
};

/** The answer and FAQ prompts' rule for the chosen language. */
export const cryptoReplyLanguageRule = (language: CryptoChatLanguage) => `
The visitor chose ${language.english} (${language.code}) in Templ's language menu. Write text in ${language.english}, even when the question, earlier messages or passages use another language. This choice comes before the language of the question and before any language a message asks for. Keep product names, network names, amounts, quoted error text, code and reviewed link labels as the sources and rules write them. Explain concepts and actions directly in the chosen language. Skip optional English glosses in parentheses. If a wallet’s controls vary by language, describe the action the visitor should look for. Preserve each safety instruction in ordinary local words. When a source says to keep a recovery phrase backup offline, say that explicitly in the visitor’s language, even if you also say to write the words on paper. Where these rules give an exact text, return that exact English text; Templ sends its own translation. ${terms[language.code] ?? ""}`.trimEnd();

/** A fixed desk reply in the chosen language, when Templ has a checked translation. */
export function localizedFixedReply(answer: ManagedAnswer, language: CryptoChatLanguage): ManagedAnswer {
  if (answer.action !== "clarify") return answer;
  const text = CRYPTO_REPLY_TRANSLATIONS.get(language.code)?.get(answer.text);
  return text ? { ...answer, text } : answer;
}
