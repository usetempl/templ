import { selectFoundProbe } from "./evm-rules";
import { DIAGNOSIS_LIMITS } from "./rules";
import { isSolanaSignature } from "./subject";
import type {
  AbiParameterFact,
  AgreedBlock,
  DiagnosisInput,
  DiagnosisReadSource,
  EvmAbiErrorItem,
  EvmCodeFact,
  EvmDiagnosisInput,
  EvmFound,
  EvmLogFact,
  EvmMethodFact,
  EvmPreviousSighting,
  EvmProbe,
  EvmReceiptFact,
  EvmRevertReplay,
  EvmTokenFact,
  EvmTxFact,
  Hex,
  NetworkHint,
  ProtocolProfileFacts,
  ProviderObservations,
  SolanaDiagnosisInput,
  SolanaHeight,
  SolanaInstructionFact,
  SolanaStatusFact,
  SolanaTokenBalanceFact,
  SolanaTxError,
  SolanaTxFact,
  VerifiedAbiSource,
  WalletFacts,
} from "./types";
import {
  ABI_SOURCES,
  BASE58,
  COMMAND,
  CONTRACT_KINDS,
  DIGITS,
  HASH,
  HINT_SOURCES,
  INFO_KEYS,
  LABEL,
  METHOD_GROUPS,
  NAME,
  PROGRAM,
  SELECTOR,
  SOL_NAME,
  SYMBOL,
  TYPE,
  UNAVAILABLE,
  address,
  big,
  bool,
  data,
  evmNetwork,
  fail,
  has,
  hash,
  int,
  isObj,
  iso,
  list,
  network,
  nullable,
  obj,
  oneOf,
  quantity,
  roles,
  solAddress,
  text,
  walletAddress,
  type Obj,
} from "./validate";

function parseHint(value: unknown): NetworkHint | null {
  return nullable(value, (item) => {
    const o = obj(item, "/hint", ["network", "source"]);
    return {
      network: network(o.network, "/hint/network"),
      source: oneOf(
        o.source,
        "/hint/source",
        HINT_SOURCES,
      ) as NetworkHint["source"],
    };
  });
}

function parseWallet(value: unknown): WalletFacts {
  const o = obj(value, "/wallet", ["signed", "claimed"]);
  return {
    signed: nullable(o.signed, (item) => {
      const w = obj(item, "/wallet/signed", ["network", "address", "at"]);
      const net = network(w.network, "/wallet/signed/network");
      return {
        network: net,
        address: walletAddress(net, w.address, "/wallet/signed/address"),
        at: iso(w.at, "/wallet/signed/at"),
      };
    }),
    claimed: nullable(o.claimed, (item) => {
      const w = obj(item, "/wallet/claimed", ["network", "address"]);
      const net = network(w.network, "/wallet/claimed/network");
      return {
        network: net,
        address: walletAddress(net, w.address, "/wallet/claimed/address"),
      };
    }),
  };
}

function parseProfile(value: unknown): ProtocolProfileFacts | null {
  return nullable(value, (item) => {
    const o = obj(item, "/profile", ["expectedNetworks", "contracts"]);
    const expectedNetworks = list(
      o.expectedNetworks,
      "/profile/expectedNetworks",
      DIAGNOSIS_LIMITS.profileNetworks,
    ).map((entry, index) =>
      network(entry, `/profile/expectedNetworks/${index}`),
    );
    if (new Set(expectedNetworks).size !== expectedNetworks.length)
      fail("input-shape", "/profile/expectedNetworks");
    const raw = list(
      o.contracts,
      "/profile/contracts",
      DIAGNOSIS_LIMITS.profileContractsPerNetwork *
        DIAGNOSIS_LIMITS.profileNetworks,
    );
    const perNetwork = new Map<string, number>();
    const contracts = raw.map((entry, index) => {
      const path = `/profile/contracts/${index}`;
      const c = obj(entry, path, [
        "network",
        "address",
        "label",
        "kind",
        "symbol",
        "decimals",
      ]);
      const net = network(c.network, `${path}/network`);
      const count = (perNetwork.get(net) ?? 0) + 1;
      if (count > DIAGNOSIS_LIMITS.profileContractsPerNetwork)
        fail("input-limits", path);
      perNetwork.set(net, count);
      return {
        network: net,
        address: walletAddress(net, c.address, `${path}/address`),
        label: text(c.label, `${path}/label`, LABEL, 40),
        kind: oneOf(
          c.kind,
          `${path}/kind`,
          CONTRACT_KINDS,
        ) as ProtocolProfileFacts["contracts"][number]["kind"],
        symbol: nullable(c.symbol, (symbol) =>
          text(symbol, `${path}/symbol`, SYMBOL, 12),
        ),
        decimals: nullable(c.decimals, (decimals) =>
          int(decimals, `${path}/decimals`, 0, 77),
        ),
      };
    });
    return { expectedNetworks, contracts };
  });
}

function observations(value: unknown, path: string): ProviderObservations {
  const rows = list(value, path, 2, 2).map((item, index) => {
    const row = obj(item, `${path}/${index}`, ["provider", "value"]);
    return {
      provider: oneOf(row.provider, `${path}/${index}/provider`, [
        "primary",
        "confirmation",
      ] as const),
      value: text(
        row.value,
        `${path}/${index}/value`,
        null,
        DIAGNOSIS_LIMITS.observationChars,
      ),
    };
  });
  if (rows[0].provider !== "primary" || rows[1].provider !== "confirmation")
    fail("input-agreement", path);
  return rows as ProviderObservations;
}

export function parseDiagnosisReadSource(value: unknown): DiagnosisReadSource {
  const source = obj(value, "/readSource", ["providerCount", "source"]);
  if (source.providerCount !== 1 || source.source !== "alchemy")
    fail("input-shape", "/readSource");
  return { providerCount: 1, source: "alchemy" };
}

function parseCommon(o: Obj) {
  if (o.v !== 1) fail("input-shape", "/v");
  if (o.readSource !== undefined && o.disagreement !== undefined)
    fail("input-agreement", "/readSource");
  return {
    v: 1 as const,
    ...(o.readSource === undefined
      ? {}
      : { readSource: parseDiagnosisReadSource(o.readSource) }),
    checkedAt: iso(o.checkedAt, "/checkedAt"),
    hint: parseHint(o.hint),
    wallet: parseWallet(o.wallet),
    profile: parseProfile(o.profile),
    ...(o.disagreement === undefined
      ? {}
      : {
          disagreement: (() => {
            const d = obj(o.disagreement, "/disagreement", [
              "network",
              "observations",
            ]);
            return {
              network: nullable(d.network, (net) =>
                network(net, "/disagreement/network"),
              ),
              observations: observations(
                d.observations,
                "/disagreement/observations",
              ),
            };
          })(),
        }),
    unavailable: nullable(o.unavailable, (item) => {
      const u = obj(item, "/unavailable", ["reason", "network"]);
      return {
        reason: oneOf(u.reason, "/unavailable/reason", UNAVAILABLE),
        network: nullable(u.network, (net) =>
          network(net, "/unavailable/network"),
        ),
      };
    }),
  };
}

function block(value: unknown, path: string): AgreedBlock {
  const o = obj(value, path, ["number", "hash", "timestamp", "baseFeePerGas"]);
  return {
    number: quantity(o.number, `${path}/number`),
    hash: hash(o.hash, `${path}/hash`),
    timestamp: quantity(o.timestamp, `${path}/timestamp`),
    baseFeePerGas: nullable(o.baseFeePerGas, (fee) =>
      quantity(fee, `${path}/baseFeePerGas`),
    ),
  };
}

function probe(value: unknown, path: string): EvmProbe {
  if (!isObj(value)) fail("input-shape", path);
  const outcome = oneOf(value.outcome, `${path}/outcome`, [
    "found-mined",
    "found-pending",
    "not-found",
    "unavailable",
    "disagree",
  ] as const);
  if (outcome === "found-pending") {
    const o = obj(value, path, ["network", "outcome", "head", "seenBy"]);
    return {
      network: evmNetwork(o.network, `${path}/network`),
      outcome,
      head: block(o.head, `${path}/head`),
      seenBy: roles(o.seenBy, `${path}/seenBy`),
    };
  }
  if (outcome === "disagree") {
    const o = obj(value, path, ["network", "outcome", "observations"]);
    return {
      network: evmNetwork(o.network, `${path}/network`),
      outcome,
      observations: observations(o.observations, `${path}/observations`),
    };
  }
  if (outcome === "unavailable") {
    const o = obj(value, path, ["network", "outcome", "reason"]);
    return {
      network: evmNetwork(o.network, `${path}/network`),
      outcome,
      reason: oneOf(o.reason, `${path}/reason`, UNAVAILABLE),
    };
  }
  const o = obj(value, path, ["network", "outcome", "head"]);
  return {
    network: evmNetwork(o.network, `${path}/network`),
    outcome,
    head: block(o.head, `${path}/head`),
  };
}

function parseTx(value: unknown): EvmTxFact {
  const p = "/found/tx";
  const o = obj(value, p, [
    "hash",
    "from",
    "to",
    "nonce",
    "value",
    "inputSelector",
    "inputBytes",
    "gas",
    "type",
    "gasPrice",
    "maxFeePerGas",
    "maxPriorityFeePerGas",
    "blockHash",
    "blockNumber",
    "transactionIndex",
  ]);
  const inputBytes = int(o.inputBytes, `${p}/inputBytes`, 0, 131_072);
  const inputSelector = nullable(
    o.inputSelector,
    (item) => text(item, `${p}/inputSelector`, SELECTOR, 10) as Hex,
  );
  if ((inputSelector !== null) !== inputBytes >= 4)
    fail("input-shape", `${p}/inputSelector`);
  const q = (key: string) =>
    nullable(o[key], (item) => quantity(item, `${p}/${key}`));
  return {
    hash: hash(o.hash, `${p}/hash`),
    from: address(o.from, `${p}/from`),
    to: nullable(o.to, (item) => address(item, `${p}/to`)),
    nonce: quantity(o.nonce, `${p}/nonce`),
    value: quantity(o.value, `${p}/value`),
    inputSelector,
    inputBytes,
    gas: quantity(o.gas, `${p}/gas`),
    type: q("type"),
    gasPrice: q("gasPrice"),
    maxFeePerGas: q("maxFeePerGas"),
    maxPriorityFeePerGas: q("maxPriorityFeePerGas"),
    blockHash: nullable(o.blockHash, (item) => hash(item, `${p}/blockHash`)),
    blockNumber: q("blockNumber"),
    transactionIndex: q("transactionIndex"),
  };
}

function parseReceipt(value: unknown): EvmReceiptFact {
  const p = "/found/receipt";
  const o = obj(value, p, [
    "transactionHash",
    "from",
    "to",
    "contractAddress",
    "status",
    "blockHash",
    "blockNumber",
    "transactionIndex",
    "gasUsed",
    "cumulativeGasUsed",
    "effectiveGasPrice",
    "logs",
    "logsTotal",
    "logsTruncated",
  ]);
  let bytes = 0;
  const logs: EvmLogFact[] = list(
    o.logs,
    `${p}/logs`,
    DIAGNOSIS_LIMITS.logs,
  ).map((item, index) => {
    const lp = `${p}/logs/${index}`;
    const l = obj(item, lp, ["address", "topics", "data", "logIndex"]);
    const topics = list(l.topics, `${lp}/topics`, 4).map((topic, position) =>
      hash(topic, `${lp}/topics/${position}`),
    );
    const logData = data(l.data, `${lp}/data`, DIAGNOSIS_LIMITS.logDataBytes);
    bytes += topics.length * 32 + (logData.length - 2) / 2;
    return {
      address: address(l.address, `${lp}/address`),
      topics,
      data: logData,
      logIndex: quantity(l.logIndex, `${lp}/logIndex`),
    };
  });
  if (bytes > DIAGNOSIS_LIMITS.logBytes) fail("input-limits", `${p}/logs`);
  const logsTotal = int(o.logsTotal, `${p}/logsTotal`, logs.length, 1_000_000);
  const logsTruncated = bool(o.logsTruncated, `${p}/logsTruncated`);
  if (logsTotal > logs.length && !logsTruncated)
    fail("input-agreement", `${p}/logsTruncated`);
  return {
    transactionHash: hash(o.transactionHash, `${p}/transactionHash`),
    from: address(o.from, `${p}/from`),
    to: nullable(o.to, (item) => address(item, `${p}/to`)),
    contractAddress: nullable(o.contractAddress, (item) =>
      address(item, `${p}/contractAddress`),
    ),
    status: oneOf(o.status, `${p}/status`, ["0x0", "0x1"] as const),
    blockHash: hash(o.blockHash, `${p}/blockHash`),
    blockNumber: quantity(o.blockNumber, `${p}/blockNumber`),
    transactionIndex: quantity(o.transactionIndex, `${p}/transactionIndex`),
    gasUsed: quantity(o.gasUsed, `${p}/gasUsed`),
    cumulativeGasUsed: quantity(o.cumulativeGasUsed, `${p}/cumulativeGasUsed`),
    effectiveGasPrice: nullable(o.effectiveGasPrice, (item) =>
      quantity(item, `${p}/effectiveGasPrice`),
    ),
    logs,
    logsTotal,
    logsTruncated,
  };
}

function parseAbiParameter(
  value: unknown,
  path: string,
  depth: number,
): AbiParameterFact {
  const o = obj(value, path, ["name", "type"], ["components"]);
  const out: AbiParameterFact = {
    name: text(o.name, `${path}/name`, null, 64),
    type: text(o.type, `${path}/type`, null, 64),
  };
  if (has(o, "components")) {
    if (depth >= 4) fail("input-limits", path);
    out.components = list(o.components, `${path}/components`, 32).map(
      (item, index) =>
        parseAbiParameter(item, `${path}/components/${index}`, depth + 1),
    );
  }
  return out;
}

function parseMethod(value: unknown): EvmMethodFact {
  const p = "/found/method";
  const o = obj(value, p, [
    "selector",
    "name",
    "source",
    "group",
    "args",
    "routerCommands",
    "nested",
  ]);
  return {
    selector: nullable(
      o.selector,
      (item) => text(item, `${p}/selector`, SELECTOR, 10) as Hex,
    ),
    name: nullable(o.name, (item) => text(item, `${p}/name`, NAME, 64)),
    source: nullable(
      o.source,
      (item) =>
        oneOf(item, `${p}/source`, [
          "builtin",
          ...ABI_SOURCES,
        ]) as EvmMethodFact["source"],
    ),
    group: nullable(
      o.group,
      (item) =>
        oneOf(item, `${p}/group`, METHOD_GROUPS) as EvmMethodFact["group"],
    ),
    args: list(o.args, `${p}/args`, DIAGNOSIS_LIMITS.methodArgs).map(
      (item, index) => {
        const a = obj(item, `${p}/args/${index}`, ["name", "type", "value"]);
        return {
          name: text(
            a.name,
            `${p}/args/${index}/name`,
            /^(?:[A-Za-z_$][A-Za-z0-9_$]{0,63})?$/,
            64,
          ),
          type: text(a.type, `${p}/args/${index}/type`, null, 64),
          value: text(a.value, `${p}/args/${index}/value`, null, 200),
        };
      },
    ),
    routerCommands: list(o.routerCommands, `${p}/routerCommands`, 32).map(
      (item, index) => text(item, `${p}/routerCommands/${index}`, COMMAND, 40),
    ),
    nested: list(o.nested, `${p}/nested`, DIAGNOSIS_LIMITS.methodNested).map(
      (item, index) => {
        const n = obj(item, `${p}/nested/${index}`, ["to", "name"]);
        return {
          to: address(n.to, `${p}/nested/${index}/to`),
          name: nullable(n.name, (name) =>
            text(name, `${p}/nested/${index}/name`, NAME, 64),
          ),
        };
      },
    ),
  };
}

function parseRevert(value: unknown): EvmRevertReplay {
  const p = "/found/revert";
  if (!isObj(value)) fail("input-shape", p);
  const outcome = oneOf(value.outcome, `${p}/outcome`, [
    "reverted",
    "succeeded",
    "unavailable",
    "disagree",
  ] as const);
  if (outcome === "disagree") {
    const o = obj(value, p, ["outcome", "atBlock", "observations"]);
    return {
      outcome,
      atBlock: nullable(o.atBlock, (item) => block(item, `${p}/atBlock`)),
      observations: observations(o.observations, `${p}/observations`),
    };
  }
  if (outcome === "reverted") {
    const o = obj(value, p, ["outcome", "atBlock", "data"]);
    return {
      outcome,
      atBlock: block(o.atBlock, `${p}/atBlock`),
      data: data(o.data, `${p}/data`, DIAGNOSIS_LIMITS.revertDataBytes),
    };
  }
  if (outcome === "succeeded") {
    const o = obj(value, p, ["outcome", "atBlock"]);
    return { outcome, atBlock: block(o.atBlock, `${p}/atBlock`) };
  }
  const o = obj(value, p, ["outcome", "atBlock", "reason"]);
  return {
    outcome,
    atBlock: nullable(o.atBlock, (item) => block(item, `${p}/atBlock`)),
    reason: oneOf(o.reason, `${p}/reason`, [
      ...UNAVAILABLE,
      "call-error",
    ] as const),
  };
}

function parseFound(value: unknown): EvmFound {
  const p = "/found";
  const o = obj(value, p, [
    "network",
    "tx",
    "txAgreement",
    "receipt",
    "receiptNullAt",
    "block",
    "heads",
    "senderNonce",
    "pendingNonce",
    "code",
    "revert",
    "method",
    "errorAbi",
    "tokens",
  ]);
  const agreement = obj(o.txAgreement, `${p}/txAgreement`, ["kind"], ["by"]);
  const txAgreement =
    agreement.kind === "agreed" && !has(agreement, "by")
      ? { kind: "agreed" as const }
      : agreement.kind === "seen"
        ? {
            kind: "seen" as const,
            by: roles(agreement.by, `${p}/txAgreement/by`),
          }
        : fail("input-shape", `${p}/txAgreement`);
  const heads = obj(o.heads, `${p}/heads`, ["latest", "safe", "finalized"]);
  const code: EvmCodeFact[] = list(
    o.code,
    `${p}/code`,
    DIAGNOSIS_LIMITS.codeFacts,
  ).map((item, index) => {
    const cp = `${p}/code/${index}`;
    const c = obj(item, cp, [
      "network",
      "address",
      "atBlock",
      "kind",
      "delegate",
    ]);
    const kind = oneOf(c.kind, `${cp}/kind`, [
      "none",
      "contract",
      "delegated",
    ] as const);
    const delegate = nullable(c.delegate, (entry) =>
      address(entry, `${cp}/delegate`),
    );
    if ((kind === "delegated") !== (delegate !== null))
      fail("input-shape", `${cp}/delegate`);
    return {
      network: evmNetwork(c.network, `${cp}/network`),
      address: address(c.address, `${cp}/address`),
      atBlock: quantity(c.atBlock, `${cp}/atBlock`),
      kind,
      delegate,
    };
  });
  const tokens: EvmTokenFact[] = list(
    o.tokens,
    `${p}/tokens`,
    DIAGNOSIS_LIMITS.tokens,
  ).map((item, index) => {
    const tp = `${p}/tokens/${index}`;
    const t = obj(item, tp, [
      "network",
      "address",
      "decimals",
      "decimalsSource",
      "symbol",
      "symbolSource",
    ]);
    const decimals = nullable(t.decimals, (entry) =>
      int(entry, `${tp}/decimals`, 0, 77),
    );
    const decimalsSource = nullable(t.decimalsSource, (entry) =>
      oneOf(entry, `${tp}/decimalsSource`, [
        "builtin",
        "workspace",
        "chain-read",
      ] as const),
    );
    const symbol = nullable(t.symbol, (entry) =>
      text(entry, `${tp}/symbol`, null, 64),
    );
    const symbolSource = nullable(t.symbolSource, (entry) =>
      oneOf(entry, `${tp}/symbolSource`, [
        "builtin",
        "workspace",
        "contract-claimed",
      ] as const),
    );
    if (
      (decimals === null) !== (decimalsSource === null) ||
      (symbol === null) !== (symbolSource === null)
    )
      fail("input-shape", tp);
    return {
      network: evmNetwork(t.network, `${tp}/network`),
      address: address(t.address, `${tp}/address`),
      decimals,
      decimalsSource,
      symbol,
      symbolSource,
    };
  });
  return {
    network: evmNetwork(o.network, `${p}/network`),
    tx: parseTx(o.tx),
    txAgreement,
    receipt: nullable(o.receipt, parseReceipt),
    receiptNullAt: nullable(o.receiptNullAt, (item) =>
      quantity(item, `${p}/receiptNullAt`),
    ),
    block: nullable(o.block, (item) => block(item, `${p}/block`)),
    heads: {
      latest: block(heads.latest, `${p}/heads/latest`),
      safe: nullable(heads.safe, (item) => block(item, `${p}/heads/safe`)),
      finalized: nullable(heads.finalized, (item) =>
        block(item, `${p}/heads/finalized`),
      ),
    },
    senderNonce: nullable(o.senderNonce, (item) => {
      const s = obj(item, `${p}/senderNonce`, ["confirmed", "atBlock"]);
      return {
        confirmed: quantity(s.confirmed, `${p}/senderNonce/confirmed`),
        atBlock: quantity(s.atBlock, `${p}/senderNonce/atBlock`),
      };
    }),
    pendingNonce: nullable(o.pendingNonce, (item) => {
      const s = obj(item, `${p}/pendingNonce`, ["primary", "confirmation"]);
      return {
        primary: nullable(s.primary, (entry) =>
          quantity(entry, `${p}/pendingNonce/primary`),
        ),
        confirmation: nullable(s.confirmation, (entry) =>
          quantity(entry, `${p}/pendingNonce/confirmation`),
        ),
      };
    }),
    code,
    revert: nullable(o.revert, parseRevert),
    method: nullable(o.method, parseMethod),
    errorAbi: nullable(o.errorAbi, (item) => {
      const e = obj(item, `${p}/errorAbi`, ["source", "items"]);
      return {
        source: oneOf(
          e.source,
          `${p}/errorAbi/source`,
          ABI_SOURCES,
        ) as VerifiedAbiSource,
        items: list(
          e.items,
          `${p}/errorAbi/items`,
          DIAGNOSIS_LIMITS.errorAbiItems,
        ).map((entry, index): EvmAbiErrorItem => {
          const ip = `${p}/errorAbi/items/${index}`;
          const i = obj(entry, ip, ["type", "name", "inputs"]);
          if (i.type !== "error") fail("input-shape", `${ip}/type`);
          return {
            type: "error",
            name: text(i.name, `${ip}/name`, null, 64),
            inputs: list(i.inputs, `${ip}/inputs`, 32).map((input, position) =>
              parseAbiParameter(input, `${ip}/inputs/${position}`, 0),
            ),
          };
        }),
      };
    }),
    tokens,
  };
}

function parseEvm(value: Obj): EvmDiagnosisInput {
  const o = obj(
    value,
    "",
    [
      "v",
      "kind",
      "checkedAt",
      "hint",
      "wallet",
      "profile",
      "unavailable",
      "hash",
      "probes",
      "found",
      "previous",
    ],
    ["disagreement", "readSource"],
  );
  const common = parseCommon(o);
  if (typeof o.hash !== "string" || !HASH.test(o.hash))
    fail("input-subject", "/hash");
  const subject = o.hash as Hex;
  const probes = list(o.probes, "/probes", DIAGNOSIS_LIMITS.probes, 1).map(
    (item, index) => probe(item, `/probes/${index}`),
  );
  if (new Set(probes.map((item) => item.network)).size !== probes.length)
    fail("input-agreement", "/probes");
  const found = nullable(o.found, parseFound);
  const previous: EvmPreviousSighting | null = nullable(o.previous, (item) => {
    const s = obj(item, "/previous", [
      "network",
      "from",
      "nonce",
      "seenAt",
      "seenBy",
      "confirmedNonceNow",
    ]);
    return {
      network: evmNetwork(s.network, "/previous/network"),
      from: address(s.from, "/previous/from"),
      nonce: quantity(s.nonce, "/previous/nonce"),
      seenAt: iso(s.seenAt, "/previous/seenAt"),
      seenBy: roles(s.seenBy, "/previous/seenBy"),
      confirmedNonceNow: nullable(s.confirmedNonceNow, (entry) => {
        const c = obj(entry, "/previous/confirmedNonceNow", [
          "value",
          "atBlock",
        ]);
        return {
          value: quantity(c.value, "/previous/confirmedNonceNow/value"),
          atBlock: quantity(c.atBlock, "/previous/confirmedNonceNow/atBlock"),
        };
      }),
    };
  });
  const input: EvmDiagnosisInput = {
    ...common,
    kind: "evm",
    hash: subject,
    probes,
    found,
    previous,
  };
  checkEvmAgreement(input);
  return input;
}

function checkEvmAgreement(input: EvmDiagnosisInput): void {
  if (
    input.readSource &&
    (input.probes.some(
      (p) =>
        p.outcome === "disagree" ||
        (p.outcome === "found-pending" && p.seenBy.includes("confirmation")),
    ) ||
      (input.found?.txAgreement.kind === "seen" &&
        input.found.txAgreement.by.includes("confirmation")))
  )
    fail("input-agreement", "/readSource");
  const disagree = (path: string): never => fail("input-agreement", path);
  const found = input.found;
  const hint =
    input.hint && input.hint.network !== "solana" ? input.hint.network : null;
  const selected = selectFoundProbe(input.probes, hint);
  if (!found) {
    if (selected !== null) disagree("/found");
    return;
  }
  const index = input.probes.findIndex(
    (item) => item.network === found.network,
  );
  if (index < 0 || index !== selected) disagree("/found/network");
  const { tx, receipt, block: inclusion, heads } = found;
  if (tx.hash !== input.hash) disagree("/found/tx/hash");
  const latest = big(heads.latest.number);
  if (heads.finalized && big(heads.finalized.number) > latest)
    disagree("/found/heads/finalized");
  if (heads.safe && big(heads.safe.number) > latest)
    disagree("/found/heads/safe");
  if (input.probes[index].outcome === "found-mined") {
    if (!receipt || !inclusion) return disagree("/found/receipt");
    if (found.txAgreement.kind !== "agreed" || found.receiptNullAt !== null)
      disagree("/found/txAgreement");
    if (receipt.transactionHash !== input.hash)
      disagree("/found/receipt/transactionHash");
    if (receipt.blockHash !== inclusion.hash || tx.blockHash !== inclusion.hash)
      disagree("/found/receipt/blockHash");
    if (
      receipt.blockNumber !== inclusion.number ||
      tx.blockNumber !== inclusion.number
    )
      disagree("/found/receipt/blockNumber");
    if (tx.transactionIndex !== receipt.transactionIndex)
      disagree("/found/receipt/transactionIndex");
    if (receipt.from !== tx.from || receipt.to !== tx.to)
      disagree("/found/receipt/from");
    if (big(inclusion.number) > latest) disagree("/found/block");
    if (big(receipt.gasUsed) > big(tx.gas)) disagree("/found/receipt/gasUsed");
    if (found.revert && receipt.status !== "0x0") disagree("/found/revert");
  } else {
    if (receipt || inclusion || found.revert) disagree("/found/receipt");
    if (
      tx.blockNumber !== null ||
      tx.blockHash !== null ||
      tx.transactionIndex !== null
    )
      disagree("/found/tx/blockNumber");
    if (found.txAgreement.kind !== "seen") disagree("/found/txAgreement");
  }
}

function parseSolanaError(value: unknown, path: string): SolanaTxError {
  if (!isObj(value)) fail("input-shape", path);
  switch (value.kind) {
    case "instruction": {
      const o = obj(value, path, ["kind", "index", "error"]);
      const e = obj(o.error, `${path}/error`, ["kind"], ["code", "name"]);
      const error =
        e.kind === "custom" && !has(e, "name")
          ? {
              kind: "custom" as const,
              code: int(e.code, `${path}/error/code`, 0, 0xffffffff),
            }
          : e.kind === "builtin" && !has(e, "code")
            ? {
                kind: "builtin" as const,
                name: text(e.name, `${path}/error/name`, SOL_NAME, 64),
              }
            : fail("input-shape", `${path}/error`);
      return {
        kind: "instruction",
        index: int(o.index, `${path}/index`, 0, 255),
        error,
      };
    }
    case "insufficient-funds-for-rent": {
      const o = obj(value, path, ["kind", "accountIndex"]);
      return {
        kind: "insufficient-funds-for-rent",
        accountIndex: int(o.accountIndex, `${path}/accountIndex`, 0, 255),
      };
    }
    case "transaction": {
      const o = obj(value, path, ["kind", "name"]);
      return {
        kind: "transaction",
        name: text(o.name, `${path}/name`, SOL_NAME, 64),
      };
    }
    case "unknown": {
      const o = obj(value, path, ["kind", "raw"]);
      return { kind: "unknown", raw: text(o.raw, `${path}/raw`, null, 200) };
    }
    default:
      return fail("input-shape", path);
  }
}

function parseStatus(value: unknown): SolanaStatusFact {
  const p = "/status";
  if (!isObj(value)) fail("input-shape", p);
  if (value.kind === "agreed" && value.found === false) {
    obj(value, p, ["kind", "found"]);
    return { kind: "agreed", found: false };
  }
  if (value.kind === "agreed" && value.found === true) {
    const o = obj(value, p, ["kind", "found", "slot", "commitment", "err"]);
    return {
      kind: "agreed",
      found: true,
      slot: int(o.slot, `${p}/slot`, 0, Number.MAX_SAFE_INTEGER),
      commitment: oneOf(o.commitment, `${p}/commitment`, [
        "confirmed",
        "finalized",
      ] as const),
      err: nullable(o.err, (item) => parseSolanaError(item, `${p}/err`)),
    };
  }
  if (value.kind === "seen") {
    const o = obj(value, p, ["kind", "by", "slot", "commitment", "err"]);
    return {
      kind: "seen",
      by: roles(o.by, `${p}/by`),
      slot: int(o.slot, `${p}/slot`, 0, Number.MAX_SAFE_INTEGER),
      commitment: oneOf(o.commitment, `${p}/commitment`, [
        "processed",
      ] as const),
      err: nullable(o.err, (item) => parseSolanaError(item, `${p}/err`)),
    };
  }
  return fail("input-shape", p);
}

function parseTokenBalances(
  value: unknown,
  path: string,
  accounts: number,
): SolanaTokenBalanceFact[] {
  return list(value, path, DIAGNOSIS_LIMITS.solanaTokenBalances).map(
    (item, index) => {
      const bp = `${path}/${index}`;
      const b = obj(item, bp, [
        "accountIndex",
        "mint",
        "owner",
        "programId",
        "amount",
        "decimals",
      ]);
      return {
        accountIndex: int(
          b.accountIndex,
          `${bp}/accountIndex`,
          0,
          accounts - 1,
        ),
        mint: solAddress(b.mint, `${bp}/mint`),
        owner: nullable(b.owner, (entry) => solAddress(entry, `${bp}/owner`)),
        programId: nullable(b.programId, (entry) =>
          solAddress(entry, `${bp}/programId`),
        ),
        amount: text(b.amount, `${bp}/amount`, DIGITS, 20),
        decimals: int(b.decimals, `${bp}/decimals`, 0, 255),
      };
    },
  );
}

function parseInstruction(value: unknown, path: string): SolanaInstructionFact {
  const o = obj(value, path, ["programId", "program", "type", "info", "data"]);
  return {
    programId: solAddress(o.programId, `${path}/programId`),
    program: nullable(o.program, (item) =>
      text(item, `${path}/program`, PROGRAM, 48),
    ),
    type: nullable(o.type, (item) => text(item, `${path}/type`, TYPE, 48)),
    info: nullable(o.info, (item) => {
      const i = obj(item, `${path}/info`, [], INFO_KEYS);
      const out: NonNullable<SolanaInstructionFact["info"]> = {};
      for (const key of INFO_KEYS) {
        if (!has(i, key)) continue;
        const field = key as keyof typeof out;
        out[field] =
          key === "amount" || key === "lamports"
            ? text(i[key], `${path}/info/${key}`, DIGITS, 20)
            : solAddress(i[key], `${path}/info/${key}`);
      }
      return out;
    }),
    data: nullable(o.data, (item) => text(item, `${path}/data`, BASE58, 1_700)),
  };
}

function parseSolanaTx(value: unknown): SolanaTxFact {
  const p = "/tx";
  const o = obj(value, p, [
    "slot",
    "blockTime",
    "version",
    "commitment",
    "err",
    "fee",
    "computeUnitsConsumed",
    "accountKeys",
    "recentBlockhash",
    "instructions",
    "innerProgramIds",
    "balances",
    "preTokenBalances",
    "postTokenBalances",
    "logMessages",
    "logsTruncated",
  ]);
  const accountKeys = list(
    o.accountKeys,
    `${p}/accountKeys`,
    DIAGNOSIS_LIMITS.solanaAccounts,
    1,
  ).map((item, index) => {
    const k = obj(item, `${p}/accountKeys/${index}`, [
      "pubkey",
      "signer",
      "writable",
      "source",
    ]);
    return {
      pubkey: solAddress(k.pubkey, `${p}/accountKeys/${index}/pubkey`),
      signer: bool(k.signer, `${p}/accountKeys/${index}/signer`),
      writable: bool(k.writable, `${p}/accountKeys/${index}/writable`),
      source: oneOf(k.source, `${p}/accountKeys/${index}/source`, [
        "transaction",
        "lookupTable",
      ] as const),
    };
  });
  const balances = obj(o.balances, `${p}/balances`, ["exact", "pre", "post"]);
  const lamports = (key: "pre" | "post") => {
    const items = list(
      balances[key],
      `${p}/balances/${key}`,
      DIAGNOSIS_LIMITS.solanaAccounts,
    ).map((item, index) =>
      text(item, `${p}/balances/${key}/${index}`, DIGITS, 20),
    );
    if (items.length !== accountKeys.length)
      fail("input-shape", `${p}/balances/${key}`);
    return items;
  };
  const innerProgramIds = list(
    o.innerProgramIds,
    `${p}/innerProgramIds`,
    DIAGNOSIS_LIMITS.solanaInnerPrograms,
  ).map((item, index) => solAddress(item, `${p}/innerProgramIds/${index}`));
  if (new Set(innerProgramIds).size !== innerProgramIds.length)
    fail("input-shape", `${p}/innerProgramIds`);
  const version =
    o.version === 0
      ? (0 as const)
      : oneOf(o.version, `${p}/version`, ["legacy"] as const);
  return {
    slot: int(o.slot, `${p}/slot`, 0, Number.MAX_SAFE_INTEGER),
    blockTime: nullable(o.blockTime, (item) =>
      int(item, `${p}/blockTime`, 0, Number.MAX_SAFE_INTEGER),
    ),
    version,
    commitment: oneOf(o.commitment, `${p}/commitment`, [
      "confirmed",
      "finalized",
    ] as const),
    err: nullable(o.err, (item) => parseSolanaError(item, `${p}/err`)),
    fee: text(o.fee, `${p}/fee`, DIGITS, 20),
    computeUnitsConsumed: nullable(o.computeUnitsConsumed, (item) =>
      int(item, `${p}/computeUnitsConsumed`, 0, Number.MAX_SAFE_INTEGER),
    ),
    accountKeys,
    recentBlockhash: solAddress(o.recentBlockhash, `${p}/recentBlockhash`),
    instructions: list(
      o.instructions,
      `${p}/instructions`,
      DIAGNOSIS_LIMITS.solanaInstructions,
    ).map((item, index) =>
      parseInstruction(item, `${p}/instructions/${index}`),
    ),
    innerProgramIds,
    balances: {
      exact: bool(balances.exact, `${p}/balances/exact`),
      pre: lamports("pre"),
      post: lamports("post"),
    },
    preTokenBalances: parseTokenBalances(
      o.preTokenBalances,
      `${p}/preTokenBalances`,
      accountKeys.length,
    ),
    postTokenBalances: parseTokenBalances(
      o.postTokenBalances,
      `${p}/postTokenBalances`,
      accountKeys.length,
    ),
    logMessages: list(
      o.logMessages,
      `${p}/logMessages`,
      DIAGNOSIS_LIMITS.solanaLogLines,
    ).map((item, index) =>
      text(
        item,
        `${p}/logMessages/${index}`,
        null,
        DIAGNOSIS_LIMITS.solanaLogLineChars,
      ),
    ),
    logsTruncated: bool(o.logsTruncated, `${p}/logsTruncated`),
  };
}

function height(value: unknown, path: string): SolanaHeight {
  const o = obj(value, path, ["blockHeight", "slot", "at"]);
  return {
    blockHeight: int(
      o.blockHeight,
      `${path}/blockHeight`,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    slot: int(o.slot, `${path}/slot`, 0, Number.MAX_SAFE_INTEGER),
    at: iso(o.at, `${path}/at`),
  };
}

function parseSolana(value: Obj): SolanaDiagnosisInput {
  const o = obj(
    value,
    "",
    [
      "v",
      "kind",
      "checkedAt",
      "hint",
      "wallet",
      "profile",
      "unavailable",
      "signature",
      "providers",
      "status",
      "tx",
      "heights",
      "previous",
    ],
    ["disagreement", "readSource"],
  );
  const common = parseCommon(o);
  if (typeof o.signature !== "string" || !isSolanaSignature(o.signature))
    fail("input-subject", "/signature");
  const providers = obj(o.providers, "/providers", ["archival"]);
  const heights = obj(o.heights, "/heights", ["firstCheck", "current"]);
  const input: SolanaDiagnosisInput = {
    ...common,
    kind: "solana",
    signature: o.signature,
    providers: { archival: bool(providers.archival, "/providers/archival") },
    status: parseStatus(o.status),
    tx: nullable(o.tx, parseSolanaTx),
    heights: {
      firstCheck: height(heights.firstCheck, "/heights/firstCheck"),
      current: height(heights.current, "/heights/current"),
    },
    previous: nullable(o.previous, (item) => {
      const s = obj(item, "/previous", ["seenAt", "commitment"]);
      return {
        seenAt: iso(s.seenAt, "/previous/seenAt"),
        commitment: oneOf(s.commitment, "/previous/commitment", [
          "processed",
          "confirmed",
          "finalized",
        ] as const),
      };
    }),
  };
  const { status, tx } = input;
  if (
    input.readSource &&
    status.kind === "seen" &&
    status.by.includes("confirmation")
  )
    fail("input-agreement", "/readSource");
  if (input.heights.current.blockHeight < input.heights.firstCheck.blockHeight)
    fail("input-agreement", "/heights");
  if (tx && (status.kind === "seen" || status.found)) {
    if (status.slot !== tx.slot) fail("input-agreement", "/tx/slot");
    if (
      status.kind === "agreed" &&
      JSON.stringify(status.err) !== JSON.stringify(tx.err)
    )
      fail("input-agreement", "/tx/err");
  }
  return input;
}

/** Validates a diagnosis input and returns a fresh copy. Fails closed with
 * DiagnosisInputError on any unknown key, bad pattern, exceeded cap or
 * contradiction between facts. */
export function parseDiagnosisInput(value: unknown): DiagnosisInput {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    fail("input-shape", "");
  }
  if (typeof json !== "string") fail("input-shape", "");
  if (json.length > DIAGNOSIS_LIMITS.inputChars) fail("input-limits", "");
  if (!isObj(value)) fail("input-shape", "");
  if (value.kind === "evm") return parseEvm(value);
  if (value.kind === "solana") return parseSolana(value);
  return fail("input-shape", "/kind");
}
