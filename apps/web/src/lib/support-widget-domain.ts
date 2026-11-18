/** The widget's `domain` chunk: one line under the
 * chat's title, "Verified domain: example.com", when the team proved with a
 * DNS record that it controls the domain this website is on. It proves the
 * real widget runs on a domain the team controls; a fake page could draw
 * the same words, and the docs say so. Loaded only when the workspace's
 * policy names a domain. */

const DOMAIN = /^(?=.{3,253}$)[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

/** @public Lazy chunk entry: the widget loader calls it through a dynamic
 * import, which the dead-code check cannot follow. */
export function domain(titles: HTMLElement, name: string) {
  if (!DOMAIN.test(name) || titles.querySelector("[data-domain]")) return;
  const line = document.createElement("span");
  line.className = "sub";
  line.dataset.domain = "";
  line.title = `This team proved it controls ${name}.`;
  line.textContent = `Verified domain: ${name}`;
  titles.append(line);
}
