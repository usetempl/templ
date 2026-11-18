const PERSON = String.raw`(?:(?:a|an|the|a real|an actual) )?(?:person|human(?: agent)?|support team|team)`;
const REQUEST = new RegExp(
  String.raw`^(?:please )?(?:get (?:me )?${PERSON}(?: to help(?: me| us)?)?|(?:let me|I (?:want|need) to|can I|could I) (?:speak|talk|chat) (?:to|with) ${PERSON}|(?:can|could) you connect (?:me|us) (?:to|with) ${PERSON}|(?:connect|transfer) (?:me|us) (?:to|with) ${PERSON}|I (?:want|need|would like) ${PERSON}|(?:person|human) please)(?: from (?:the |your )?support team)?(?:,? please)?[.!?]{0,3}$`,
  "i",
);

/** Recognizes an explicit request only. Safety and private requests take precedence. */
export const personRequest = (text: unknown): boolean =>
  typeof text === "string" && REQUEST.test(text.replace(/\s+/g, " ").trim());
