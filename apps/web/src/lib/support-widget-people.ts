import type { TailHost } from "./support-widget";

/** Initials reserve the portrait while a workspace image loads, including on a failed read. */
export function participantBadge(host: TailHost, initial: string, photo?: string | null) {
  const badge = host.el("i", initial);
  if (photo) {
    const image = host.el("img");
    image.alt = "";
    image.referrerPolicy = "no-referrer";
    image.onload = () => badge.replaceChildren(image);
    image.src = photo;
  }
  return badge;
}

export function renderPeople(
  host: TailHost,
  roster: HTMLElement,
  avatars: HTMLElement | undefined,
  people: readonly (readonly [string, string, string, (string | null)?])[],
) {
  roster.replaceChildren();
  avatars?.replaceChildren();
  for (const [name, detail, initial, photo] of people) {
    const row = host.el("div"),
      label = host.el("span");
    label.append(host.el("b", name), host.el("small", detail));
    row.append(participantBadge(host, initial, photo), label);
    roster.append(row);
    avatars?.append(participantBadge(host, initial, photo));
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
