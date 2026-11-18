import { disagreementOutcome } from "./disagreement";
import { shortSolanaAddress } from "../solana";
import { classifyErrorName } from "./evm-abi";
import {
  draft,
  SOURCE,
  type Draft,
  type EvidenceBook,
  type Outcome,
} from "./evidence";
import { formatAmount, formatInteger, sanitizeText } from "./format";
import {
  SOLANA_PROGRAMS,
  knownSolanaMint,
  solanaProgramLabel,
} from "./known-addresses";
import { networkName } from "./networks";
import { SOLANA_BLOCKHASH_VALID_BLOCKS } from "./rules";
import {
  ANCHOR_NAME_PATTERNS,
  builtinInstructionReason,
  decodeComputeBudget,
  parseProgramLogs,
  programErrorTable,
  transactionErrorReason,
  type ComputeBudget,
  type ProgramLogs,
} from "./solana-programs";
import { MEMBER_NOUNS, UNAVAILABLE_TEXT, staffText } from "./templates";
import type {
  CategorySource,
  DiagnosisCategory,
  DiagnosisStatus,
  FailureReason,
  MemberTemplateId,
  NextStepId,
  RuleId,
  SolanaDiagnosisInput,
  SolanaTxError,
  SolanaTxFact,
} from "./types";

const UNLIMITED_AMOUNT = "18446744073709551615";
const MOVEMENTS_SHOWN = 12;
const NATIVE = "native";

type SolanaState = {
  status: DiagnosisStatus;
  finality: "final" | "not-final" | null;
  err: SolanaTxError | null;
};

/** A found signature (agreed status, or a transaction body when an old
 * signature dropped out of the status cache) is confirmed or failed; a
 * processed sighting is pending; otherwise expired or not found. */
export function solanaStatus(input: SolanaDiagnosisInput): SolanaState {
  if (input.disagreement)
    return { status: "disagree", finality: null, err: null };
  if (input.unavailable)
    return { status: "unavailable", finality: null, err: null };
  const status = input.status;
  const agreedFound = status.kind === "agreed" && status.found;
  if (agreedFound || input.tx) {
    const statusErr =
      status.kind === "agreed" && status.found ? status.err : null;
    const err = input.tx ? input.tx.err : statusErr;
    const commitment =
      status.kind === "agreed" && status.found
        ? status.commitment
        : input.tx!.commitment;
    return {
      status: err ? "failed" : "confirmed",
      finality: commitment === "finalized" ? "final" : "not-final",
      err,
    };
  }
  if (status.kind === "seen")
    return { status: "pending", finality: null, err: null };
  const { firstCheck, current } = input.heights;
  if (
    input.providers.archival &&
    current.blockHeight > firstCheck.blockHeight + SOLANA_BLOCKHASH_VALID_BLOCKS
  )
    return { status: "expired", finality: null, err: null };
  return { status: "not-found", finality: null, err: null };
}

type Delta = {
  owner: string;
  mint: string;
  delta: bigint;
  decimals: number;
  accountIndex: number;
  pointer: string;
};
type Approval = {
  instruction: number;
  delegate: string;
  source: string | null;
  mint: string | null;
  amount: bigint;
  unlimited: boolean;
  decimals: number | null;
};
type Change = { mint: string; delta: bigint; decimals: number };

export type SolanaDerived = {
  feePayer: string;
  subject: string;
  subjectIndex: number;
  deltas: Delta[];
  subjectDeltas: Delta[];
  /** Subject's lamport change with the fee added back, or null when the
   * balances are not exact. */
  solDelta: bigint | null;
  logs: ProgramLogs;
  budget: ComputeBudget;
  approvals: Approval[];
  invoked: string[];
  jupiter: boolean;
  bridge: { index: number; label: string } | null;
  changes: Change[];
  category: DiagnosisCategory;
  categorySource: CategorySource | null;
};

function solanaWallet(input: SolanaDiagnosisInput, kind: "signed" | "claimed") {
  const wallet = input.wallet[kind];
  return wallet && wallet.network === "solana" ? wallet.address : null;
}

function profileProgram(input: SolanaDiagnosisInput, id: string) {
  if (!input.profile) return null;
  const index = input.profile.contracts.findIndex(
    (item) => item.network === "solana" && item.address === id,
  );
  return index < 0 ? null : { index, contract: input.profile.contracts[index] };
}

export function deriveSolana(
  input: SolanaDiagnosisInput,
  tx: SolanaTxFact,
): SolanaDerived {
  const keys = tx.accountKeys;
  const feePayer = keys[0]?.pubkey ?? "";
  const signers = keys.filter((key) => key.signer).map((key) => key.pubkey);
  const signed = solanaWallet(input, "signed");
  const claimed = solanaWallet(input, "claimed");
  const subject =
    signed && signers.includes(signed)
      ? signed
      : claimed && signers.includes(claimed)
        ? claimed
        : feePayer;
  const subjectIndex = keys.findIndex((key) => key.pubkey === subject);

  const byIndex = new Map<
    number,
    {
      pre: bigint;
      post: bigint;
      mint: string;
      owner: string;
      decimals: number;
      pointer: string;
    }
  >();
  tx.preTokenBalances.forEach((item, position) => {
    byIndex.set(item.accountIndex, {
      pre: BigInt(item.amount),
      post: 0n,
      mint: item.mint,
      owner: item.owner ?? keys[item.accountIndex].pubkey,
      decimals: item.decimals,
      pointer: `/tx/preTokenBalances/${position}`,
    });
  });
  tx.postTokenBalances.forEach((item, position) => {
    const existing = byIndex.get(item.accountIndex);
    const entry = {
      pre: existing && existing.mint === item.mint ? existing.pre : 0n,
      post: BigInt(item.amount),
      mint: item.mint,
      owner: item.owner ?? keys[item.accountIndex].pubkey,
      decimals: item.decimals,
      pointer: `/tx/postTokenBalances/${position}`,
    };
    byIndex.set(item.accountIndex, entry);
  });
  const deltas: Delta[] = [...byIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([accountIndex, item]) => ({
      owner: item.owner,
      mint: item.mint,
      delta: item.post - item.pre,
      decimals: item.decimals,
      accountIndex,
      pointer: item.pointer,
    }))
    .filter((item) => item.delta !== 0n);
  const subjectDeltas = deltas.filter((item) => item.owner === subject);

  let solDelta: bigint | null = null;
  if (tx.balances.exact && subjectIndex >= 0) {
    solDelta =
      BigInt(tx.balances.post[subjectIndex]) -
      BigInt(tx.balances.pre[subjectIndex]) +
      (subjectIndex === 0 ? BigInt(tx.fee) : 0n);
  }

  const logs = parseProgramLogs(tx.logMessages);
  const budget = decodeComputeBudget(tx.instructions);
  const invoked = [
    ...tx.instructions.map((item) => item.programId),
    ...tx.innerProgramIds,
    ...logs.invoked,
  ].filter((id, index, all) => all.indexOf(id) === index);
  const jupiter = invoked.includes(SOLANA_PROGRAMS.jupiterV6);

  const balanceOf = (account: string | undefined) => {
    if (!account) return null;
    const index = keys.findIndex((key) => key.pubkey === account);
    return (
      tx.postTokenBalances.find((item) => item.accountIndex === index) ??
      tx.preTokenBalances.find((item) => item.accountIndex === index) ??
      null
    );
  };
  const approvals: Approval[] = [];
  tx.instructions.forEach((item, index) => {
    const isToken =
      item.programId === SOLANA_PROGRAMS.splToken ||
      item.programId === SOLANA_PROGRAMS.token2022;
    if (
      !isToken ||
      (item.type !== "approve" && item.type !== "approveChecked") ||
      !item.info
    )
      return;
    const owner = item.info.owner ?? item.info.authority;
    if (owner !== subject || !item.info.delegate || !item.info.amount) return;
    const balance = balanceOf(item.info.source);
    const mint = item.info.mint ?? balance?.mint ?? null;
    approvals.push({
      instruction: index,
      delegate: item.info.delegate,
      source: item.info.source ?? null,
      mint,
      amount: BigInt(item.info.amount),
      unlimited: item.info.amount === UNLIMITED_AMOUNT,
      decimals:
        balance?.decimals ??
        (mint ? (knownSolanaMint(mint)?.decimals ?? null) : null),
    });
  });

  const changes: Change[] = subjectDeltas.map((item) => ({
    mint: item.mint,
    delta: item.delta,
    decimals: item.decimals,
  }));
  if (solDelta !== null && solDelta !== 0n)
    changes.push({ mint: NATIVE, delta: solDelta, decimals: 9 });
  const downs = changes.filter((item) => item.delta < 0n);
  const ups = changes.filter((item) => item.delta > 0n);

  const bridgeProgram = invoked
    .map((id) => profileProgram(input, id))
    .find((item) => item && item.contract.kind === "bridge");
  const vaultProgram = invoked
    .map((id) => profileProgram(input, id))
    .find(
      (item) =>
        item &&
        (item.contract.kind === "vault" || item.contract.kind === "staking"),
    );
  const meaningful = tx.instructions.filter(
    (item) =>
      item.programId !== SOLANA_PROGRAMS.computeBudget &&
      item.programId !== SOLANA_PROGRAMS.memo,
  );
  const onlyApprovals =
    meaningful.length > 0 &&
    meaningful.every(
      (item) =>
        (item.programId === SOLANA_PROGRAMS.splToken ||
          item.programId === SOLANA_PROGRAMS.token2022) &&
        (item.type === "approve" || item.type === "approveChecked"),
    );
  const onlyTransfers =
    meaningful.length > 0 &&
    meaningful.every(
      (item) =>
        (item.programId === SOLANA_PROGRAMS.system &&
          (item.type === "transfer" || item.type === "transferWithSeed")) ||
        ((item.programId === SOLANA_PROGRAMS.splToken ||
          item.programId === SOLANA_PROGRAMS.token2022) &&
          (item.type === "transfer" || item.type === "transferChecked")) ||
        item.programId === SOLANA_PROGRAMS.associatedToken,
    );

  let category: DiagnosisCategory = "other";
  let categorySource: CategorySource | null = null;
  if (bridgeProgram) {
    category = "bridge";
    categorySource = "workspace-label";
  } else if (
    jupiter ||
    (downs.length === 1 && ups.length === 1 && downs[0].mint !== ups[0].mint)
  ) {
    category = "swap";
    categorySource = "event";
  } else if (onlyApprovals && subjectDeltas.length === 0) {
    category = "approval";
    categorySource = "event";
  } else if (vaultProgram && (downs.length > 0 || ups.length > 0)) {
    category = downs.some((item) => item.mint !== NATIVE)
      ? "deposit"
      : "withdrawal";
    categorySource = "workspace-label";
  } else if (onlyTransfers) {
    category = "transfer";
    categorySource = "builtin-method";
  }
  return {
    feePayer,
    subject,
    subjectIndex,
    deltas,
    subjectDeltas,
    solDelta,
    logs,
    budget,
    approvals,
    invoked,
    jupiter,
    bridge: bridgeProgram
      ? { index: bridgeProgram.index, label: bridgeProgram.contract.label }
      : null,
    changes,
    category,
    categorySource,
  };
}

type TokenLabel = { label: string | null; trusted: boolean };
function mintLabel(input: SolanaDiagnosisInput, mint: string): TokenLabel {
  if (mint === NATIVE) return { label: "SOL", trusted: true };
  const known = knownSolanaMint(mint);
  if (known) return { label: known.label, trusted: true };
  const labeled = profileProgram(input, mint);
  if (labeled?.contract.symbol)
    return { label: labeled.contract.symbol, trusted: true };
  return { label: null, trusted: false };
}
const mintName = (input: SolanaDiagnosisInput, mint: string) =>
  mintLabel(input, mint).label ?? shortSolanaAddress(mint);

function programName(input: SolanaDiagnosisInput, id: string | null): string {
  if (!id) return "A program";
  return (
    solanaProgramLabel(id) ??
    profileProgram(input, id)?.contract.label ??
    shortSolanaAddress(id)
  );
}

type SolanaContext = {
  input: SolanaDiagnosisInput;
  book: EvidenceBook;
  statusId: string;
};

export function evaluateSolana(
  input: SolanaDiagnosisInput,
  book: EvidenceBook,
): Outcome {
  const drafts: Draft[] = [];
  const memberEvidence: string[] = [];
  if (input.hint && input.hint.network !== "solana") {
    const hintId = book.add(
      "hint",
      "Network hint",
      networkName(input.hint.network),
      "/hint",
      "member-hint",
      SOURCE.memberHint(input.hint.source),
    );
    drafts.push(
      draft(
        "dx.hint-mismatch",
        staffText("dx.hint-mismatch", {
          hintNetwork: networkName(input.hint.network),
          subjectKind: "a Solana signature",
        }),
        [hintId],
      ),
    );
  }
  const state = solanaStatus(input);
  const outcome = (
    category: DiagnosisCategory = "other",
    categorySource: CategorySource | null = null,
  ): Outcome => ({
    status: state.status,
    finality: state.finality,
    network: "solana",
    category,
    categorySource,
    drafts,
    memberEvidence,
  });
  if (input.disagreement) return disagreementOutcome(input.disagreement, book);
  if (state.status === "unavailable") {
    const unavailable = input.unavailable!;
    const id = book.add(
      "unavailable",
      "Chain read",
      `Couldn't check (${UNAVAILABLE_TEXT[unavailable.reason]})`,
      "/unavailable",
      "derived",
      SOURCE.reader,
    );
    drafts.push(
      draft(
        "dx.unavailable",
        staffText("dx.unavailable", {
          network: "Solana",
          reasonText: UNAVAILABLE_TEXT[unavailable.reason],
        }),
        [id],
        {
          nextValues: { explorer: "solscan.io" },
          slots: { network: "Solana" },
        },
      ),
    );
    return outcome();
  }
  const statusId = statusRow(input, book);
  const ctx: SolanaContext = { input, book, statusId };
  if (state.status === "not-found") {
    drafts.push(
      draft("sol.not-found", staffText("sol.not-found"), [
        statusId,
        heightRow(ctx, "current"),
      ]),
    );
    return outcome();
  }
  if (state.status === "expired") {
    const passed =
      input.heights.current.blockHeight - input.heights.firstCheck.blockHeight;
    drafts.push(
      draft(
        "sol.expired",
        staffText("sol.expired", { n: formatInteger(passed) }),
        [statusId, heightRow(ctx, "firstCheck"), heightRow(ctx, "current")],
      ),
    );
    return outcome();
  }
  if (state.status === "pending") {
    const status = input.status;
    drafts.push(
      draft(
        "sol.processed",
        staffText("sol.processed", {
          n: status.kind === "seen" ? status.by.length : 2,
        }),
        [statusId],
      ),
    );
    return outcome();
  }

  const tx = input.tx;
  const slot = tx
    ? tx.slot
    : input.status.kind !== "agreed" || !input.status.found
      ? 0
      : input.status.slot;
  const slotText = formatInteger(slot);
  const slotId = tx
    ? book.add(
        "tx.slot",
        "Slot",
        slotText,
        "/tx/slot",
        "agreed",
        SOURCE.solanaAgreed(slotText, tx.commitment),
      )
    : statusId;
  const derived = tx ? deriveSolana(input, tx) : null;
  const category = derived?.category ?? "other";
  const categorySource = derived?.categorySource ?? null;
  const trustedNoun =
    categorySource === "event" ||
    categorySource === "builtin-method" ||
    categorySource === "workspace-label";
  const memberNoun =
    trustedNoun && (MEMBER_NOUNS as readonly string[]).includes(category)
      ? category
      : "transaction";
  const confirmed = state.status === "confirmed";

  if (confirmed)
    drafts.push(
      draft(
        "sol.succeeded",
        staffText("sol.succeeded", { slot: slotText }),
        [slotId, statusId],
        {
          member:
            state.finality === "final"
              ? "m.confirmed-sol-final"
              : "m.confirmed-sol",
          slots: { noun: memberNoun, slot: slotText },
        },
      ),
    );
  if (state.finality === "not-final")
    drafts.push(
      draft("sol.not-finalized", staffText("sol.not-finalized"), [statusId]),
    );

  if (tx && derived) {
    walletDrafts(ctx, tx, derived, drafts);
    movementDrafts(ctx, tx, derived, drafts);
    memberEvidence.push(...unchangedTokenBalances(ctx, tx, derived));
    if (confirmed && category === "swap")
      swapDraft(ctx, derived, slotText, drafts);
    if (confirmed) approvalDrafts(ctx, tx, derived, category, drafts);
    feeDraft(ctx, tx, derived, drafts);
    if (state.status === "failed") failedBalanceEvidence(ctx, tx);
    if (confirmed && category === "bridge") {
      const bridge = derived.bridge!;
      const id = book.add(
        `label:solana:${input.profile!.contracts[bridge.index].address}`,
        "Protocol program",
        bridge.label,
        `/profile/contracts/${bridge.index}`,
        "workspace-label",
        SOURCE.workspaceLabel,
      );
      drafts.push(
        draft(
          "sol.bridge-source",
          staffText("sol.bridge-source", { label: bridge.label }),
          [id, slotId],
          {
            slots: { slot: slotText },
          },
        ),
      );
    }
    if (
      confirmed &&
      category !== "approval" &&
      derived.subjectDeltas.length === 0 &&
      derived.solDelta === 0n
    )
      drafts.push(
        draft(
          "sol.no-movement",
          staffText("sol.no-movement", {
            subjectShort: shortSolanaAddress(derived.subject),
          }),
          [slotId, balanceRow(ctx, tx, derived)],
          {
            slots: { slot: slotText },
          },
        ),
      );
    if (tx.logsTruncated)
      drafts.push(
        draft("sol.logs-truncated", staffText("sol.logs-truncated"), [slotId]),
      );
  }
  if (state.status === "failed" && state.err)
    failureDrafts(ctx, tx, derived, state.err, memberNoun, drafts);
  return outcome(category, categorySource);
}

function statusRow(input: SolanaDiagnosisInput, book: EvidenceBook): string {
  const status = input.status;
  if (status.kind === "seen")
    return book.add(
      "status",
      "Signature status",
      `${status.err ? "Failed" : "Processed"} in slot ${formatInteger(status.slot)}`,
      "/status",
      "seen",
      SOURCE.seen(status.by.length),
    );
  if (status.found) {
    const slot = formatInteger(status.slot);
    const word = status.err
      ? "Failed"
      : status.commitment === "finalized"
        ? "Finalized"
        : "Confirmed";
    return book.add(
      "status",
      "Signature status",
      `${word} in slot ${slot}`,
      "/status",
      "agreed",
      SOURCE.solanaAgreed(slot, status.commitment),
    );
  }
  const current = formatInteger(input.heights.current.blockHeight);
  return book.add(
    "status",
    "Signature status",
    `Neither provider has it (block height ${current})`,
    "/status",
    "agreed",
    SOURCE.readWindow,
  );
}

/** A token stayed only when every account for this user's mint has matching
 * before and after reads. Missing owners or account rows prove nothing. */
function unchangedTokenBalances(
  ctx: SolanaContext,
  tx: SolanaTxFact,
  derived: SolanaDerived,
): string[] {
  const lines: string[] = [];
  const wallet =
    solanaWallet(ctx.input, "signed") ?? solanaWallet(ctx.input, "claimed");
  if (!wallet || wallet !== derived.subject) return lines;
  const mints = new Set(
    tx.preTokenBalances
      .filter((row) => row.owner === wallet)
      .map((row) => row.mint),
  );
  for (const mint of mints) {
    const label = mintLabel(ctx.input, mint);
    if (
      !label.trusted ||
      !label.label ||
      !/^[A-Za-z0-9.+-]{1,12}$/.test(label.label)
    )
      continue;
    const before = tx.preTokenBalances.filter(
      (row) => row.owner === wallet && row.mint === mint,
    );
    const after = tx.postTokenBalances.filter(
      (row) => row.owner === wallet && row.mint === mint,
    );
    if (
      [...tx.preTokenBalances, ...tx.postTokenBalances].some(
        (row) => row.mint === mint && !row.owner,
      )
    )
      continue;
    if (
      new Set(before.map((row) => row.accountIndex)).size !== before.length ||
      new Set(after.map((row) => row.accountIndex)).size !== after.length
    )
      continue;
    if (
      !before.length ||
      before.length !== after.length ||
      !before.some((row) => BigInt(row.amount) > 0n)
    )
      continue;
    if (
      !before.every((row) =>
        after.some(
          (next) =>
            next.accountIndex === row.accountIndex &&
            next.decimals === row.decimals &&
            next.amount === row.amount,
        ),
      )
    )
      continue;
    ctx.book.add(
      `balance.same:${mint}`,
      "Balances",
      `Same ${label.label} before and after.`,
      "/tx/preTokenBalances",
      "agreed",
      SOURCE.solanaAgreed(formatInteger(tx.slot), tx.commitment),
    );
    if (tx.err) lines.push(`${label.label} stayed in your wallet`);
  }
  return lines;
}

function heightRow(
  ctx: SolanaContext,
  which: "firstCheck" | "current",
): string {
  const height = ctx.input.heights[which];
  return ctx.book.add(
    which === "firstCheck" ? "height.first" : "height.current",
    which === "firstCheck"
      ? "Block height at the first check"
      : "Block height now",
    `${formatInteger(height.blockHeight)} (slot ${formatInteger(height.slot)})`,
    `/heights/${which}`,
    "read-window",
    SOURCE.readWindow,
  );
}

function walletDrafts(
  ctx: SolanaContext,
  tx: SolanaTxFact,
  derived: SolanaDerived,
  drafts: Draft[],
): void {
  const { input, book } = ctx;
  const signed = solanaWallet(input, "signed");
  const claimed = solanaWallet(input, "claimed");
  const subject = derived.subject;
  const subjectId = book.add(
    "signer",
    "Sender",
    shortSolanaAddress(subject),
    `/tx/accountKeys/${Math.max(derived.subjectIndex, 0)}`,
    "agreed",
    SOURCE.solanaAgreed(formatInteger(tx.slot), tx.commitment),
  );
  if (signed) {
    const id = book.add(
      "wallet.signed",
      "Signed wallet",
      shortSolanaAddress(signed),
      "/wallet/signed",
      "signed-wallet",
      SOURCE.signedWallet,
    );
    if (signed === subject)
      drafts.push(
        draft(
          "dx.wallet-signed-match",
          staffText("dx.wallet-signed-match", {
            short: shortSolanaAddress(signed),
          }),
          [id],
        ),
      );
    else
      drafts.push(
        draft(
          "dx.wallet-signed-mismatch",
          staffText("dx.wallet-signed-mismatch", {
            from: shortSolanaAddress(subject),
            wallet: shortSolanaAddress(signed),
          }),
          [id, subjectId],
          {
            nextValues: { from: shortSolanaAddress(subject) },
          },
        ),
      );
    return;
  }
  if (claimed) {
    const id = book.add(
      "wallet.claimed",
      "Wallet the app reported",
      shortSolanaAddress(claimed),
      "/wallet/claimed",
      "member-claim",
      SOURCE.memberClaim,
    );
    if (claimed === subject)
      drafts.push(
        draft(
          "dx.wallet-claimed-match",
          staffText("dx.wallet-claimed-match", {
            short: shortSolanaAddress(claimed),
          }),
          [id],
        ),
      );
    else
      drafts.push(
        draft(
          "dx.wallet-claimed-mismatch",
          staffText("dx.wallet-claimed-mismatch", {
            from: shortSolanaAddress(subject),
            wallet: shortSolanaAddress(claimed),
          }),
          [id, subjectId],
        ),
      );
  }
}

function deltaRow(ctx: SolanaContext, tx: SolanaTxFact, item: Delta): string {
  const name = mintName(ctx.input, item.mint);
  const amount = formatAmount(item.delta, item.decimals);
  const verb = item.delta < 0n ? "out of" : "into";
  return ctx.book.add(
    `token:${item.accountIndex}`,
    "Token balance change",
    `${amount} ${name} ${verb} ${shortSolanaAddress(tx.accountKeys[item.accountIndex].pubkey)} (owner ${shortSolanaAddress(item.owner)})`,
    item.pointer,
    "agreed",
    SOURCE.solanaAgreed(formatInteger(tx.slot), tx.commitment),
    true,
  );
}

function balanceRow(
  ctx: SolanaContext,
  tx: SolanaTxFact,
  derived: SolanaDerived,
): string {
  const index = Math.max(derived.subjectIndex, 0);
  const change = derived.solDelta ?? 0n;
  return ctx.book.add(
    `sol:${index}`,
    "SOL balance change",
    `${change < 0n ? "-" : ""}${formatAmount(change, 9)} SOL for ${shortSolanaAddress(tx.accountKeys[index].pubkey)}, fee added back`,
    `/tx/balances/post/${index}`,
    "agreed",
    SOURCE.solanaAgreed(formatInteger(tx.slot), tx.commitment),
    true,
  );
}

function movementDrafts(
  ctx: SolanaContext,
  tx: SolanaTxFact,
  derived: SolanaDerived,
  drafts: Draft[],
): void {
  const subjectShort = shortSolanaAddress(derived.subject);
  if (derived.subjectDeltas.length > 0) {
    const ids = derived.subjectDeltas
      .slice(0, MOVEMENTS_SHOWN)
      .map((item) => deltaRow(ctx, tx, item));
    drafts.push(
      draft(
        "sol.token-movement",
        derived.subjectDeltas.length === 1
          ? staffText("sol.token-movement.one", { subjectShort })
          : staffText("sol.token-movement", {
              count: formatInteger(derived.subjectDeltas.length),
              subjectShort,
            }),
        ids,
      ),
    );
  }
  if (derived.solDelta !== null && derived.solDelta !== 0n)
    drafts.push(
      draft(
        "sol.sol-movement",
        staffText("sol.sol-movement", {
          subjectShort,
          amount: formatAmount(derived.solDelta, 9),
        }),
        [balanceRow(ctx, tx, derived)],
      ),
    );
}

function swapDraft(
  ctx: SolanaContext,
  derived: SolanaDerived,
  slotText: string,
  drafts: Draft[],
): void {
  const { input } = ctx;
  const downs = derived.changes.filter((item) => item.delta < 0n);
  const ups = derived.changes.filter((item) => item.delta > 0n);
  const evidence = ctx.book.has("tx.slot") ? ["tx.slot"] : [ctx.statusId];
  const ids = derived.subjectDeltas
    .slice(0, MOVEMENTS_SHOWN)
    .map((item) => `token:${item.accountIndex}`);
  for (const id of ids) if (ctx.book.has(id)) evidence.push(id);
  if (
    derived.solDelta &&
    ctx.book.has(`sol:${Math.max(derived.subjectIndex, 0)}`)
  )
    evidence.push(`sol:${Math.max(derived.subjectIndex, 0)}`);
  const via = derived.jupiter ? " through Jupiter" : "";
  const slots: Record<string, string | undefined> = { slot: slotText };
  let text: string;
  if (downs.length === 1 && ups.length === 1 && downs[0].mint !== ups[0].mint) {
    const out = downs[0];
    const into = ups[0];
    const outLabel = mintLabel(input, out.mint);
    const inLabel = mintLabel(input, into.mint);
    text = staffText("sol.swap", {
      outAmount: formatAmount(-out.delta, out.decimals),
      outToken: mintName(input, out.mint),
      inAmount: formatAmount(into.delta, into.decimals),
      inToken: mintName(input, into.mint),
      via,
    });
    if (outLabel.trusted && inLabel.trusted) {
      slots.outAmount = formatAmount(-out.delta, out.decimals);
      slots.outToken = outLabel.label ?? undefined;
      slots.inAmount = formatAmount(into.delta, into.decimals);
      slots.inToken = inLabel.label ?? undefined;
    }
  } else {
    text = staffText("sol.swap.unclear", {
      via: derived.jupiter ? "Jupiter" : "a program",
      subjectShort: shortSolanaAddress(derived.subject),
    });
  }
  drafts.push(
    draft("sol.swap", text, evidence, {
      nextValues: { category: "swap" },
      slots,
    }),
  );
}

function approvalDrafts(
  ctx: SolanaContext,
  tx: SolanaTxFact,
  derived: SolanaDerived,
  category: DiagnosisCategory,
  drafts: Draft[],
): void {
  const { input, book } = ctx;
  if (derived.approvals.length === 0) return;
  const describe = (item: Approval) => {
    const id = book.add(
      `ix:${item.instruction}`,
      "Instruction",
      `Token approve for ${shortSolanaAddress(item.delegate)}`,
      `/tx/instructions/${item.instruction}`,
      "agreed",
      SOURCE.solanaAgreed(formatInteger(tx.slot), tx.commitment),
    );
    const label = item.mint
      ? mintLabel(input, item.mint)
      : { label: null, trusted: false };
    const token = item.mint ? mintName(input, item.mint) : "a token";
    const account = item.source
      ? shortSolanaAddress(item.source)
      : shortSolanaAddress(derived.subject);
    const delegateProgram = profileProgram(input, item.delegate);
    const delegate = delegateProgram
      ? delegateProgram.contract.label
      : shortSolanaAddress(item.delegate);
    return { id, label, token, account, delegate, labeled: !!delegateProgram };
  };
  if (category === "approval") {
    const first = derived.approvals[0];
    const view = describe(first);
    const amount = first.unlimited
      ? "any amount of"
      : first.decimals !== null
        ? formatAmount(first.amount, first.decimals)
        : `${formatInteger(first.amount)} base units of`;
    drafts.push(
      draft(
        "sol.approval-only",
        staffText("sol.approval-only", {
          delegate: view.delegate,
          amount,
          token: view.token,
          account: view.account,
        }),
        [view.id],
        {
          member: derived.approvals.some((item) => item.unlimited)
            ? "m.approval-unlimited"
            : "m.approval-only",
          slots: {
            network: "Solana",
            token: view.label.trusted
              ? (view.label.label ?? undefined)
              : undefined,
          },
        },
      ),
    );
  }
  const unlimited = derived.approvals.filter((item) => item.unlimited);
  if (unlimited.length > 0) {
    const views = unlimited.map((item) => describe(item));
    const pick = views.find((item) => !item.labeled) ?? views[0];
    drafts.push(
      draft(
        "sol.unlimited-approval",
        staffText("sol.unlimited-approval", {
          delegate: pick.delegate,
          token: pick.token,
          account: pick.account,
        }),
        [pick.id],
        {
          needsPerson: !pick.labeled,
          nextValues: { spender: pick.delegate, token: pick.token },
        },
      ),
    );
  }
}

function feeDraft(
  ctx: SolanaContext,
  tx: SolanaTxFact,
  derived: SolanaDerived,
  drafts: Draft[],
): void {
  const slotText = formatInteger(tx.slot);
  const fee = formatAmount(BigInt(tx.fee), 9);
  const evidence = [
    ctx.book.add(
      "tx.fee",
      "Fee",
      `${fee} SOL`,
      "/tx/fee",
      "agreed",
      SOURCE.solanaAgreed(slotText, tx.commitment),
    ),
  ];
  let text = staffText("sol.fee", { fee });
  const budget = derived.budget;
  if (budget.price !== null && budget.priceIndex !== null) {
    text += ` ${staffText("sol.fee.price", { price: formatInteger(budget.price) })}`;
    evidence.push(
      ctx.book.add(
        `ix:${budget.priceIndex}`,
        "Instruction",
        `Compute unit price ${formatInteger(budget.price)} micro-lamports`,
        `/tx/instructions/${budget.priceIndex}`,
        "agreed",
        SOURCE.solanaAgreed(slotText, tx.commitment),
      ),
    );
  }
  drafts.push(draft("sol.fee", text, evidence));
}

function logRow(ctx: SolanaContext, tx: SolanaTxFact, line: number): string {
  return ctx.book.add(
    `log:${line}`,
    "Program log",
    `"${sanitizeText(tx.logMessages[line], 200)}"`,
    `/tx/logMessages/${line}`,
    "program-log",
    SOURCE.programLog,
  );
}

function failedBalanceEvidence(ctx: SolanaContext, tx: SolanaTxFact): void {
  const source = SOURCE.solanaAgreed(formatInteger(tx.slot), tx.commitment);
  const tuple = (row: SolanaTxFact["preTokenBalances"][number]) =>
    `${row.accountIndex}:${row.mint}:${row.owner ?? ""}:${row.programId ?? ""}:${row.decimals}:${row.amount}`;
  const before = tx.preTokenBalances.map(tuple).sort();
  const after = tx.postTokenBalances.map(tuple).sort();
  if (
    before.length > 0 &&
    before.length === after.length &&
    new Set(tx.preTokenBalances.map((row) => row.accountIndex)).size ===
      before.length &&
    new Set(tx.postTokenBalances.map((row) => row.accountIndex)).size ===
      after.length &&
    before.every((row, index) => row === after[index])
  )
    ctx.book.add(
      "tx.token-rollback",
      "Token balances",
      "Unchanged.",
      "/tx/preTokenBalances",
      "agreed",
      source,
    );
  if (
    tx.balances.exact &&
    tx.balances.pre.length > 0 &&
    tx.balances.pre.length === tx.balances.post.length &&
    tx.balances.pre.every(
      (amount, index) =>
        BigInt(amount) - BigInt(tx.balances.post[index]) ===
        (index === 0 ? BigInt(tx.fee) : 0n),
    )
  )
    ctx.book.add(
      "tx.native-rollback",
      "SOL balances",
      "Only the fee changed.",
      "/tx/balances",
      "agreed",
      source,
    );
  const line = tx.logMessages.findIndex((value) => value.trim().length > 0);
  if (line >= 0) logRow(ctx, tx, line);
}

function failureDrafts(
  ctx: SolanaContext,
  tx: SolanaTxFact | null,
  derived: SolanaDerived | null,
  err: SolanaTxError,
  memberNoun: string,
  drafts: Draft[],
): void {
  const { input, book } = ctx;
  const errId = tx
    ? book.add(
        "tx.err",
        "Error",
        describeError(err),
        "/tx/err",
        "agreed",
        SOURCE.solanaAgreed(formatInteger(tx.slot), tx.commitment),
      )
    : ctx.statusId;
  const slots: Record<string, string | undefined> = {
    noun: memberNoun,
    network: "Solana",
  };
  const push = (
    rule: RuleId,
    text: string,
    evidence: string[],
    reason: FailureReason,
    extra: {
      member?: MemberTemplateId;
      nextStep?: NextStepId;
      nextValues?: Record<string, string | undefined>;
      token?: string;
      pausedState?: string;
    } = {},
  ) =>
    drafts.push(
      draft(rule, text, evidence, {
        reason,
        member: extra.member,
        nextStep: extra.nextStep,
        nextValues: extra.nextValues,
        slots: { ...slots, token: extra.token, pausedState: extra.pausedState },
      }),
    );

  if (err.kind === "instruction") {
    const logs = derived?.logs ?? null;
    const failing =
      logs?.failures[0]?.programId ??
      tx?.instructions[err.index]?.programId ??
      null;
    const program = programName(input, failing);
    const evidence = [errId];
    if (tx && tx.instructions[err.index])
      evidence.push(
        book.add(
          `ix:${err.index}`,
          "Instruction",
          `Instruction ${err.index} calls ${programName(input, tx.instructions[err.index].programId)}`,
          `/tx/instructions/${err.index}`,
          "agreed",
          SOURCE.solanaAgreed(formatInteger(tx.slot), tx.commitment),
        ),
      );
    if (err.error.kind === "custom") {
      const code = err.error.code;
      const anchor = logs?.anchor.find(
        (item) => item.programId === failing && item.code === code,
      );
      if (anchor && tx) {
        const reason = classifyErrorName(anchor.name, ANCHOR_NAME_PATTERNS);
        const action =
          reason === "paused"
            ? /^(Deposits?|Withdrawals?|Swaps?)Paused$/i
                .exec(anchor.name)?.[1]
                .toLowerCase()
            : undefined;
        const pausedState = action?.startsWith("deposit")
          ? "Deposits were paused."
          : action?.startsWith("withdrawal")
            ? "Withdrawals were paused."
            : action?.startsWith("swap")
              ? "Swaps were paused."
              : undefined;
        push(
          "sol.program-error.anchor",
          staffText("sol.program-error.anchor", {
            program,
            name: anchor.name,
            code: String(code),
            message: sanitizeText(anchor.message, 200),
          }),
          [...evidence, logRow(ctx, tx, anchor.line)],
          reason,
          {
            token: failingToken(ctx, tx, err.index),
            ...(pausedState
              ? {
                  member: "m.failed-paused-action",
                  pausedState,
                  nextValues: { pausedState },
                }
              : {}),
          },
        );
        return;
      }
      const table = failing ? programErrorTable(failing) : null;
      const known =
        table && Object.prototype.hasOwnProperty.call(table, code)
          ? table[code]
          : null;
      if (known) {
        const native =
          failing === SOLANA_PROGRAMS.system && known.reason === "balance";
        push(
          "sol.program-error.known",
          staffText("sol.program-error.known", {
            program,
            name: known.name,
            code: String(code),
          }),
          evidence,
          known.reason,
          {
            member: native ? "m.failed-sol-balance" : undefined,
            nextValues: {
              token: native
                ? "SOL"
                : tx
                  ? failingTokenName(ctx, tx, err.index)
                  : undefined,
            },
            token: native
              ? undefined
              : tx
                ? failingToken(ctx, tx, err.index)
                : undefined,
          },
        );
        return;
      }
      push(
        "sol.program-error.custom",
        staffText("sol.program-error.custom", {
          program,
          code: String(code),
          hex: `0x${code.toString(16)}`,
        }),
        evidence,
        "other",
      );
      return;
    }
    const name = err.error.name;
    const computeExceeded = logs?.computeExceeded ?? false;
    if (name === "InsufficientFunds") {
      push(
        "sol.insufficient-funds",
        staffText("sol.insufficient-funds", { asset: "SOL" }),
        evidence,
        "balance",
        { nextValues: { token: "SOL" } },
      );
      return;
    }
    if (
      name === "ComputationalBudgetExceeded" ||
      (name === "ProgramFailedToComplete" && computeExceeded)
    ) {
      const budget = derived?.budget;
      const computeEvidence = [...evidence];
      if (tx && tx.computeUnitsConsumed !== null)
        computeEvidence.push(
          book.add(
            "tx.compute",
            "Compute units used",
            formatInteger(tx.computeUnitsConsumed),
            "/tx/computeUnitsConsumed",
            "agreed",
            SOURCE.solanaAgreed(formatInteger(tx.slot), tx.commitment),
          ),
        );
      if (tx && budget && budget.limit !== null && budget.limitIndex !== null)
        computeEvidence.push(
          book.add(
            `ix:${budget.limitIndex}`,
            "Instruction",
            `Compute unit limit ${formatInteger(budget.limit)}`,
            `/tx/instructions/${budget.limitIndex}`,
            "agreed",
            SOURCE.solanaAgreed(formatInteger(tx.slot), tx.commitment),
          ),
        );
      const meterLine = tx
        ? tx.logMessages.findIndex((line) =>
            /exceeded CUs meter|exceeded maximum compute/.test(line),
          )
        : -1;
      if (tx && meterLine >= 0)
        computeEvidence.push(logRow(ctx, tx, meterLine));
      push(
        "sol.compute-exceeded",
        budget && budget.limit !== null
          ? staffText("sol.compute-exceeded", {
              limit: formatInteger(budget.limit),
            })
          : staffText("sol.compute-exceeded.default"),
        computeEvidence,
        "compute",
      );
      return;
    }
    push(
      "sol.instruction-error",
      staffText("sol.instruction-error", {
        index: String(err.index),
        program: failing ? program : "an unknown program",
        name,
      }),
      evidence,
      builtinInstructionReason(name, computeExceeded),
    );
    return;
  }
  if (err.kind === "insufficient-funds-for-rent") {
    const key = tx?.accountKeys[err.accountIndex]?.pubkey;
    push(
      "sol.insufficient-rent",
      staffText("sol.insufficient-rent", {
        index: String(err.accountIndex),
        address: key ? shortSolanaAddress(key) : "unknown",
      }),
      [errId],
      "rent",
    );
    return;
  }
  if (err.kind === "transaction") {
    if (err.name === "InsufficientFundsForFee") {
      const payer = derived?.feePayer ?? tx?.accountKeys[0]?.pubkey;
      push(
        "sol.insufficient-fee",
        staffText("sol.insufficient-fee", {
          payer: payer ? shortSolanaAddress(payer) : "unknown",
        }),
        [errId],
        "fee-balance",
        { nextValues: { token: "SOL" } },
      );
      return;
    }
    push(
      "sol.tx-error",
      staffText("sol.tx-error", { name: err.name }),
      [errId],
      transactionErrorReason(err.name),
    );
    return;
  }
  push(
    "sol.tx-error",
    staffText("sol.tx-error.unknown", { raw: sanitizeText(err.raw, 120) }),
    [errId],
    "other",
  );
}

function describeError(err: SolanaTxError): string {
  switch (err.kind) {
    case "instruction":
      return err.error.kind === "custom"
        ? `Instruction ${err.index}, custom error ${err.error.code}`
        : `Instruction ${err.index}, ${err.error.name}`;
    case "insufficient-funds-for-rent":
      return `Account ${err.accountIndex} below the rent minimum`;
    case "transaction":
      return err.name;
    default:
      return "An error Templ can't name";
  }
}

/** The trusted label of the mint a failing SPL instruction moved. */
function failingToken(
  ctx: SolanaContext,
  tx: SolanaTxFact,
  index: number,
): string | undefined {
  const mint = failingMint(tx, index);
  if (!mint) return undefined;
  const label = mintLabel(ctx.input, mint);
  return label.trusted ? (label.label ?? undefined) : undefined;
}
function failingTokenName(
  ctx: SolanaContext,
  tx: SolanaTxFact,
  index: number,
): string | undefined {
  const mint = failingMint(tx, index);
  return mint ? mintName(ctx.input, mint) : undefined;
}
function failingMint(tx: SolanaTxFact, index: number): string | null {
  const instruction = tx.instructions[index];
  if (!instruction?.info) return null;
  if (instruction.info.mint) return instruction.info.mint;
  const source = instruction.info.source;
  if (!source) return null;
  const account = tx.accountKeys.findIndex((key) => key.pubkey === source);
  const balance =
    tx.preTokenBalances.find((item) => item.accountIndex === account) ??
    tx.postTokenBalances.find((item) => item.accountIndex === account);
  return balance?.mint ?? null;
}
