import type { TailHost } from "./support-widget";

export function renderPeople(
  host: TailHost,
  roster: HTMLElement,
  avatars: HTMLElement | undefined,
  people: readonly (readonly [string, string, string, (string | null)?])[],
) {
  roster.replaceChildren();
  avatars?.replaceChildren();
  for (const [name, detail, initial, photo] of people) {
    const badge = () => {
      const icon = host.el("i", photo ? undefined : initial);
      if (photo) {
        const image = host.el("img");
        image.alt = "";
        image.referrerPolicy = "no-referrer";
        image.src = photo;
        icon.append(image);
      }
      return icon;
    };
    const row = host.el("div"),
      label = host.el("span");
    label.append(host.el("b", name), host.el("small", detail));
    row.append(badge(), label);
    roster.append(row);
    avatars?.append(badge());
  }
}

export function workspaceContacts(host: TailHost) {
  const profiles = host.policy?.supportProfiles;
  if (!profiles) return;
  const founder = profiles.founder,
    assistant = profiles.assistant;
  const rows: [string, string, string, string | null][] = [
    [
      founder.name || "Founder",
      founder.name ? "Founder" : host.options.label || "Support",
      "F",
      founder.image,
    ],
  ];
  if (assistant)
    rows.push([
      assistant.name || "AI assistant",
      assistant.name ? "AI assistant" : "Support assistant",
      "AI",
      assistant.image,
    ]);
  return rows;
}

export function refreshContacts(host: TailHost) {
  void host.client
    .policy?.()
    .then((policy) => {
      if (!host.policy) return;
      if (
        JSON.stringify(host.policy.supportProfiles) ===
        JSON.stringify(policy.supportProfiles)
      )
        return;
      host.policy.supportProfiles = policy.supportProfiles;
      host.render();
    })
    .catch(() => {});
}
