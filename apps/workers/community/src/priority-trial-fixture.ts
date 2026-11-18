import {
  profileKey,
  type ProfileMatch,
  type ProfileRef,
} from "@templ/chat/protocol-profile";
import {
  priorityDepositAdapter,
  PRIORITY_CACHE_MS,
  type PriorityPosition,
} from "@templ/chat/support-priority";
import { knowledgeCall, type KnowledgeEnv } from "./support-knowledge-client";
import {
  priorityProof,
  prioritySettings,
  priorityContractsKey,
  PRIORITY_POSITION_PREFIX,
} from "./support-priority";
import { supportRecord, supportSettings } from "./support-workflow";
import { readConversation } from "./team-conversations";
import type { NativeRoomRecord } from "./native-rooms";
import type { PriorityCaptureCases } from "./priority-trial-capture";
type Storage = Pick<DurableObjectTransaction, "get">;
export type PriorityCaptureFixture = {
  priceAssets: ProfileRef[];
  positionCheckedAt: Record<string, number>;
};
/** Current ordinary test accounts and verified positions define the synthetic fixture. */
export async function checkedPriorityCaptureFixture(
  storage: Storage,
  env: KnowledgeEnv,
  input: {
    cases: PriorityCaptureCases;
    diagnosticScope?: "evm";
    contracts: ProfileRef[];
    walletByNetwork: Record<string, string>;
  },
  now = Date.now(),
): Promise<PriorityCaptureFixture | null> {
  const native = await storage.get<NativeRoomRecord>("native-room");
  if (!native) return null;
  const settings = await prioritySettings(storage);
  const sameContracts = (a: readonly ProfileRef[], b: readonly ProfileRef[]) =>
    a.map(profileKey).sort().join("|") === b.map(profileKey).sort().join("|");
  if (
    !sameContracts(settings.contracts, input.contracts) ||
    (input.diagnosticScope !== "evm" &&
      !input.contracts.some((ref) => ref.network === "solana")) ||
    !input.contracts.some((ref) => ref.network.startsWith("eip155:")) ||
    (input.diagnosticScope === "evm" &&
      input.contracts.some(
        (ref) => !["eip155:1", "eip155:8453"].includes(ref.network),
      ))
  )
    return null;
  const testAccounts = (await supportSettings(storage)).testAccounts;
  const aged = new Set([
    "priceWarmThread",
    "priceCachedThread",
    "staleThread",
    "solanaRefreshThread",
    "unopenedStaleThread",
  ]);
  const positionCheckedAt: Record<string, number> = {};
  const created = Date.parse(native.room.createdAt);
  for (const [name, thread] of Object.entries(input.cases)) {
    const record = await readConversation(storage, thread);
    if (
      !record ||
      record.room !== `room:${native.room.id}` ||
      record.state !== "open" ||
      record.archivedAt ||
      (input.diagnosticScope === "evm" &&
        (!Number.isFinite(created) ||
          record.createdAt < created ||
          record.createdAt > now)) ||
      !testAccounts.includes(record.member)
    )
      return null;
    const proof = await priorityProof(
      storage,
      record,
      await supportRecord(storage, record),
    );
    if (name === "claimedThread") {
      if (proof) return null;
      continue;
    }
    if (!proof) return null;
    const solana = name === "solanaThread" || name === "solanaRefreshThread";
    if (
      (proof.wallet.network === "solana") !== solana ||
      !Object.entries(input.walletByNetwork)
        .filter(([network]) => (network === "solana") === solana)
        .every(([, address]) => address === proof.wallet.address)
    )
      return null;
    const position = await storage.get<{
      checkedAt: number;
      proof: typeof proof;
      contracts: string;
      position: PriorityPosition;
    }>(`${PRIORITY_POSITION_PREFIX}${thread}`);
    if (aged.has(name)) {
      if (
        !position ||
        !Number.isSafeInteger(position.checkedAt) ||
        now - position.checkedAt <= PRIORITY_CACHE_MS ||
        position.contracts !==
          priorityContractsKey({ contracts: input.contracts }) ||
        JSON.stringify(position.proof) !== JSON.stringify(proof) ||
        position.position.state !== "ready" ||
        position.position.wallet.address !== proof.wallet.address
      )
        return null;
      positionCheckedAt[thread] = position.checkedAt;
    }
  }
  const { matches = [] } = await knowledgeCall<{ matches: ProfileMatch[] }>(
    env,
    `room:${native.room.id}`,
    "profile.lookup",
    { principal: native.room.manager, role: "manager" },
    { refs: input.contracts },
  );
  if (
    (input.diagnosticScope === "evm" &&
      matches.some(
        (entry) =>
          !input.contracts.some((ref) => profileKey(ref) === profileKey(entry)),
      )) ||
    input.contracts.some(
      (ref) =>
        !matches.some(
          (entry) =>
            profileKey(entry) === profileKey(ref) &&
            priorityDepositAdapter(entry) !== null,
        ),
    )
  )
    return null;
  const assets = new Map<string, ProfileRef>();
  for (const match of matches) {
    const asset = match.underlying ?? {
      network: match.network,
      address: match.address,
    };
    if (asset.network !== match.network) return null;
    assets.set(profileKey(asset), asset);
  }
  return { priceAssets: [...assets.values()], positionCheckedAt };
}
