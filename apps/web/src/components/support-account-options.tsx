"use client";

import { useMemberProfiles } from "@/lib/member-profiles";

/** IDs must come from the current authorized support response. Public profiles
 * provide labels only; this component never discovers or adds accounts. */
export function SupportAccountOptions({ ids }: { ids: readonly string[] }) {
  const accounts = [...new Set(ids)];
  const profiles = useMemberProfiles(accounts);
  const abbreviated = new Map(
    accounts.map((id) => [
      id,
      id.length > 24 ? `${id.slice(0, 16)}…${id.slice(-6)}` : id,
    ]),
  );
  const occurrences = new Map<string, number>();
  for (const label of abbreviated.values())
    occurrences.set(label, (occurrences.get(label) ?? 0) + 1);

  return accounts.map((id) => {
    const name = profiles.get(id)?.displayName?.trim();
    const shortId = abbreviated.get(id)!;
    const identifier = occurrences.get(shortId)! > 1 ? id : shortId;
    const label = name ? `${name} (${identifier})` : id;
    return (
      <option key={id} value={id} label={label} title={id}>
        {label}
      </option>
    );
  });
}
