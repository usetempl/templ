import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath, URL } from "node:url";
import { resolve } from "node:path";
import { expect } from "vitest";
import { simulate } from "@templ/chat/simulation.test.helpers";
import { CRYPTO_LANGUAGES, cryptoLanguage } from "@templ/chat/crypto-languages";
import { CRYPTO_CHAT_STRINGS } from "./crypto-chat-strings";
import { checkedLanguageBundle } from "./crypto-chat-language";

const directory = fileURLToPath(new URL("../../public/chat-languages/", import.meta.url));
const sourceHeadings = JSON.parse(readFileSync(resolve(directory, "../../../workers/community/src/crypto-source-headings.json"), "utf8"));
const serviceReplies: Record<string, Record<string, string>> = JSON.parse(readFileSync(resolve(directory, "../../../workers/community/src/managed-agent/crypto-service-translations.json"), "utf8"));
const sourceReview = JSON.parse(readFileSync(new URL("../../test/fixtures/crypto-chat-language-review.json", import.meta.url), "utf8"));
const voiceReview = JSON.parse(readFileSync(new URL("../../test/fixtures/crypto-voice-language-review.json", import.meta.url), "utf8"));
const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const emergency = "Emergency help for a scam or hack";
const fields = (text: string) => (text.match(/\{[a-zA-Z][\w]*\}/g) ?? []).sort();

simulate("every language offered by the crypto desk can render its full interface offline", draw => {
  expect(sourceReview.fixedRepliesSha256).toBe(digest(resolve(directory, "../../../workers/community/src/managed-agent/crypto-service-translations.json")));
  expect(sourceReview.locales).toHaveLength(sourceReview.translatedLocales);
  expect(voiceReview.translatedLocales).toBe(sourceReview.translatedLocales);
  const priorVoice = readFileSync(new URL("../../test/fixtures/crypto-voice-language-review-2026-11-27.json", import.meta.url));
  expect(createHash("sha256").update(priorVoice).digest("hex")).toBe(voiceReview.previousReview.sha256);
  expect(voiceReview.interfaceStringsPerLocale).toBe(sourceReview.interfaceStringsPerLocale + voiceReview.voiceStringsPerLocale);
  for (const { code, sha256 } of voiceReview.locales) {
    expect(digest(resolve(directory, code + ".json")), code).toBe(sha256);
  }
  const codes = CRYPTO_LANGUAGES.map(language => language.code);
  expect(new Set(codes).size).toBe(codes.length);
  expect(readdirSync(directory).sort()).toEqual(codes.filter(code => code !== "en").map(code => code + ".json").sort());
  const english = [...new Set(CRYPTO_CHAT_STRINGS)].sort();
  for (const code of draw.shuffle(codes.filter(code => code !== "en"))) {
    const pack = JSON.parse(readFileSync(resolve(directory, code + ".json"), "utf8")) as Record<string, string>;
    expect(Object.keys(pack).sort(), code).toEqual(english);
    expect(sourceHeadings[code], code).toBe(pack["Sources:"]);
    const emergencyReply = Object.entries(serviceReplies[code]).find(([english]) => english.includes(emergency))?.[1];
    expect(emergencyReply?.normalize().toLowerCase(), code).toContain(pack[emergency].normalize().toLowerCase());
    expect(checkedLanguageBundle(pack).size, code).toBe(english.length);
    for (const source of english) {
      const text = pack[source];
      if (typeof text !== "string" || !text.trim() || /https?:\/\/|www\.|0x[a-f\d]{40}/i.test(text) || /<\/?[a-z][\s\S]*>/i.test(text) ||
          JSON.stringify(fields(text)) !== JSON.stringify(fields(source)))
        throw new Error(`Invalid translation for ${code}: ${source}`);
    }
    expect(cryptoLanguage(code)?.native.trim()).toBeTruthy();
  }
}, { runs: 1 });
