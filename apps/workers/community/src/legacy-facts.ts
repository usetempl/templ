/** Older products by address. Legacy facts load only for addresses the
 * request itself names: the case frame's product, evidence rows the
 * protocol's agent wrote, a staff "Check this address", and the refs a
 * diagnosis or a position read passes in. Nothing loads the profile in
 * bulk. At most three legacy entries come back, each with its successor's
 * label and its one migration guide. Agents receive member-safe entries
 * only. Members never receive this view. */
import type {
  LegacyFact,
  LegacyTrigger,
  ProfileMatch,
  ProfileRef,
} from "@templ/chat/protocol-profile";
import {
  LEGACY_TRIGGERS,
  PROFILE_LIMITS,
  legacyOrder,
  profileAddress,
  profileKey,
  profileNetwork,
} from "@templ/chat/protocol-profile";
import type { KnowledgeActor } from "./support-knowledge";
import { knowledgeCall, type KnowledgeEnv } from "./support-knowledge-client";
import { readCaseEvidence, readCaseFrame } from "./support-evidence-store";
import { readThreadCases } from "./support-case-data";

export type TriggeredRef = { ref: ProfileRef; trigger: LegacyTrigger };

/** The refs a request names, with the trigger that brought each in. */
export async function caseProfileRefs(
  storage: DurableObjectTransaction,
  thread: string,
): Promise<TriggeredRef[]> {
  const [latest] = await readThreadCases(storage, thread as `tc-${string}`, { limit: 1 });
  if (!latest) return [];
  const refs: TriggeredRef[] = [];
  const add = (network: unknown, address: unknown, trigger: LegacyTrigger) => {
    const net = profileNetwork(network);
    const addr = net ? profileAddress(net, address) : null;
    if (net && addr) refs.push({ ref: { network: net, address: addr }, trigger });
  };
  const frame = await readCaseFrame(storage, thread, latest.seq).catch(() => null);
  if (frame?.product?.address)
    add(frame.product.network ?? frame.network?.value ?? "eip155:1", frame.product.address, "frame");
  const evidence = await readCaseEvidence(storage, thread, latest.seq).catch(() => ({ rows: [] }));
  for (const row of evidence.rows)
    if (row.by === "agent" && !row.withdrawn && row.product.address)
      add(row.product.network ?? "eip155:1", row.product.address, "agent-evidence");
  return refs;
}

/** Matches for up to 20 refs, restricted to the caller's source visibility. */
export async function legacyFactsFor(
  env: KnowledgeEnv,
  room: string,
  actor: KnowledgeActor,
  refs: TriggeredRef[],
): Promise<{ profileMatches: ProfileMatch[]; legacyFacts: LegacyFact[] }> {
  const byKey = new Map<string, TriggeredRef>();
  for (const item of refs) {
    const key = profileKey(item.ref);
    const known = byKey.get(key);
    if (
      !known ||
      LEGACY_TRIGGERS.indexOf(item.trigger) < LEGACY_TRIGGERS.indexOf(known.trigger)
    )
      byKey.set(key, item);
  }
  const list = [...byKey.values()].slice(0, PROFILE_LIMITS.lookupRefs);
  if (!list.length) return { profileMatches: [], legacyFacts: [] };
  const { matches } = await knowledgeCall<{ matches: ProfileMatch[] }>(
    env,
    room,
    "profile.lookup",
    actor,
    { refs: list.map((item) => item.ref) },
  );
  const legacyFacts = matches
    .filter((match) => match.status !== "live")
    .map(
      (match) =>
        ({
          ...match,
          trigger: byKey.get(profileKey(match))!.trigger,
        }) as LegacyFact,
    )
    .sort(legacyOrder)
    .slice(0, PROFILE_LIMITS.legacyFacts);
  return {
    profileMatches: matches.slice(0, PROFILE_LIMITS.matches),
    legacyFacts,
  };
}
