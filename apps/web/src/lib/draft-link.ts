/** "Use draft" remembers which AI draft a reply started from, per
 * conversation, until the reply is sent or the composer is cleared. The
 * next reply sent in that conversation carries it as `fromDraft`, so the
 * service records that the reply came from the draft and whether it was
 * edited. Memory only: a reload forgets it, and the reply still goes. */
const links = new Map<string, string>();

export function rememberDraftUse(conversation: string, draft: string) {
  links.set(conversation, draft);
}
export function forgetDraftUse(conversation: string) {
  links.delete(conversation);
}
/** @public The draft a reply would use; tests read it before the send. */
export function draftInUse(conversation: string): string | undefined {
  return links.get(conversation);
}
/** The draft for the reply being sent now, once. */
export function takeDraftUse(conversation: string): string | undefined {
  const draft = links.get(conversation);
  links.delete(conversation);
  return draft;
}
