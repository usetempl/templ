export const TEMPL_AI_NOTICE =
  "Templ AI is in beta. If AI cannot answer, our team will reply.";

/** Keep Templ's own chat and optional sharing controls in view. */
export function mountTemplSupportToolbar(root: ShadowRoot) {
  const style = document.createElement("style");
  style.textContent =
    ".avatar.logo{background:transparent;border-radius:0}.avatar.logo img{object-fit:contain}.starter{padding:4px 0 12px;border:0;background:transparent}.tools:not(:has(>button:not([hidden]))):has(>.wallet:empty){display:none}.lead-controls{gap:4px;border-top:0;padding:0 10px 4px}.lead-controls>button{flex:1;min-width:0;min-height:36px;padding:5px 2px;font-size:13px;line-height:1.2;text-align:center}.templ-ai-notice{flex:none;margin:0;padding:8px 12px;border-bottom:1px solid var(--b);background:var(--s);color:var(--m);font-size:12px;line-height:1.45}.panel>.form{flex:none;max-height:none;padding:12px;overflow:clip;overscroll-behavior:none}.composer{padding:8px;overflow:clip}.composer textarea{overflow:hidden}.composer>[aria-label='Add details'],.form>.attach{display:none}.privacy-controls{display:flex;align-items:center;flex-wrap:wrap;gap:4px 10px;margin-bottom:8px}.privacy-controls[hidden]{display:none}.privacy-controls>button{min-height:36px;font-size:13px}.privacy-controls>p{flex-basis:100%;margin:0;color:var(--m);font-size:12px;line-height:1.4}@media(pointer:coarse){.lead-controls>button,.privacy-controls>button{min-height:44px}}";
  root.append(style);
  const notice = document.createElement("p");
  notice.className = "templ-ai-notice";
  notice.textContent = TEMPL_AI_NOTICE;
  const privacy = document.createElement("div");
  privacy.className = "privacy-controls";
  privacy.hidden = true;
  const choose = document.createElement("button");
  choose.type = "button";
  choose.className = "quiet";
  choose.textContent = "Privacy options";
  choose.setAttribute("aria-expanded", "false");
  const help = document.createElement("p");
  help.id = "templ-privacy-help";
  choose.setAttribute("aria-describedby", help.id);
  help.textContent = "Browser details are optional and start unselected.";
  privacy.append(choose, help);
  let requested = false;
  const details = () =>
    root.querySelector<HTMLButtonElement>(
      '.attach>button[aria-controls^="templ-diagnostics-"]',
    );
  const addDetails = () =>
    root.querySelector<HTMLButtonElement>('[aria-label="Add details"]');
  choose.addEventListener("click", () => {
    if (choose.disabled) return;
    const picker = details();
    if (picker) picker.click();
    else {
      // Load the existing picker only on this explicit action. Its original
      // policy, unchecked choices and Send path remain authoritative.
      requested = true;
      addDetails()?.click();
    }
  });
  const hidden = (node: HTMLElement, value: boolean) => {
    if (node.hidden !== value) node.hidden = value;
  };
  const align = () => {
    const head = root.querySelector(".head");
    if (head && head.nextElementSibling !== notice) head.after(notice);
    const actions = root.querySelector(".lead-controls");
    const wallet = root.querySelector<HTMLButtonElement>(
      ".tools>button:last-child",
    );
    if (actions && wallet)
      actions.insertBefore(wallet, actions.lastElementChild);
    // Templ's own chat has no suggested-question block. Customer widgets
    // keep their questions, and the original consent notice stays intact.
    root
      .querySelectorAll(
        ".contact-help,.starter>.suggestions,.body>.suggestions",
      )
      .forEach((node) => node.remove());
    const form = root.querySelector<HTMLFormElement>(".panel>.form");
    if (!form) return;
    if (privacy.parentElement !== form) form.prepend(privacy);
    const picker = details();
    const toggle = addDetails();
    const busy = !!form.querySelector<HTMLButtonElement>(".send")?.disabled;
    hidden(privacy, !toggle || toggle.hidden || !!picker?.hidden);
    const disabled = busy || form.hasAttribute("data-case-resolved");
    if (choose.disabled !== disabled) choose.disabled = disabled;
    const expanded = picker?.getAttribute("aria-expanded") ?? "false";
    if (choose.getAttribute("aria-expanded") !== expanded)
      choose.setAttribute("aria-expanded", expanded);
    const controls = picker?.getAttribute("aria-controls");
    if (controls && choose.getAttribute("aria-controls") !== controls)
      choose.setAttribute("aria-controls", controls);
    if (
      requested &&
      (form.hidden ||
        root.querySelector<HTMLElement>(".panel")?.hidden ||
        disabled)
    )
      requested = false;
    if (
      requested &&
      picker &&
      toggle?.getAttribute("aria-expanded") === "true"
    ) {
      requested = false;
      if (!privacy.hidden && !choose.disabled) picker.click();
    }
  };
  const observer = new MutationObserver(align);
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["hidden", "disabled", "aria-expanded", "data-case-resolved"],
  });
  align();
  return () => {
    requested = false;
    observer.disconnect();
    style.remove();
    notice.remove();
    privacy.remove();
  };
}
