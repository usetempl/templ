import { expect } from "vitest";
import { simulate } from "@templ/chat/simulation.test.helpers";
import { CRYPTO_LANGUAGES } from "@templ/chat/crypto-languages";
import { HOSTED_SOCIAL_REPLIES } from "@templ/chat/support-ai-interactions";
import { CRYPTO_LOOKUP_REPLIES } from "../src/managed-agent/crypto-chain-facts";
import {
  CRYPTO_CLARIFY_REPLY, CRYPTO_REPLY_TRANSLATIONS, CRYPTO_SCAM_REPLY, INVESTMENT_REFUSAL,
} from "../src/managed-agent/crypto-triage";

simulate("each selectable language can deliver every fixed crypto help desk reply", draw => {
  const choices = CRYPTO_LANGUAGES.filter(language => language.code !== "en");
  const replies = [
    CRYPTO_SCAM_REPLY, CRYPTO_CLARIFY_REPLY, INVESTMENT_REFUSAL, HOSTED_SOCIAL_REPLIES.offTopic,
    ...Object.values(CRYPTO_LOOKUP_REPLIES),
  ];
  for (const { code } of draw.shuffle(choices)) {
    const pack = CRYPTO_REPLY_TRANSLATIONS.get(code);
    for (const reply of draw.shuffle(replies))
      expect(pack?.get(reply), `${code} has no checked translation for ${reply}`).toBeTruthy();
  }
}, { runs: 1 });
