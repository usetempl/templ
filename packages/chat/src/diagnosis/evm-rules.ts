import { disagreementOutcome, inputDisagreement } from "./disagreement";
import {
  decodeLogs,
  decodeRevert,
  type ApprovalEvent,
  type BridgeEvent,
  type DecodedArg,
  type DecodedLogs,
  type DecodedRevert,
  type Movement,
  type UserOpEvent,
  type VaultEvent,
} from "./evm-abi";
import {
  draft,
  SOURCE,
  type Draft,
  type EvidenceBook,
  type Outcome,
} from "./evidence";
import {
  formatAmount,
  formatInteger,
  formatIsoTime,
  formatList,
  sanitizeText,
  shortHex,
} from "./format";
import {
  evmInfrastructureLabel,
  isEntryPoint,
  knownEvmToken,
} from "./known-addresses";
import { networkInfo, networkName } from "./networks";
import {
  MEMBER_NOUNS,
  REASON_TEXT,
  UNAVAILABLE_TEXT,
  staffText,
} from "./templates";
import type {
  CategorySource,
  DiagnosisCategory,
  DiagnosisStatus,
  EvmDiagnosisInput,
  EvmFound,
  EvmNetwork,
  EvmProbe,
  FailureReason,
  Hex,
  ProtocolProfileFacts,
} from "./types";

const SWAP_COMMANDS = [
  "V3_SWAP_EXACT_IN",
  "V3_SWAP_EXACT_OUT",
  "V2_SWAP_EXACT_IN",
  "V2_SWAP_EXACT_OUT",
  "V4_SWAP",
];
const DEPOSIT_NAME = /^(deposit|supply|mint|stake|lock)/i;
const WITHDRAW_NAME =
  /^(withdraw|redeem|unstake|unlock|claim|exit|requestwithdraw)/i;
const CCTP_DOMAINS: Readonly<Record<number, string>> = {
  0: "Ethereum",
  1: "Avalanche",
  2: "OP Mainnet",
  3: "Arbitrum",
  5: "Solana",
  6: "Base",
  7: "Polygon PoS",
};
const EIP1559_TYPES = ["0x2", "0x3", "0x4"];
const MOVEMENTS_SHOWN = 12;

const big = (value: string) => BigInt(value);
const heightText = (value: string) => formatInteger(BigInt(value));

/** The probe that decides the status: the first found-mined probe, else the
 * first found-pending probe; the hinted network wins ties. */
export function selectFoundProbe(
  probes: readonly EvmProbe[],
  hint: EvmNetwork | null,
): number | null {
  for (const outcome of ["found-mined", "found-pending"] as const) {
    const matches = probes
      .map((probe, index) => ({ probe, index }))
      .filter((item) => item.probe.outcome === outcome);
    if (matches.length > 0)
      return (matches.find((item) => item.probe.network === hint) ?? matches[0])
        .index;
  }
  return null;
}

type ProfileContract = ProtocolProfileFacts["contracts"][number];
function profileContract(
  profile: ProtocolProfileFacts | null,
  network: EvmNetwork,
  address: string | null,
): { index: number; contract: ProfileContract } | null {
  if (!profile || !address) return null;
  const lower = address.toLowerCase();
  const index = profile.contracts.findIndex(
    (item) => item.network === network && item.address === lower,
  );
  return index < 0 ? null : { index, contract: profile.contracts[index] };
}

type TokenView = {
  address: Hex | null;
  /** From Templ's reviewed list or the workspace profile. */
  trustedLabel: string | null;
  /** The contract's own symbol, sanitized; staff text only, quoted. */
  claimed: string | null;
  decimals: number | null;
  trustedDecimals: boolean;
};
const TOKEN_LABEL = /^[A-Za-z0-9.+-]{1,12}$/;

type EvmContext = {
  input: EvmDiagnosisInput;
  found: EvmFound;
  network: EvmNetwork;
  name: string;
  book: EvidenceBook;
};

/** Resolves a token's label and decimals and records its evidence row.
 * `where` points at the input value the address came from. */
function tokenView(ctx: EvmContext, address: Hex, where: string): TokenView {
  const { input, found, network, book } = ctx;
  const id = `token:${address}`;
  const factIndex = found.tokens.findIndex(
    (item) => item.network === network && item.address === address,
  );
  const fact = factIndex >= 0 ? found.tokens[factIndex] : null;
  const pointer = factIndex >= 0 ? `/found/tokens/${factIndex}` : where;
  const known = knownEvmToken(network, address);
  if (known) {
    book.add(
      id,
      "Token",
      `${known.label}, ${known.decimals} decimals`,
      pointer,
      "builtin-list",
      SOURCE.builtinList,
    );
    return {
      address,
      trustedLabel: known.label,
      claimed: null,
      decimals: known.decimals,
      trustedDecimals: true,
    };
  }
  const labeled = profileContract(input.profile, network, address);
  if (
    labeled &&
    labeled.contract.symbol &&
    labeled.contract.decimals !== null
  ) {
    book.add(
      id,
      "Token",
      `${labeled.contract.symbol}, ${labeled.contract.decimals} decimals`,
      `/profile/contracts/${labeled.index}`,
      "workspace-label",
      SOURCE.workspaceLabel,
    );
    return {
      address,
      trustedLabel: labeled.contract.symbol,
      claimed: null,
      decimals: labeled.contract.decimals,
      trustedDecimals: true,
    };
  }
  if (fact) {
    const trustedSymbol =
      (fact.symbolSource === "builtin" || fact.symbolSource === "workspace") &&
      fact.symbol !== null &&
      TOKEN_LABEL.test(fact.symbol)
        ? fact.symbol
        : null;
    const claimed =
      fact.symbolSource === "contract-claimed" && fact.symbol
        ? sanitizeText(fact.symbol, 32)
        : null;
    const decimalsText =
      fact.decimals === null ? "decimals unknown" : `${fact.decimals} decimals`;
    if (claimed)
      book.add(
        id,
        "Token",
        `"${claimed}" at ${shortHex(address)}, ${decimalsText}`,
        pointer,
        "contract-claimed",
        SOURCE.contractClaimed,
      );
    else if (trustedSymbol)
      book.add(
        id,
        "Token",
        `${trustedSymbol}, ${decimalsText}`,
        pointer,
        fact.symbolSource === "builtin" ? "builtin-list" : "workspace-label",
        fact.symbolSource === "builtin"
          ? SOURCE.builtinList
          : SOURCE.workspaceLabel,
      );
    else
      book.add(
        id,
        "Token",
        `${shortHex(address)}, ${decimalsText}`,
        pointer,
        "agreed",
        tokenReadLabel(ctx),
      );
    return {
      address,
      trustedLabel: trustedSymbol,
      claimed,
      decimals: fact.decimals,
      trustedDecimals:
        fact.decimals !== null &&
        (fact.decimalsSource === "builtin" ||
          fact.decimalsSource === "workspace"),
    };
  }
  book.add(
    id,
    "Token",
    `${shortHex(address)}, no reviewed label`,
    where,
    "agreed",
    tokenReadLabel(ctx),
  );
  return {
    address,
    trustedLabel: null,
    claimed: null,
    decimals: null,
    trustedDecimals: false,
  };
}

function tokenReadLabel(ctx: EvmContext): string {
  const block = ctx.found.block ?? ctx.found.heads.latest;
  return SOURCE.agreedBlock(ctx.name, heightText(block.number));
}

function nativeView(network: EvmNetwork): TokenView {
  const info = networkInfo(network);
  return {
    address: null,
    trustedLabel: info ? info.native : null,
    claimed: null,
    decimals: info ? 18 : null,
    trustedDecimals: !!info,
  };
}

/** Staff name of a token: the trusted label, else the short address with the
 * contract's own symbol quoted. */
function tokenName(view: TokenView): string {
  if (view.trustedLabel) return view.trustedLabel;
  if (!view.address) return "the native coin";
  return view.claimed
    ? `${shortHex(view.address)} ("${view.claimed}")`
    : shortHex(view.address);
}
/** Plain token name for evidence rows: never the contract's own symbol. */
const tokenPlain = (view: TokenView) =>
  view.trustedLabel ?? (view.address ? shortHex(view.address) : "native coin");
function amountText(view: TokenView, raw: bigint): string {
  if (view.decimals !== null) return formatAmount(raw, view.decimals);
  return view.address
    ? `${formatInteger(raw)} base units of`
    : `${formatInteger(raw)} wei of`;
}
const memberToken = (view: TokenView) => view.trustedLabel ?? undefined;
const memberAmount = (view: TokenView, raw: bigint) =>
  view.trustedLabel && view.trustedDecimals && view.decimals !== null
    ? formatAmount(raw, view.decimals)
    : undefined;

type UserOpMatch =
  | { kind: "matched"; op: UserOpEvent }
  | { kind: "ambiguous"; count: number }
  | { kind: "none" };

export type EvmDerived = {
  subject: Hex;
  entryPoint: Hex | null;
  userOp: UserOpMatch | null;
  logs: DecodedLogs;
  movements: Movement[];
  subjectMovements: Movement[];
  approvals: ApprovalEvent[];
  vaults: VaultEvent[];
  swap: "event" | "builtin-method" | null;
  unwrap: boolean;
  bridge: BridgeEvent | null;
  bridgeLabel: { index: number; label: string } | null;
  revert: DecodedRevert | null;
  outOfGas: "exact" | "likely" | null;
  category: DiagnosisCategory;
  categorySource: CategorySource | null;
};

function evmWallet(input: EvmDiagnosisInput, kind: "signed" | "claimed") {
  const wallet = input.wallet[kind];
  return wallet && wallet.network !== "solana"
    ? (wallet.address.toLowerCase() as Hex)
    : null;
}

/** Subject, movements, approvals, events, revert and category, from facts
 * only. */
export function deriveEvm(
  input: EvmDiagnosisInput,
  found: EvmFound,
): EvmDerived {
  const { tx, receipt, method } = found;
  const entryPoint = isEntryPoint(tx.to) ? tx.to : null;
  const logs = decodeLogs(found.network, receipt?.logs ?? [], entryPoint);
  let userOp: UserOpMatch | null = null;
  let subject = tx.from;
  if (entryPoint) {
    const signed = evmWallet(input, "signed");
    const claimed = evmWallet(input, "claimed");
    const op =
      logs.userOps.find((item) => item.sender === signed) ??
      logs.userOps.find((item) => item.sender === claimed) ??
      (logs.userOps.length === 1 ? logs.userOps[0] : null);
    userOp = op
      ? { kind: "matched", op }
      : logs.userOps.length > 1
        ? { kind: "ambiguous", count: logs.userOps.length }
        : { kind: "none" };
    if (op) subject = op.sender;
  }
  const movements = [...logs.movements];
  const value = big(tx.value);
  if (value > 0n)
    movements.unshift({
      kind: "native",
      token: null,
      from: tx.from,
      to: tx.to,
      amount: value,
      tokenId: null,
      log: null,
    });
  const subjectMovements = movements.filter(
    (item) => item.from === subject || item.to === subject,
  );
  const approvals = logs.approvals.filter((item) => item.owner === subject);
  const vaults = logs.vaults.filter((item) =>
    item.kind === "deposit"
      ? item.sender === subject || item.owner === subject
      : item.owner === subject ||
        item.receiver === subject ||
        item.sender === subject,
  );
  const commands =
    method?.group === "universal-router" ? method.routerCommands : [];
  const routerSwap = commands.some((name) => SWAP_COMMANDS.includes(name));
  const swap =
    logs.swaps.length > 0 ? "event" : routerSwap ? "builtin-method" : null;
  const unwrap =
    commands.includes("UNWRAP_WETH") &&
    logs.movements.some((item) => item.kind === "weth-out");
  const profileBridge = profileContract(input.profile, found.network, tx.to);
  const bridgeLabel =
    profileBridge && profileBridge.contract.kind === "bridge"
      ? { index: profileBridge.index, label: profileBridge.contract.label }
      : null;
  const bridge = logs.bridges[0] ?? null;

  let revert: DecodedRevert | null = null;
  let outOfGas: EvmDerived["outOfGas"] = null;
  if (receipt && receipt.status === "0x0") {
    if (found.revert?.outcome === "reverted")
      revert = decodeRevert(found.revert.data, found.errorAbi?.items ?? null);
    const used = big(receipt.gasUsed);
    const limit = big(tx.gas);
    if (used === limit) outOfGas = "exact";
    else if (
      used * 64n >= limit * 63n &&
      (!found.revert ||
        found.revert.outcome === "unavailable" ||
        revert?.kind === "no-data")
    )
      outOfGas = "likely";
  }

  const subjectNet = netByToken(subjectMovements, subject);
  let category: DiagnosisCategory = "other";
  let categorySource: CategorySource | null = null;
  const profileTarget = profileContract(input.profile, found.network, tx.to);
  const builtinTransfer =
    method?.source === "builtin" &&
    (method.name === "transfer" || method.name === "transferFrom");
  if (bridge || bridgeLabel) {
    category = "bridge";
    categorySource = bridge ? "event" : "workspace-label";
  } else if (vaults.length > 0) {
    category = vaults[0].kind === "deposit" ? "deposit" : "withdrawal";
    categorySource = "event";
  } else if (swap) {
    category = "swap";
    categorySource = swap;
  } else if (
    approvals.length > 0 &&
    subjectMovements.length === 0 &&
    value === 0n
  ) {
    category = "approval";
    categorySource = "event";
  } else if (
    profileTarget &&
    (profileTarget.contract.kind === "vault" ||
      profileTarget.contract.kind === "staking") &&
    subjectNet.some((item) => item.net !== 0n)
  ) {
    const out = subjectNet.find((item) => item.net < 0n && item.token !== null);
    category = out ? "deposit" : "withdrawal";
    categorySource = "workspace-label";
  } else if (builtinTransfer || (value > 0n && tx.inputBytes === 0)) {
    category = "transfer";
    categorySource = "builtin-method";
  } else if (
    method?.name &&
    method.source !== null &&
    DEPOSIT_NAME.test(method.name)
  ) {
    category = "deposit";
    categorySource = "method-name";
  } else if (
    method?.name &&
    method.source !== null &&
    WITHDRAW_NAME.test(method.name)
  ) {
    category = "withdrawal";
    categorySource = "method-name";
  }
  return {
    subject,
    entryPoint,
    userOp,
    logs,
    movements,
    subjectMovements,
    approvals,
    vaults,
    swap,
    unwrap,
    bridge,
    bridgeLabel,
    revert,
    outOfGas,
    category,
    categorySource,
  };
}

type Net = { token: Hex | null; net: bigint; kind: Movement["kind"] };
/** Net change per token for the subject; tokens in are positive. */
function netByToken(movements: readonly Movement[], subject: Hex): Net[] {
  const out: Net[] = [];
  for (const item of movements) {
    if (item.kind === "erc721") continue;
    const change =
      (item.to === subject ? item.amount : 0n) -
      (item.from === subject ? item.amount : 0n);
    const existing = out.find((entry) => entry.token === item.token);
    if (existing) existing.net += change;
    else out.push({ token: item.token, net: change, kind: item.kind });
  }
  return out;
}

type EvmState = {
  status: DiagnosisStatus;
  finality: "final" | "not-final" | null;
  foundIndex: number | null;
  via: "previous" | null;
};

export function evmStatus(
  input: EvmDiagnosisInput,
  derived: EvmDerived | null,
): EvmState {
  const hint =
    input.hint && input.hint.network !== "solana" ? input.hint.network : null;
  if (inputDisagreement(input))
    return { status: "disagree", finality: null, foundIndex: null, via: null };
  if (input.unavailable)
    return {
      status: "unavailable",
      finality: null,
      foundIndex: null,
      via: null,
    };
  const index = selectFoundProbe(input.probes, hint);
  const found = input.found;
  if (index === null || !found) {
    const hinted = input.probes.find((probe) => probe.network === hint);
    if (
      hinted?.outcome === "unavailable" ||
      input.probes.every((probe) => probe.outcome === "unavailable")
    )
      return {
        status: "unavailable",
        finality: null,
        foundIndex: null,
        via: null,
      };
    const previous = input.previous;
    const now = previous?.confirmedNonceNow;
    if (previous && now && big(now.value) > big(previous.nonce)) {
      const probe = input.probes.find(
        (item) => item.network === previous.network,
      );
      if (
        probe?.outcome === "not-found" &&
        big(probe.head.number) >= big(now.atBlock)
      )
        return {
          status: "replaced",
          finality: null,
          foundIndex: null,
          via: "previous",
        };
    }
    return { status: "not-found", finality: null, foundIndex: null, via: null };
  }
  const probe = input.probes[index];
  if (probe.outcome === "found-pending") {
    const sender = found.senderNonce;
    const nullAt = found.receiptNullAt;
    if (
      sender &&
      nullAt &&
      big(nullAt) >= big(sender.atBlock) &&
      big(sender.confirmed) > big(found.tx.nonce)
    )
      return {
        status: "replaced",
        finality: null,
        foundIndex: index,
        via: null,
      };
    return { status: "pending", finality: null, foundIndex: index, via: null };
  }
  const receipt = found.receipt!;
  const block = found.block!;
  const opFailed =
    derived?.userOp?.kind === "matched" && !derived.userOp.op.success;
  const status = receipt.status === "0x1" && !opFailed ? "confirmed" : "failed";
  const finalized = found.heads.finalized;
  const finality =
    finalized && big(block.number) <= big(finalized.number)
      ? "final"
      : "not-final";
  return { status, finality, foundIndex: index, via: null };
}

/** Evaluates every EVM rule. */
export function evaluateEvm(
  input: EvmDiagnosisInput,
  book: EvidenceBook,
): Outcome {
  const disagreement = inputDisagreement(input);
  if (disagreement) return disagreementOutcome(disagreement, book);
  const drafts: Draft[] = [];
  const hint =
    input.hint && input.hint.network !== "solana" ? input.hint.network : null;
  if (input.hint && input.hint.network === "solana")
    drafts.push(
      draft(
        "dx.hint-mismatch",
        staffText("dx.hint-mismatch", {
          hintNetwork: networkName(input.hint.network),
          subjectKind: "an EVM transaction hash",
        }),
        [hintRow(input, book)],
      ),
    );
  const index = input.unavailable ? null : selectFoundProbe(input.probes, hint);
  const derived =
    index !== null && input.found ? deriveEvm(input, input.found) : null;
  const state = evmStatus(input, derived);

  if (state.status === "unavailable") {
    const unavailable = unavailableDraft(input, book, hint);
    drafts.push(unavailable.draft);
    return {
      status: "unavailable",
      finality: null,
      network: unavailable.network,
      category: "other",
      categorySource: null,
      drafts,
    };
  }

  if (state.foundIndex === null || !input.found || !derived) {
    notFoundDrafts(input, book, hint, state, drafts);
    return {
      status: state.status,
      finality: null,
      network: state.via === "previous" ? input.previous!.network : hint,
      category: "other",
      categorySource: null,
      drafts,
    };
  }

  const found = input.found;
  const ctx: EvmContext = {
    input,
    found,
    network: found.network,
    name: networkName(found.network),
    book,
  };
  foundDrafts(ctx, derived, state, hint, drafts);
  return {
    status: state.status,
    finality: state.finality,
    network: found.network,
    category: derived.category,
    categorySource: derived.categorySource,
    drafts,
  };
}

function hintRow(input: EvmDiagnosisInput, book: EvidenceBook): string {
  const hint = input.hint!;
  return book.add(
    "hint",
    "Network hint",
    networkName(hint.network),
    "/hint",
    "member-hint",
    SOURCE.memberHint(hint.source),
  );
}

function probeRow(
  input: EvmDiagnosisInput,
  book: EvidenceBook,
  index: number,
): string {
  const probe = input.probes[index];
  const name = networkName(probe.network);
  const id = `probe:${probe.network}`;
  const fact = `/probes/${index}`;
  const label = `Checked ${name}`;
  switch (probe.outcome) {
    case "found-mined":
      return book.add(
        id,
        label,
        "Found in a block",
        fact,
        "agreed",
        SOURCE.agreedHead(name, heightText(probe.head.number)),
      );
    case "found-pending":
      return book.add(
        id,
        label,
        "Found waiting to go into a block",
        fact,
        "seen",
        SOURCE.seen(probe.seenBy.length),
      );
    case "not-found":
      return book.add(
        id,
        label,
        `Not found at block ${heightText(probe.head.number)}`,
        fact,
        "agreed",
        SOURCE.agreedHead(name, heightText(probe.head.number)),
      );
    case "disagree":
      return book.add(
        id,
        label,
        "Providers disagree",
        fact,
        "observation",
        SOURCE.reader,
      );
    default:
      return book.add(
        id,
        label,
        `Couldn't check (${UNAVAILABLE_TEXT[probe.reason]})`,
        fact,
        "derived",
        SOURCE.reader,
      );
  }
}

function unavailableDraft(
  input: EvmDiagnosisInput,
  book: EvidenceBook,
  hint: EvmNetwork | null,
): { draft: Draft; network: EvmNetwork | "solana" | null } {
  let network = input.unavailable?.network ?? null;
  let reason = input.unavailable?.reason ?? null;
  const evidence: string[] = [];
  if (input.unavailable) {
    evidence.push(
      book.add(
        "unavailable",
        "Chain read",
        `Couldn't check (${UNAVAILABLE_TEXT[input.unavailable.reason]})`,
        "/unavailable",
        "derived",
        SOURCE.reader,
      ),
    );
  } else {
    const hinted = input.probes.findIndex((probe) => probe.network === hint);
    const indexes =
      hinted >= 0 && input.probes[hinted].outcome === "unavailable"
        ? [hinted]
        : input.probes.map((_probe, index) => index);
    for (const index of indexes) evidence.push(probeRow(input, book, index));
    const first = input.probes[indexes[0]];
    network = indexes.length === 1 ? first.network : null;
    reason = first.outcome === "unavailable" ? first.reason : "provider-error";
  }
  const reasonText = UNAVAILABLE_TEXT[reason ?? "provider-error"];
  const unavailableNames =
    !input.unavailable && network === null
      ? formatList(input.probes.map((probe) => networkName(probe.network)))
      : null;
  const text = network
    ? staffText("dx.unavailable", { network: networkName(network), reasonText })
    : unavailableNames
      ? staffText("dx.unavailable", { network: unavailableNames, reasonText })
      : staffText("dx.unavailable.any", { reasonText });
  const explorer = network ? networkInfo(network)?.explorer : undefined;
  return {
    draft: draft("dx.unavailable", text, evidence, {
      nextValues: { explorer },
      slots: { network: network ? networkName(network) : undefined },
    }),
    network: network ?? hint,
  };
}

function notFoundDrafts(
  input: EvmDiagnosisInput,
  book: EvidenceBook,
  hint: EvmNetwork | null,
  state: EvmState,
  drafts: Draft[],
): void {
  const previous = input.previous;
  if (state.status === "replaced" && previous) {
    const probeIndex = input.probes.findIndex(
      (probe) => probe.network === previous.network,
    );
    const evidence = [
      book.add(
        "previous",
        "Earlier sighting",
        `Waiting at ${formatIsoTime(previous.seenAt)} with nonce ${formatInteger(big(previous.nonce))}; the next unused nonce is now ${formatInteger(big(previous.confirmedNonceNow!.value))}`,
        "/previous",
        "agreed",
        SOURCE.agreedBlock(
          networkName(previous.network),
          heightText(previous.confirmedNonceNow!.atBlock),
        ),
      ),
      probeRow(input, book, probeIndex),
    ];
    drafts.push(
      draft(
        "evm.replaced",
        staffText("evm.replaced", {
          nonce: formatInteger(big(previous.nonce)),
          from: shortHex(previous.from),
        }),
        evidence,
        {
          nextValues: {
            from: shortHex(previous.from),
            explorer: networkInfo(previous.network)?.explorer,
            nonce: formatInteger(big(previous.nonce)),
          },
          slots: { network: networkName(previous.network) },
        },
      ),
    );
    return;
  }
  const missing = input.probes
    .map((probe, index) => ({ probe, index }))
    .filter((item) => item.probe.outcome === "not-found");
  const names = missing.map((item) => networkName(item.probe.network));
  const checked = formatList(
    input.probes.map((probe) => networkName(probe.network)),
  );
  drafts.push(
    draft(
      "evm.not-found",
      staffText("evm.not-found", { networkList: formatList(names) }),
      missing.map((item) => probeRow(input, book, item.index)),
      {
        nextStep: hint ? "ns.not-found-wait" : "ns.ask-network",
        nextValues: { networkList: checked },
        slots: { networks: formatList(names) },
      },
    ),
  );
  input.probes.forEach((probe, index) => {
    if (probe.outcome !== "unavailable" || probe.network === hint) return;
    drafts.push(
      draft(
        "evm.probe-unavailable",
        staffText("evm.probe-unavailable", {
          network: networkName(probe.network),
        }),
        [probeRow(input, book, index)],
        { nextValues: { explorer: networkInfo(probe.network)?.explorer } },
      ),
    );
  });
  const now = previous?.confirmedNonceNow;
  if (previous && now && big(now.value) <= big(previous.nonce))
    drafts.push(
      draft(
        "evm.vanished",
        staffText("evm.vanished", {
          time: formatIsoTime(previous.seenAt),
          nonce: formatInteger(big(previous.nonce)),
        }),
        [
          book.add(
            "previous",
            "Earlier sighting",
            `Waiting at ${formatIsoTime(previous.seenAt)} with nonce ${formatInteger(big(previous.nonce))}; the next unused nonce is still ${formatInteger(big(now.value))}`,
            "/previous",
            "agreed",
            SOURCE.agreedBlock(
              networkName(previous.network),
              heightText(now.atBlock),
            ),
          ),
        ],
      ),
    );
}

function walletDrafts(ctx: EvmContext, subject: Hex, drafts: Draft[]): void {
  const { input, book } = ctx;
  const signed = evmWallet(input, "signed");
  const claimed = evmWallet(input, "claimed");
  if (signed) {
    const row = book.add(
      "wallet.signed",
      "Signed wallet",
      shortHex(signed),
      "/wallet/signed",
      "signed-wallet",
      SOURCE.signedWallet,
    );
    if (signed === subject)
      drafts.push(
        draft(
          "dx.wallet-signed-match",
          staffText("dx.wallet-signed-match", { short: shortHex(signed) }),
          [row],
        ),
      );
    else
      drafts.push(
        draft(
          "dx.wallet-signed-mismatch",
          staffText("dx.wallet-signed-mismatch", {
            from: shortHex(subject),
            wallet: shortHex(signed),
          }),
          [row, "tx"],
          { nextValues: { from: shortHex(subject) } },
        ),
      );
    return;
  }
  if (claimed) {
    const row = book.add(
      "wallet.claimed",
      "Wallet the app reported",
      shortHex(claimed),
      "/wallet/claimed",
      "member-claim",
      SOURCE.memberClaim,
    );
    if (claimed === subject)
      drafts.push(
        draft(
          "dx.wallet-claimed-match",
          staffText("dx.wallet-claimed-match", { short: shortHex(claimed) }),
          [row],
        ),
      );
    else
      drafts.push(
        draft(
          "dx.wallet-claimed-mismatch",
          staffText("dx.wallet-claimed-mismatch", {
            from: shortHex(subject),
            wallet: shortHex(claimed),
          }),
          [row, "tx"],
        ),
      );
  }
}

function noun(derived: {
  category: DiagnosisCategory;
  categorySource: CategorySource | null;
}): string {
  const trusted =
    derived.categorySource === "event" ||
    derived.categorySource === "builtin-method" ||
    derived.categorySource === "workspace-label";
  return trusted &&
    (MEMBER_NOUNS as readonly string[]).includes(derived.category)
    ? derived.category
    : "transaction";
}

function foundDrafts(
  ctx: EvmContext,
  derived: EvmDerived,
  state: EvmState,
  hint: EvmNetwork | null,
  drafts: Draft[],
): void {
  const { input, found, book, name, network } = ctx;
  const { tx, receipt, block } = found;
  const foundIndex = state.foundIndex!;
  const probeId = probeRow(input, book, foundIndex);
  const mined = receipt !== null && block !== null;
  const txId = mined
    ? book.add(
        "tx",
        "Transaction",
        txSummary(found),
        "/found/tx",
        "agreed",
        SOURCE.agreedBlock(name, heightText(block!.number)),
      )
    : book.add(
        "tx",
        "Transaction",
        txSummary(found),
        "/found/tx",
        "seen",
        SOURCE.seen(seenCount(found)),
      );
  const memberNoun = noun(derived);

  walletDrafts(ctx, derived.subject, drafts);

  if (hint && hint !== network) {
    drafts.push(
      draft(
        "evm.other-network",
        staffText("evm.other-network", {
          foundNetwork: name,
          hintNetwork: networkName(hint),
        }),
        [hintRow(input, book), probeId],
        {
          severity: input.hint!.source === "wallet-chain" ? "info" : "warning",
          slots: { foundNetwork: name, hintNetwork: networkName(hint) },
        },
      ),
    );
  }
  const profile = input.profile;
  if (
    profile &&
    profile.expectedNetworks.length > 0 &&
    !profile.expectedNetworks.includes(network)
  ) {
    const row = book.add(
      "profile.networks",
      "Protocol networks",
      formatList(profile.expectedNetworks.map(networkName)),
      "/profile/expectedNetworks",
      "workspace-label",
      SOURCE.workspaceLabel,
    );
    drafts.push(
      draft(
        "evm.unexpected-network",
        staffText("evm.unexpected-network", { network: name }),
        [probeId, row],
        {
          nextValues: { network: name },
        },
      ),
    );
  }
  const minedProbes = input.probes
    .map((probe, index) => ({ probe, index }))
    .filter((item) => item.probe.outcome === "found-mined");
  if (minedProbes.length > 1)
    drafts.push(
      draft(
        "evm.found-on-several",
        staffText("evm.found-on-several", {
          networkList: formatList(
            minedProbes.map((item) => networkName(item.probe.network)),
          ),
          network: name,
        }),
        minedProbes.map((item) => probeRow(input, book, item.index)),
      ),
    );

  if (!mined) {
    pendingDrafts(ctx, state, txId, drafts);
    return;
  }
  const receiptFact = receipt!;
  const blockFact = block!;
  const blockText = heightText(blockFact.number);
  const statusId = book.add(
    "receipt.status",
    "Result",
    receiptFact.status === "0x1" ? "Succeeded" : "Reverted",
    "/found/receipt/status",
    "agreed",
    SOURCE.agreedBlock(name, blockText),
  );
  const native = networkInfo(network)?.native;
  if (receiptFact.effectiveGasPrice !== null && native) {
    const paid = big(receiptFact.gasUsed) * big(receiptFact.effectiveGasPrice);
    const digits = paid.toString().padStart(19, "0");
    const fraction = digits.slice(-18).replace(/0+$/, "");
    const amount = digits.slice(0, -18) + (fraction ? `.${fraction}` : "");
    book.add(
      "receipt.fee",
      "Fee paid",
      `${amount} ${native}`,
      "/found/receipt",
      "agreed",
      `${SOURCE.agreedBlock(name, blockText)}. Execution fee. Other network fees are not included.`,
    );
  }
  const blockId = book.add(
    "block",
    "Block",
    `${blockText} (${shortHex(blockFact.hash)})`,
    "/found/block",
    "agreed",
    SOURCE.agreedBlock(name, blockText),
  );
  const latest = found.heads.latest;
  const latestId = book.add(
    "head.latest",
    "Latest block",
    heightText(latest.number),
    "/found/heads/latest",
    "agreed",
    SOURCE.agreedHead(name, heightText(latest.number)),
  );

  if (state.status === "confirmed")
    drafts.push(
      draft(
        "evm.succeeded",
        staffText("evm.succeeded", { network: name, block: blockText }),
        [statusId, blockId],
        {
          member:
            state.finality === "final" ? "m.confirmed-final" : "m.confirmed",
          slots: { noun: memberNoun, network: name, block: blockText },
        },
      ),
    );
  if (state.finality === "not-final") {
    const confirmations = big(latest.number) - big(blockFact.number) + 1n;
    const finalized = found.heads.finalized;
    const evidence = [blockId, latestId];
    if (finalized)
      evidence.push(
        book.add(
          "head.finalized",
          "Finalized block",
          heightText(finalized.number),
          "/found/heads/finalized",
          "agreed",
          SOURCE.agreedBlock(name, heightText(finalized.number)),
        ),
      );
    drafts.push(
      draft(
        "evm.not-finalized",
        finalized
          ? staffText("evm.not-finalized", {
              confirmations: formatInteger(confirmations),
              finalized: heightText(finalized.number),
            })
          : staffText("evm.not-finalized.no-head", {
              confirmations: formatInteger(confirmations),
            }),
        evidence,
      ),
    );
  } else if (found.heads.finalized) {
    book.add(
      "head.finalized",
      "Finalized block",
      heightText(found.heads.finalized.number),
      "/found/heads/finalized",
      "agreed",
      SOURCE.agreedBlock(name, heightText(found.heads.finalized.number)),
    );
  }

  const subject = derived.subject;
  const subjectShort = shortHex(subject);
  const movementIds = movementRows(ctx, derived.subjectMovements);
  if (derived.subjectMovements.length > 0)
    drafts.push(
      draft(
        "evm.token-movement",
        derived.subjectMovements.length === 1
          ? staffText("evm.token-movement.one", { subjectShort })
          : staffText("evm.token-movement", {
              count: formatInteger(derived.subjectMovements.length),
              subjectShort,
            }),
        movementIds.slice(0, MOVEMENTS_SHOWN),
      ),
    );

  const confirmed = state.status === "confirmed";
  const value = big(tx.value);
  if (confirmed) approvalDrafts(ctx, derived, drafts);
  if (confirmed)
    for (const vault of derived.vaults.slice(0, 1))
      vaultDraft(ctx, derived, vault, blockText, drafts);
  if (confirmed && derived.category === "swap")
    swapDraft(ctx, derived, blockText, drafts);
  if (
    confirmed &&
    tx.inputBytes > 0 &&
    derived.subjectMovements.length === 0 &&
    derived.approvals.length === 0 &&
    derived.logs.vaults.length === 0 &&
    derived.logs.swaps.length === 0 &&
    derived.logs.bridges.length === 0
  )
    drafts.push(
      draft(
        "evm.no-movement",
        staffText("evm.no-movement", { subjectShort }),
        [statusId, txId],
        {
          slots: { network: name, block: blockText },
        },
      ),
    );

  const toCode = tx.to
    ? found.code.findIndex(
        (item) => item.network === network && item.address === tx.to,
      )
    : -1;
  if (
    tx.to &&
    tx.inputBytes > 0 &&
    toCode >= 0 &&
    found.code[toCode].kind === "none"
  ) {
    const codeId = codeRow(ctx, toCode);
    let text = staffText("evm.call-to-empty-address", {
      to: shortHex(tx.to),
      network: name,
    });
    if (value > 0n)
      text += ` ${staffText("evm.call-to-empty-address.value", { value: nativeAmountText(network, value) })}`;
    drafts.push(
      draft("evm.call-to-empty-address", text, [codeId, txId], {
        nextValues: { to: shortHex(tx.to) },
        slots: { network: name },
      }),
    );
  }
  recipientElsewhere(ctx, derived, txId, drafts);

  if (confirmed) {
    const sentToToken = derived.subjectMovements.find(
      (item) =>
        item.kind === "erc20" &&
        item.from === subject &&
        item.to === item.token,
    );
    if (sentToToken) {
      const view = tokenView(
        ctx,
        sentToToken.token!,
        logPointer(sentToToken.log!),
      );
      drafts.push(
        draft(
          "evm.sent-to-token-contract",
          staffText("evm.sent-to-token-contract", {
            amount: amountText(view, sentToToken.amount),
            token: tokenName(view),
          }),
          [logId(ctx, sentToToken.log!), `token:${sentToToken.token}`],
          { slots: { token: memberToken(view) } },
        ),
      );
    }
    const method = found.method;
    if (
      method?.source === "builtin" &&
      (method.name === "transfer" || method.name === "transferFrom")
    ) {
      for (const item of derived.subjectMovements) {
        if (item.kind !== "erc20" || item.from !== subject) continue;
        const target = profileContract(input.profile, network, item.to);
        if (
          !target ||
          !["vault", "router", "staking"].includes(target.contract.kind)
        )
          continue;
        const view = tokenView(ctx, item.token!, logPointer(item.log!));
        const labelId = book.add(
          `label:${network}:${item.to}`,
          "Protocol contract",
          target.contract.label,
          `/profile/contracts/${target.index}`,
          "workspace-label",
          SOURCE.workspaceLabel,
        );
        drafts.push(
          draft(
            "evm.sent-to-protocol-contract",
            staffText("evm.sent-to-protocol-contract", {
              amount: amountText(view, item.amount),
              token: tokenName(view),
              label: target.contract.label,
            }),
            [logId(ctx, item.log!), labelId, methodRow(ctx) ?? labelId],
            {
              nextValues: { label: target.contract.label },
              slots: { token: memberToken(view) },
            },
          ),
        );
        break;
      }
    }
    if (derived.category === "bridge")
      bridgeDraft(ctx, derived, blockText, drafts);
  }

  if (tx.to === null) {
    const address = receiptFact.contractAddress;
    drafts.push(
      draft(
        "evm.contract-creation",
        address
          ? staffText("evm.contract-creation", { address: shortHex(address) })
          : "Created a contract.",
        [txId],
      ),
    );
  }
  if (derived.entryPoint) userOpDrafts(ctx, derived, drafts);
  if (receiptFact.logsTruncated)
    drafts.push(
      draft(
        "evm.logs-truncated",
        staffText("evm.logs-truncated", {
          shown: formatInteger(receiptFact.logs.length),
          total: formatInteger(receiptFact.logsTotal),
        }),
        [statusId],
      ),
    );
  if (receiptFact.status === "0x0")
    revertDrafts(ctx, derived, memberNoun, drafts);
}

function seenCount(found: EvmFound): number {
  return found.txAgreement.kind === "seen" ? found.txAgreement.by.length : 2;
}

function txSummary(found: EvmFound): string {
  const { tx } = found;
  const to = tx.to ? shortHex(tx.to) : "a new contract";
  return `Nonce ${formatInteger(big(tx.nonce))} from ${shortHex(tx.from)} to ${to}`;
}

const logPointer = (position: number) => `/found/receipt/logs/${position}`;
function logId(ctx: EvmContext, position: number): string {
  return `log:${big(ctx.found.receipt!.logs[position].logIndex).toString()}`;
}

/** Native value with its coin, or raw wei on a chain outside the table. */
function nativeAmountText(network: EvmNetwork, value: bigint): string {
  const info = networkInfo(network);
  return info
    ? `${formatAmount(value, 18)} ${info.native}`
    : `${formatInteger(value)} wei`;
}

/** One evidence row per subject movement, in log order. */
function movementRows(
  ctx: EvmContext,
  movements: readonly Movement[],
): string[] {
  const ids: string[] = [];
  for (const item of movements) {
    if (item.log === null) {
      ids.push(
        ctx.book.add(
          "tx.value",
          "Value sent",
          `${nativeAmountText(ctx.network, item.amount)} from ${shortHex(item.from!)}${item.to ? ` to ${shortHex(item.to)}` : ""}`,
          "/found/tx/value",
          "agreed",
          SOURCE.agreedBlock(ctx.name, heightText(ctx.found.block!.number)),
          true,
        ),
      );
      continue;
    }
    const view = tokenView(ctx, item.token!, `${logPointer(item.log)}/address`);
    const id = logId(ctx, item.log);
    const what =
      item.kind === "erc721"
        ? `NFT #${item.tokenId!.toString()} of ${tokenPlain(view)}`
        : `${amountText(view, item.amount)} ${tokenPlain(view)}`;
    const route =
      item.kind === "weth-in"
        ? `wrapped to ${shortHex(item.to!)}`
        : item.kind === "weth-out"
          ? `unwrapped from ${shortHex(item.from!)}`
          : `from ${shortHex(item.from!)} to ${shortHex(item.to!)}`;
    ctx.book.add(
      id,
      "Token movement",
      `${what} ${route}`,
      logPointer(item.log),
      "agreed",
      SOURCE.agreedBlock(ctx.name, heightText(ctx.found.block!.number)),
      true,
    );
    ids.push(id);
  }
  return ids;
}

function codeRow(ctx: EvmContext, index: number): string {
  const item = ctx.found.code[index];
  const name = networkName(item.network);
  const value =
    item.kind === "none"
      ? `No code on ${name}`
      : item.kind === "delegated"
        ? `Delegated to ${shortHex(item.delegate ?? "0x")} on ${name}`
        : `Contract code on ${name}`;
  return ctx.book.add(
    `code:${item.network}:${item.address}`,
    `Code at ${shortHex(item.address)}`,
    value,
    `/found/code/${index}`,
    "agreed",
    SOURCE.agreedBlock(name, heightText(item.atBlock)),
  );
}

function methodRow(ctx: EvmContext): string | null {
  const method = ctx.found.method;
  if (!method || !method.name || !method.source) return null;
  const source = method.source === "builtin" ? "builtin-abi" : "verified-abi";
  return ctx.book.add(
    "method",
    "Method",
    method.name,
    "/found/method",
    source,
    method.source === "builtin"
      ? SOURCE.builtinAbi
      : SOURCE.verifiedAbi(method.source),
  );
}

function pendingDrafts(
  ctx: EvmContext,
  state: EvmState,
  txId: string,
  drafts: Draft[],
): void {
  const { found, book, name, network } = ctx;
  const { tx } = found;
  const nonce = big(tx.nonce);
  const sender = found.senderNonce;
  const evidence = [txId];
  const nonceId = sender
    ? book.add(
        "nonce.confirmed",
        "Next unused nonce",
        `${formatInteger(big(sender.confirmed))} at block ${heightText(sender.atBlock)}`,
        "/found/senderNonce",
        "agreed",
        SOURCE.agreedBlock(name, heightText(sender.atBlock)),
      )
    : null;
  if (nonceId) evidence.push(nonceId);
  if (found.pendingNonce) {
    const pending = found.pendingNonce;
    const parts = [pending.primary, pending.confirmation].map((item) =>
      item ? formatInteger(big(item)) : "no answer",
    );
    evidence.push(
      book.add(
        "nonce.pending",
        "Pending nonce per provider",
        `${parts[0]} and ${parts[1]}`,
        "/found/pendingNonce",
        "seen",
        SOURCE.seen(2),
      ),
    );
  }
  if (state.status === "replaced") {
    drafts.push(
      draft(
        "evm.replaced",
        staffText("evm.replaced", {
          nonce: formatInteger(nonce),
          from: shortHex(tx.from),
        }),
        evidence,
        {
          nextValues: {
            from: shortHex(tx.from),
            explorer: networkInfo(network)?.explorer,
            nonce: formatInteger(nonce),
          },
          slots: { network: name },
        },
      ),
    );
    return;
  }
  let waiting = false;
  if (sender && nonce > big(sender.confirmed)) {
    waiting = true;
    drafts.push(
      draft(
        "evm.nonce-gap",
        staffText("evm.nonce-gap", {
          nonce: formatInteger(nonce),
          confirmed: formatInteger(big(sender.confirmed)),
          nonceMinusOne: formatInteger(nonce - 1n),
        }),
        evidence,
        { slots: { network: name } },
      ),
    );
  }
  const base = found.heads.latest.baseFeePerGas;
  const eip1559 = tx.type !== null && EIP1559_TYPES.includes(tx.type);
  const fee = eip1559 ? tx.maxFeePerGas : tx.gasPrice;
  if (base && big(base) > 0n && fee && big(fee) < big(base)) {
    waiting = true;
    const feeId = book.add(
      "fee.cap",
      eip1559 ? "Max fee per gas" : "Gas price",
      `${formatAmount(big(fee), 9)} gwei`,
      eip1559 ? "/found/tx/maxFeePerGas" : "/found/tx/gasPrice",
      "seen",
      SOURCE.seen(seenCount(found)),
    );
    const latestId = book.add(
      "head.latest",
      "Latest block",
      `${heightText(found.heads.latest.number)}, base fee ${formatAmount(big(base), 9)} gwei`,
      "/found/heads/latest",
      "agreed",
      SOURCE.agreedHead(name, heightText(found.heads.latest.number)),
    );
    drafts.push(
      draft(
        "evm.underpriced",
        staffText("evm.underpriced", {
          fee: formatAmount(big(fee), 9),
          baseFee: formatAmount(big(base), 9),
        }),
        [feeId, latestId],
        { slots: { network: name } },
      ),
    );
  }
  if (!waiting)
    drafts.push(
      draft(
        "evm.pending",
        sender && nonce === big(sender.confirmed)
          ? staffText("evm.pending.next-nonce", {
              n: seenCount(found),
              nonce: formatInteger(nonce),
            })
          : staffText("evm.pending", { n: seenCount(found) }),
        evidence,
        { slots: { network: name } },
      ),
    );
}

function spenderName(
  ctx: EvmContext,
  spender: Hex,
): { name: string; labeled: boolean } {
  const target = profileContract(ctx.input.profile, ctx.network, spender);
  if (target) return { name: target.contract.label, labeled: true };
  const infra = evmInfrastructureLabel(ctx.network, spender);
  if (infra) return { name: infra, labeled: true };
  return { name: shortHex(spender), labeled: false };
}

function approvalDrafts(
  ctx: EvmContext,
  derived: EvmDerived,
  drafts: Draft[],
): void {
  const approvals = derived.approvals;
  if (approvals.length === 0) return;
  const subjectShort = shortHex(derived.subject);
  const describe = (item: ApprovalEvent) => {
    const view = tokenView(ctx, item.token, `${logPointer(item.log)}/address`);
    const spender = spenderName(ctx, item.spender);
    return { view, spender, id: logId(ctx, item.log) };
  };
  for (const item of approvals) {
    const { view, spender, id } = describe(item);
    const what =
      item.kind === "for-all"
        ? `every ${tokenPlain(view)} token`
        : item.unlimited
          ? `an unlimited amount of ${tokenPlain(view)}`
          : `${amountText(view, item.amount!)} ${tokenPlain(view)}`;
    ctx.book.add(
      id,
      item.kind === "permit2" ? "Permit2 approval" : "Approval",
      `${spender.name} may spend ${what}`,
      logPointer(item.log),
      "agreed",
      SOURCE.agreedBlock(ctx.name, heightText(ctx.found.block!.number)),
    );
  }
  const value = big(ctx.found.tx.value);
  if (derived.subjectMovements.length === 0 && value === 0n) {
    const first = approvals[0];
    const { view, spender, id } = describe(first);
    const amount =
      first.kind === "for-all" || first.unlimited
        ? "an unlimited amount of"
        : amountText(view, first.amount!);
    const unlimited = approvals.some((item) => item.unlimited);
    drafts.push(
      draft(
        "evm.approval-only",
        staffText("evm.approval-only", {
          spender: spender.name,
          amount,
          token: tokenName(view),
          subjectShort,
        }),
        [id, `token:${first.token}`],
        {
          member: unlimited ? "m.approval-unlimited" : "m.approval-only",
          slots: { network: ctx.name, token: memberToken(view) },
        },
      ),
    );
  }
  const unlimited = approvals.filter((item) => item.unlimited);
  if (unlimited.length > 0) {
    const pick =
      unlimited.find((item) => !spenderName(ctx, item.spender).labeled) ??
      unlimited[0];
    const { view, spender, id } = describe(pick);
    let text =
      pick.kind === "for-all"
        ? staffText("evm.unlimited-approval.for-all", {
            spender: spender.name,
            token: tokenName(view),
            subjectShort,
          })
        : staffText("evm.unlimited-approval", {
            spender: spender.name,
            token: tokenName(view),
            subjectShort,
          });
    if (!spender.labeled)
      text += ` ${staffText("evm.unlimited-approval.unlabeled")}`;
    drafts.push(
      draft("evm.unlimited-approval", text, [id, `token:${pick.token}`], {
        severity: spender.labeled ? "info" : "warning",
        needsPerson: !spender.labeled,
        nextValues: { spender: spender.name, token: tokenPlain(view) },
      }),
    );
  }
}

function vaultDraft(
  ctx: EvmContext,
  derived: EvmDerived,
  vault: VaultEvent,
  blockText: string,
  drafts: Draft[],
): void {
  const id = logId(ctx, vault.log);
  const assetMove = derived.logs.movements.find(
    (item) =>
      item.kind === "erc20" &&
      (vault.kind === "deposit"
        ? item.to === vault.vault
        : item.from === vault.vault) &&
      item.token !== vault.vault,
  );
  const asset = assetMove
    ? tokenView(ctx, assetMove.token!, `${logPointer(assetMove.log!)}/address`)
    : null;
  const target = profileContract(ctx.input.profile, ctx.network, vault.vault);
  const vaultName = target ? target.contract.label : shortHex(vault.vault);
  const assets = asset
    ? amountText(asset, vault.assets)
    : `${formatInteger(vault.assets)} base units of`;
  const assetName = asset ? tokenName(asset) : "the vault's asset";
  ctx.book.add(
    id,
    vault.kind === "deposit" ? "Vault deposit" : "Vault withdrawal",
    `${formatInteger(vault.assets)} assets, ${formatInteger(vault.shares)} shares at ${shortHex(vault.vault)}`,
    logPointer(vault.log),
    "agreed",
    SOURCE.agreedBlock(ctx.name, blockText),
  );
  const evidence = [id];
  if (asset) evidence.push(`token:${asset.address}`);
  if (target)
    evidence.push(
      ctx.book.add(
        `label:${ctx.network}:${vault.vault}`,
        "Protocol contract",
        target.contract.label,
        `/profile/contracts/${target.index}`,
        "workspace-label",
        SOURCE.workspaceLabel,
      ),
    );
  const slots = {
    network: ctx.name,
    block: blockText,
    amount: asset ? memberAmount(asset, vault.assets) : undefined,
    token: asset ? memberToken(asset) : undefined,
  };
  const nextValues = {
    category: vault.kind === "deposit" ? "deposit" : "withdrawal",
  };
  if (vault.kind === "deposit")
    drafts.push(
      draft(
        "evm.vault-deposit",
        staffText("evm.vault-deposit", {
          vault: vaultName,
          assets,
          asset: assetName,
          shares: formatInteger(vault.shares),
          owner: shortHex(vault.owner),
        }),
        evidence,
        { nextValues, slots },
      ),
    );
  else
    drafts.push(
      draft(
        "evm.vault-withdraw",
        staffText("evm.vault-withdraw", {
          vault: vaultName,
          assets,
          asset: assetName,
          receiver: shortHex(vault.receiver!),
          shares: formatInteger(vault.shares),
        }),
        evidence,
        { nextValues, slots },
      ),
    );
}

function swapDraft(
  ctx: EvmContext,
  derived: EvmDerived,
  blockText: string,
  drafts: Draft[],
): void {
  const net = netByToken(derived.subjectMovements, derived.subject).filter(
    (item) => item.net !== 0n,
  );
  const outs = net.filter((item) => item.net < 0n);
  const ins = net.filter((item) => item.net > 0n);
  const evidence: string[] = derived.subjectMovements
    .filter((item) => item.log !== null)
    .slice(0, MOVEMENTS_SHOWN)
    .map((item) => logId(ctx, item.log!));
  const methodId = methodRow(ctx);
  if (methodId) evidence.push(methodId);
  if (evidence.length === 0) evidence.push("tx");
  const viewOf = (item: Net) => {
    if (item.token === null) return nativeView(ctx.network);
    const move = derived.subjectMovements.find(
      (entry) => entry.token === item.token && entry.log !== null,
    );
    return tokenView(
      ctx,
      item.token,
      move ? `${logPointer(move.log!)}/address` : "/found/tx",
    );
  };
  const slots = { network: ctx.name, block: blockText } as Record<
    string,
    string | undefined
  >;
  let text: string;
  if (outs.length === 1 && derived.unwrap && ins.length === 0) {
    const out = viewOf(outs[0]);
    text = staffText("evm.swap.unwrap", {
      outAmount: amountText(out, -outs[0].net),
      outToken: tokenName(out),
    });
  } else if (outs.length === 1 && ins.length === 1) {
    const out = viewOf(outs[0]);
    const into = viewOf(ins[0]);
    text = staffText("evm.swap", {
      outAmount: amountText(out, -outs[0].net),
      outToken: tokenName(out),
      inAmount: amountText(into, ins[0].net),
      inToken: tokenName(into),
    });
    slots.outAmount = memberAmount(out, -outs[0].net);
    slots.outToken = memberToken(out);
    slots.inAmount = memberAmount(into, ins[0].net);
    slots.inToken = memberToken(into);
  } else {
    const to = ctx.found.tx.to;
    const target = to ? spenderName(ctx, to).name : "a contract";
    text = staffText("evm.swap.unclear", {
      to: target,
      subjectShort: shortHex(derived.subject),
    });
  }
  drafts.push(
    draft("evm.swap", text, evidence, {
      nextValues: { category: "swap" },
      slots,
    }),
  );
}

function recipientElsewhere(
  ctx: EvmContext,
  derived: EvmDerived,
  txId: string,
  drafts: Draft[],
): void {
  const { found, network } = ctx;
  const candidates: Hex[] = [];
  if (found.tx.to && found.tx.inputBytes > 0) candidates.push(found.tx.to);
  for (const item of derived.subjectMovements)
    if (
      item.kind === "erc20" &&
      item.from === derived.subject &&
      item.to &&
      !candidates.includes(item.to)
    )
      candidates.push(item.to);
  for (const address of candidates) {
    const here = found.code.findIndex(
      (item) => item.network === network && item.address === address,
    );
    if (here < 0 || found.code[here].kind !== "none") continue;
    const elsewhere = found.code
      .map((item, index) => ({ item, index }))
      .filter(
        (entry) =>
          entry.item.address === address &&
          entry.item.network !== network &&
          entry.item.kind === "contract",
      );
    if (elsewhere.length === 0) continue;
    const evidence = [
      codeRow(ctx, here),
      ...elsewhere.map((entry) => codeRow(ctx, entry.index)),
      txId,
    ];
    drafts.push(
      draft(
        "evm.recipient-code-elsewhere",
        staffText("evm.recipient-code-elsewhere", {
          address: shortHex(address),
          otherNetworks: formatList(
            elsewhere.map((entry) => networkName(entry.item.network)),
          ),
          network: ctx.name,
        }),
        evidence,
        { nextValues: { to: shortHex(address) } },
      ),
    );
    return;
  }
}

function bridgeDraft(
  ctx: EvmContext,
  derived: EvmDerived,
  blockText: string,
  drafts: Draft[],
): void {
  const event = derived.bridge;
  const evidence: string[] = [];
  let text: string;
  if (event) {
    const id = logId(ctx, event.log);
    const destination =
      event.destination.kind === "cctp-domain"
        ? Object.prototype.hasOwnProperty.call(
            CCTP_DOMAINS,
            event.destination.domain,
          )
          ? CCTP_DOMAINS[event.destination.domain]
          : `CCTP domain ${event.destination.domain}`
        : event.destination.chainId > 0n &&
            event.destination.chainId <= BigInt(Number.MAX_SAFE_INTEGER)
          ? networkName(
              `eip155:${event.destination.chainId.toString()}` as EvmNetwork,
            )
          : `chain ${event.destination.chainId.toString()}`;
    ctx.book.add(
      id,
      `${event.protocol} deposit`,
      `Destination ${destination}`,
      logPointer(event.log),
      "agreed",
      SOURCE.agreedBlock(ctx.name, blockText),
    );
    evidence.push(id);
    text = staffText("evm.bridge-source", {
      network: ctx.name,
      bridge: event.protocol,
      destination,
    });
  } else {
    const label = derived.bridgeLabel!;
    evidence.push(
      ctx.book.add(
        `label:${ctx.network}:${ctx.found.tx.to}`,
        "Protocol contract",
        label.label,
        `/profile/contracts/${label.index}`,
        "workspace-label",
        SOURCE.workspaceLabel,
      ),
    );
    text = staffText("evm.bridge-source.label", {
      network: ctx.name,
      bridge: label.label,
    });
  }
  drafts.push(
    draft("evm.bridge-source", text, evidence, {
      slots: { network: ctx.name, block: blockText },
    }),
  );
}

function userOpDrafts(
  ctx: EvmContext,
  derived: EvmDerived,
  drafts: Draft[],
): void {
  const match = derived.userOp!;
  const entryId = ctx.book.add(
    "entrypoint",
    "EntryPoint",
    evmInfrastructureLabel(ctx.network, derived.entryPoint!) ??
      shortHex(derived.entryPoint!),
    "/found/tx/to",
    "builtin-list",
    SOURCE.builtinList,
  );
  if (match.kind === "matched") {
    const id = `userop:${big(match.op.logIndex).toString()}`;
    ctx.book.add(
      id,
      "Smart-account operation",
      `${shortHex(match.op.sender)} ${match.op.success ? "succeeded" : "failed"}`,
      logPointer(match.op.log),
      "agreed",
      SOURCE.agreedBlock(ctx.name, heightText(ctx.found.block!.number)),
    );
    drafts.push(
      draft(
        "evm.relayed-userop",
        staffText("evm.relayed-userop", { sender: shortHex(match.op.sender) }),
        [entryId, id],
      ),
    );
    if (!match.op.success) {
      const revertLog = derived.logs.userOpReverts.find(
        (item) => item.hash === match.op.hash,
      );
      const decoded = revertLog ? decodeRevert(revertLog.reason, null) : null;
      let text = staffText("evm.userop-failed");
      const evidence = [id];
      let reason: FailureReason = "other";
      if (decoded && revertLog) {
        const revertId = `userop:${big(ctx.found.receipt!.logs[revertLog.log].logIndex).toString()}`;
        const quoted = decoded.kind === "error-string";
        ctx.book.add(
          revertId,
          "Operation revert reason",
          quoted ? `"${decoded.text}"` : revertSummary(decoded),
          logPointer(revertLog.log),
          quoted
            ? "contract-text"
            : decoded.kind === "custom-known" || decoded.kind === "panic"
              ? "builtin-abi"
              : "agreed",
          quoted
            ? SOURCE.contractText
            : decoded.kind === "custom-known" || decoded.kind === "panic"
              ? SOURCE.builtinAbi
              : SOURCE.agreedBlock(
                  ctx.name,
                  heightText(ctx.found.block!.number),
                ),
        );
        evidence.push(revertId);
        text += ` ${userOpReasonText(ctx, decoded)}`;
        reason = "reason" in decoded ? decoded.reason : "other";
        const sentence = REASON_TEXT[reason];
        if (sentence) text += ` ${sentence}`;
      }
      drafts.push(
        draft("evm.userop-failed", text, evidence, {
          reason,
          slots: { network: ctx.name },
        }),
      );
    }
    return;
  }
  drafts.push(
    draft(
      "evm.relayed-userop",
      match.kind === "ambiguous"
        ? staffText("evm.relayed-userop.ambiguous", {
            n: formatInteger(match.count),
          })
        : staffText("evm.relayed-userop.none"),
      [entryId],
    ),
  );
}

function revertSummary(decoded: DecodedRevert): string {
  switch (decoded.kind) {
    case "no-data":
      return "No revert data";
    case "error-string":
      return "A message from the contract";
    case "panic":
      return `Panic ${decoded.code}`;
    case "custom-known":
    case "custom-verified":
      return decoded.name;
    default:
      return `Error ${decoded.selector}`;
  }
}

function userOpReasonText(ctx: EvmContext, decoded: DecodedRevert): string {
  switch (decoded.kind) {
    case "error-string":
      return staffText("evm.userop.error-string", { text: decoded.text });
    case "panic":
      return staffText("evm.userop.panic", {
        code: decoded.code,
        meaning: decoded.meaning ?? `unknown panic code ${decoded.code}`,
      });
    case "custom-known":
    case "custom-verified":
      return staffText("evm.userop.custom", {
        name: decoded.name,
        args: argsText(ctx, decoded.args),
      });
    case "unknown-selector":
      return staffText("evm.userop.unknown-selector", {
        selector: decoded.selector,
      });
    default:
      return staffText("evm.userop.no-data");
  }
}

const AMOUNT_ARG =
  /^(balance|needed|allowance|amount|assets|max|value|minAmountOutReceived|amountReceived|maxAmountInRequested|amountRequested)$/;

/** The token amounts in error arguments are shown with this token's
 * decimals: tx.to when it is a known token, else the only known token among
 * the method's address arguments. */
function callToken(ctx: EvmContext): TokenView | null {
  const { found, network } = ctx;
  const to = found.tx.to;
  const toProfile = profileContract(ctx.input.profile, network, to);
  if (
    to &&
    (knownEvmToken(network, to) ||
      (toProfile && toProfile.contract.decimals !== null))
  )
    return tokenView(ctx, to, "/found/tx/to");
  const candidates = (found.method?.args ?? [])
    .map((arg, index) => ({ arg, index }))
    .filter(
      (item) =>
        item.arg.type === "address" &&
        /^0x[0-9a-fA-F]{40}$/.test(item.arg.value),
    )
    .map((item) => ({
      address: item.arg.value.toLowerCase() as Hex,
      index: item.index,
    }))
    .filter((item) => knownEvmToken(network, item.address));
  const distinct = candidates.filter(
    (item, index) =>
      candidates.findIndex((other) => other.address === item.address) === index,
  );
  if (distinct.length === 1)
    return tokenView(
      ctx,
      distinct[0].address,
      `/found/method/args/${distinct[0].index}/value`,
    );
  return null;
}

function argsText(ctx: EvmContext, args: readonly DecodedArg[]): string {
  if (args.length === 0) return "";
  const token = args.some(
    (arg) => /^uint/.test(arg.type) && AMOUNT_ARG.test(arg.name),
  )
    ? callToken(ctx)
    : null;
  const parts = args.map((arg) => {
    let value: string;
    if (arg.type === "address") value = shortHex(arg.value);
    else if (/^u?int\d*$/.test(arg.type) && /^-?\d+$/.test(arg.value)) {
      const raw = BigInt(arg.value);
      value =
        token &&
        AMOUNT_ARG.test(arg.name) &&
        raw >= 0n &&
        token.decimals !== null
          ? `${formatAmount(raw, token.decimals)} ${tokenName(token)}`
          : formatInteger(arg.value);
    } else if (arg.type === "string") value = `"${arg.value}"`;
    else value = arg.value;
    return arg.name ? `${arg.name} ${value}` : value;
  });
  return `(${parts.join(", ")})`;
}

function revertDrafts(
  ctx: EvmContext,
  derived: EvmDerived,
  memberNoun: string,
  drafts: Draft[],
): void {
  const { found, book, name } = ctx;
  const receipt = found.receipt!;
  const gasUsed = big(receipt.gasUsed);
  const gasLimit = big(found.tx.gas);
  const gasId = book.add(
    "receipt.gas",
    "Gas used",
    `${formatInteger(gasUsed)} of ${formatInteger(gasLimit)} limit`,
    "/found/receipt/gasUsed",
    "agreed",
    SOURCE.agreedBlock(name, heightText(found.block!.number)),
  );
  const slots = { noun: memberNoun, network: name };
  if (derived.outOfGas)
    drafts.push(
      draft(
        "evm.out-of-gas",
        derived.outOfGas === "exact"
          ? staffText("evm.out-of-gas.exact", {
              gasLimit: formatInteger(gasLimit),
            })
          : staffText("evm.out-of-gas.likely", {
              gasUsed: formatInteger(gasUsed),
              gasLimit: formatInteger(gasLimit),
            }),
        [gasId, "receipt.status"],
        { reason: "out-of-gas", slots },
      ),
    );
  const replay = found.revert;
  if (replay?.outcome === "disagree") return;
  const parent = replay?.atBlock ? heightText(replay.atBlock.number) : null;
  const replayLabel = replay?.atBlock
    ? SOURCE.replay(name, parent!)
    : SOURCE.reader;
  const methodId = methodRow(ctx);
  const withMethod = (ids: string[]) => (methodId ? [...ids, methodId] : ids);
  const decoded = derived.revert;
  if (!replay || replay.outcome === "unavailable") {
    if (!derived.outOfGas) {
      const evidence = ["receipt.status"];
      if (replay)
        evidence.push(
          book.add(
            "revert",
            "Replay",
            `Couldn't replay (${replay.reason === "call-error" ? "the call failed on the providers" : UNAVAILABLE_TEXT[replay.reason]})`,
            "/found/revert",
            "derived",
            SOURCE.reader,
          ),
        );
      drafts.push(
        draft(
          "evm.revert.no-replay",
          parent
            ? staffText("evm.revert.no-replay", { parent })
            : staffText("evm.revert.no-replay.none"),
          evidence,
          {
            reason: "other",
            nextValues: { explorer: networkInfo(ctx.network)?.explorer },
            slots,
          },
        ),
      );
    }
    return;
  }
  if (replay.outcome === "succeeded") {
    const id = book.add(
      "revert",
      "Replay",
      "The replay succeeded",
      "/found/revert",
      "replay",
      replayLabel,
    );
    drafts.push(
      draft(
        "evm.revert.not-reproduced",
        staffText("evm.revert.not-reproduced", { parent: parent! }),
        ["receipt.status", id],
        { reason: "other", slots },
      ),
    );
    return;
  }
  if (!decoded) return;
  const reasonSentence = (reason: FailureReason) =>
    REASON_TEXT[reason] ? ` ${REASON_TEXT[reason]}` : "";
  switch (decoded.kind) {
    case "no-data": {
      if (derived.outOfGas) return;
      const id = book.add(
        "revert",
        "Replay",
        "Reverted with no data",
        "/found/revert",
        "replay",
        replayLabel,
      );
      drafts.push(
        draft(
          "evm.revert.no-data",
          staffText("evm.revert.no-data", { parent: parent! }),
          ["receipt.status", id],
          { reason: "other", slots },
        ),
      );
      return;
    }
    case "error-string": {
      const id = book.add(
        "revert",
        "Revert message",
        `"${decoded.text}"`,
        "/found/revert",
        "contract-text",
        SOURCE.contractText,
      );
      drafts.push(
        draft(
          "evm.revert.error-string",
          staffText("evm.revert.error-string", {
            text: decoded.text,
            parent: parent!,
          }) + reasonSentence(decoded.reason),
          withMethod(["receipt.status", id]),
          {
            reason: decoded.reason,
            slots: failedSlots(ctx, slots, decoded.reason),
          },
        ),
      );
      return;
    }
    case "panic": {
      const id = book.add(
        "revert",
        "Revert",
        `Panic ${decoded.code}`,
        "/found/revert",
        "builtin-abi",
        SOURCE.builtinAbi,
      );
      drafts.push(
        draft(
          "evm.revert.panic",
          staffText("evm.revert.panic", {
            code: decoded.code,
            meaning: decoded.meaning ?? `unknown panic code ${decoded.code}`,
            parent: parent!,
          }) + reasonSentence(decoded.reason),
          ["receipt.status", id],
          { reason: decoded.reason, slots },
        ),
      );
      return;
    }
    case "custom-known": {
      const id = book.add(
        "revert",
        "Revert",
        decoded.name,
        "/found/revert",
        "builtin-abi",
        SOURCE.builtinAbi,
      );
      let text: string;
      if (decoded.inner) {
        text = staffText("evm.revert.execution-failed", {
          parent: parent!,
          index:
            decoded.commandIndex === null ? "?" : String(decoded.commandIndex),
          innerName: innerName(ctx, decoded.inner),
        });
      } else
        text = staffText("evm.revert.custom-known", {
          name: decoded.name,
          args: argsText(ctx, decoded.args),
          parent: parent!,
        });
      drafts.push(
        draft(
          "evm.revert.custom-known",
          text + reasonSentence(decoded.reason),
          withMethod(["receipt.status", id]),
          {
            reason: decoded.reason,
            slots: failedSlots(ctx, slots, decoded.reason),
          },
        ),
      );
      return;
    }
    case "custom-verified": {
      const source = found.errorAbi!.source;
      const id = book.add(
        "revert",
        "Revert",
        decoded.name,
        "/found/revert",
        "verified-abi",
        SOURCE.verifiedAbi(source),
      );
      const sentence = REASON_TEXT[decoded.reason];
      const byName = sentence
        ? ` Going by the error name, ${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}`
        : "";
      drafts.push(
        draft(
          "evm.revert.custom-verified",
          staffText("evm.revert.custom-verified", {
            name: decoded.name,
            args: argsText(ctx, decoded.args),
            abiSource: SOURCE.verifiedAbi(source).replace(
              "Verified source on ",
              "",
            ),
            parent: parent!,
          }) + byName,
          withMethod(["receipt.status", id]),
          {
            reason: decoded.reason,
            slots: failedSlots(ctx, slots, decoded.reason),
          },
        ),
      );
      return;
    }
    default: {
      const id = book.add(
        "revert",
        "Revert",
        `Error ${decoded.selector}`,
        "/found/revert",
        "replay",
        replayLabel,
      );
      drafts.push(
        draft(
          "evm.revert.unknown-selector",
          staffText("evm.revert.unknown-selector", {
            selector: decoded.selector,
          }),
          ["receipt.status", id],
          { reason: "other", slots },
        ),
      );
    }
  }
}

/** Member slots for a failure: the token for allowance and balance
 * templates. */
function failedSlots(
  ctx: EvmContext,
  slots: { noun: string; network: string },
  reason: FailureReason,
): Record<string, string | undefined> {
  if (reason !== "allowance" && reason !== "balance") return slots;
  const token = callToken(ctx);
  return { ...slots, token: token ? memberToken(token) : undefined };
}

function innerName(ctx: EvmContext, inner: DecodedRevert): string {
  switch (inner.kind) {
    case "error-string":
      return `the contract's message "${inner.text}"`;
    case "panic":
      return `a Solidity panic, code ${inner.code}`;
    case "custom-known":
    case "custom-verified":
      return `${inner.name}${argsText(ctx, inner.args)}`;
    case "unknown-selector":
      return `error ${inner.selector}`;
    default:
      return "no reason";
  }
}
