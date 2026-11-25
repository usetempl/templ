import { SITE } from "./site-environment";
import { createSupportClient, type SupportWallet } from "./support-widget";
import { ordinaryGuestReturn, supportStorageKey } from "./support-widget-return";

/** A hosted opening owns one client from the first passive wallet check through
 * the visible conversation. Its fresh bearer authorizes the selected case
 * while its controls load. The usual case and encryption rules consume it. */
export function hostedGuestReturn(
  workspace: string, build: string, wallet: SupportWallet | null, lifetime: AbortSignal,
  selected?: (principal: string) => string | undefined,
) {
  if (document.hidden || lifetime.aborted || location.hash.startsWith("#templ-guest=") || !ordinaryGuestReturn(workspace)) return;
  const key = supportStorageKey("guest", workspace);
  let credential: string | null;
  try { credential = localStorage.getItem(key); } catch { return; }
  if (!credential || !/^[0-9a-f]{64}$/.test(credential)) return;

  const client = createSupportClient({workspace, apiUrl: SITE.community, wallet}, {build});
  const messages = client.messages.bind(client);
  let page: {
    owner: NonNullable<ReturnType<typeof client.adopt>[0]>;
    id: string;
    read: ReturnType<typeof messages>;
  } | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  function discard() {
    page = undefined;
    clearTimeout(expiry);
  }
  lifetime.addEventListener("abort", () => { discard(); client.destroy(); }, {once: true});
  window.addEventListener("storage", event => {
    if (event.key === null || event.key === key || event.key === supportStorageKey("member", workspace)) {
      discard();
      client.adopt(false);
    }
  }, {signal: lifetime});
  client.onSessionChange(() => { if (page && page.owner !== client.adopt()[0]) discard(); });
  client.messages = (id, before, seen, ...view) => {
    const opening = page;
    discard();
    return opening && !before && seen && !view[0] && opening.id === id && opening.owner === client.adopt()[0]
      ? opening.read : messages(id, before, seen, ...view);
  };
  const guest = client.guest(true).then(session => {
    const owner = client.adopt()[0];
    const id = session && (selected?.(session.principalId) ?? session.thread);
    if (!id || !owner || lifetime.aborted || document.hidden) return;
    const read = messages(id, undefined, true);
    const entry = page = { owner, id, read };
    expiry = setTimeout(discard, 20_000);
    // Give mounting controls one second after completion to take this result.
    // A later opener reads again, including when the first request failed.
    function settled() {
      if (page !== entry) return;
      clearTimeout(expiry);
      expiry = setTimeout(discard, 1000);
    }
    void read.then(settled, settled);
  });
  void guest.catch(() => {});
  return {client, guest};
}
