import { MEMBER_NETWORK_NAMES } from "@templ/chat/diagnosis/networks";
import type {
  FailureReason,
  MemberTemplateId,
  NextStepId,
  UnavailableReason,
} from "./types";

/** Staff and member copy. It follows .agents/skills/no-ai-slop: plain
 * sentences, no em dashes, no colon reveals. Member text never says "your",
 * never names a full address or hash, never links, and never carries
 * contract- or program-supplied text. */

/** Replaces {name} placeholders. A value that is missing falls back to
 * `defaults`, then to an empty string, so a placeholder never leaks. */
export function fill(
  template: string,
  values: Readonly<Record<string, string | number | undefined>>,
  defaults: Readonly<Record<string, string>> = {},
): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = values[key];
    if (value !== undefined && value !== "") return String(value);
    return defaults[key] ?? "";
  });
}

export const STAFF_TEXT = {
  "dx.unavailable": "Couldn't check {network} because {reasonText}.",
  "dx.unavailable.any": "Couldn't check this transaction because {reasonText}.",
  "dx.input-invalid":
    "Couldn't check this transaction because the chain data Templ read failed its own checks.",
  "dx.hint-mismatch":
    "The user picked {hintNetwork}, but this is {subjectKind}.",
  "dx.wallet-signed-match": "Sent from the user's signed wallet {short}.",
  "dx.wallet-claimed-match":
    "Sent from {short}, the wallet the user's app reported. That wallet isn't proven.",
  "dx.wallet-signed-mismatch":
    "Sent from {from}, not the user's signed wallet {wallet}.",
  "dx.wallet-claimed-mismatch":
    "Sent from {from}, not the wallet the user's app reported ({wallet}).",
  "evm.not-found": "Templ didn't find this transaction on {networkList}.",
  "evm.probe-unavailable":
    "{network} couldn't be checked, so the transaction may be there.",
  "evm.vanished":
    "It was waiting in a mempool at {time}, but no provider has it now. Nonce {nonce} is still unused, so it can still go through if it's sent again.",
  "evm.other-network": "Found on {foundNetwork}, not on {hintNetwork}.",
  "evm.unexpected-network":
    "Found on {network}, which isn't one of the protocol's networks in the workspace profile.",
  "evm.found-on-several":
    "The same hash exists on {networkList}. This check shows {network}.",
  "evm.pending": "Waiting to go into a block. Seen by {n} of 2 providers.",
  "evm.pending.next-nonce":
    "Waiting to go into a block. Seen by {n} of 2 providers. Its nonce {nonce} is the wallet's next one.",
  "evm.nonce-gap":
    "Waiting behind earlier transactions. It uses nonce {nonce}, and the wallet's next confirmed nonce is {confirmed}, so nonces {confirmed} to {nonceMinusOne} must go through first.",
  "evm.underpriced":
    "Waiting because its max fee of {fee} gwei is below the current base fee of {baseFee} gwei.",
  "evm.replaced":
    "It won't go through. Nonce {nonce} of {from} was used by another transaction, so this one was replaced or cancelled.",
  "evm.revert.error-string":
    'Reverted with the contract\'s message "{text}" when replayed at block {parent}.',
  "evm.revert.panic":
    "Reverted with a Solidity panic, code {code} ({meaning}), when replayed at block {parent}.",
  "evm.revert.custom-known":
    "Reverted with {name}{args} when replayed at block {parent}.",
  "evm.revert.execution-failed":
    "Reverted when replayed at block {parent}. Universal Router command {index} failed with {innerName}.",
  "evm.revert.custom-verified":
    "Reverted with {name}{args}, named by the verified source on {abiSource}, when replayed at block {parent}.",
  "evm.revert.unknown-selector":
    "Reverted with error {selector}, which no ABI Templ has can name.",
  "evm.revert.no-data":
    "Reverted without a reason when replayed at block {parent}.",
  "evm.revert.not-reproduced":
    "Failed on chain, but the replay at block {parent} succeeded. The state changed between the two, so the reason couldn't be read.",
  "evm.revert.no-replay":
    "Failed on chain. The replay at block {parent} didn't work on the providers, so the reason couldn't be read.",
  "evm.revert.no-replay.none":
    "Failed on chain. Templ has no replay of it, so the reason couldn't be read.",
  "evm.out-of-gas.exact":
    "Ran out of gas. It used all {gasLimit} of its gas limit.",
  "evm.out-of-gas.likely":
    "Probably ran out of gas inside a contract call. It used {gasUsed} of its {gasLimit} gas limit and reverted without a reason.",
  "evm.succeeded": "Succeeded in {network} block {block}.",
  "evm.not-finalized":
    "Not final yet. It has {confirmations} confirmations, and the finalized block is {finalized}.",
  "evm.not-finalized.no-head":
    "Not final yet. It has {confirmations} confirmations, and the providers didn't report a finalized block.",
  "evm.token-movement": "{count} token movements involve {subjectShort}.",
  "evm.token-movement.one": "1 token movement involves {subjectShort}.",
  "evm.approval-only":
    "Only an approval went through. {spender} may now spend {amount} {token} from {subjectShort}. No tokens moved.",
  "evm.unlimited-approval":
    "{spender} may spend an unlimited amount of {token} from {subjectShort}.",
  "evm.unlimited-approval.for-all":
    "{spender} may move every {token} token that {subjectShort} holds.",
  "evm.unlimited-approval.unlabeled":
    "The spender isn't one of the protocol's labeled contracts.",
  "evm.vault-deposit":
    "The vault {vault} took {assets} {asset} and issued {shares} shares to {owner}.",
  "evm.vault-withdraw":
    "The vault {vault} paid {assets} {asset} to {receiver} for {shares} shares.",
  "evm.swap": "Swapped {outAmount} {outToken} for {inAmount} {inToken}.",
  "evm.swap.unwrap":
    "Swapped {outAmount} {outToken} for ETH sent inside the call. The ETH amount isn't in the logs.",
  "evm.swap.unclear":
    "Swapped through {to}, but the logs don't show one token out and a different token in for {subjectShort}.",
  "evm.no-movement":
    "Succeeded, but no token moved to or from {subjectShort} in it. ETH sent inside contract calls doesn't show here.",
  "evm.call-to-empty-address":
    "Called {to}, which has no contract on {network}. Nothing ran there.",
  "evm.call-to-empty-address.value": "{value} {native} went to that address.",
  "evm.recipient-code-elsewhere":
    "{address} has a contract on {otherNetworks} but no code on {network}.",
  "evm.sent-to-token-contract":
    "{amount} {token} went to the {token} contract itself.",
  "evm.sent-to-protocol-contract":
    "{amount} {token} went straight to {label} with a plain transfer instead of its deposit function.",
  "evm.bridge-source":
    "The source step on {network} went through ({bridge}, destination {destination}). Templ doesn't check delivery on the destination network.",
  "evm.bridge-source.label":
    "The source step on {network} went through ({bridge}). Templ doesn't check delivery on the destination network.",
  "evm.contract-creation": "Created a contract at {address}.",
  "evm.relayed-userop":
    "Sent by a bundler for the smart account {sender} (ERC-4337).",
  "evm.relayed-userop.ambiguous":
    "The bundle holds {n} smart-account operations, and none matches the user's wallet.",
  "evm.relayed-userop.none":
    "Sent to an ERC-4337 EntryPoint, but its logs hold no operation event.",
  "evm.userop-failed":
    "The bundle went through, but the smart account's operation failed.",
  "evm.userop.error-string":
    'The operation reverted with the contract\'s message "{text}".',
  "evm.userop.panic":
    "The operation reverted with a Solidity panic, code {code} ({meaning}).",
  "evm.userop.custom": "The operation reverted with {name}{args}.",
  "evm.userop.unknown-selector":
    "The operation reverted with error {selector}, which no ABI Templ has can name.",
  "evm.userop.no-data": "The operation reverted without a reason.",
  "evm.logs-truncated": "Showing the first {shown} of {total} logs.",
  "sol.not-found": "Neither provider has this signature on Solana mainnet yet.",
  "sol.expired":
    "Neither provider has this signature, and {n} blocks have passed since Templ first checked. A normal Solana transaction expires 151 blocks after its blockhash, so this one won't run. A transaction that uses a durable nonce doesn't expire this way.",
  "sol.processed":
    "A validator has it in a block, but it isn't confirmed yet. Seen by {n} of 2 providers.",
  "sol.succeeded": "Succeeded in slot {slot}.",
  "sol.not-finalized": "Confirmed, not finalized yet.",
  "sol.token-movement": "{count} token balance changes involve {subjectShort}.",
  "sol.token-movement.one": "1 token balance change involves {subjectShort}.",
  "sol.sol-movement":
    "{subjectShort} sent or received {amount} SOL, not counting the fee.",
  "sol.swap": "Swapped {outAmount} {outToken} for {inAmount} {inToken}{via}.",
  "sol.swap.unclear":
    "Swapped through {via}, but the balance changes don't show one token out and a different token in for {subjectShort}.",
  "sol.approval-only":
    "Only a token delegate was set. {delegate} may move up to {amount} {token} from {account}. No tokens moved.",
  "sol.unlimited-approval":
    "{delegate} may move any amount of {token} from {account}.",
  "sol.program-error.anchor":
    '{program} failed with {name} (error {code}). The program\'s message is "{message}".',
  "sol.program-error.known": "{program} failed with {name} (error {code}).",
  "sol.program-error.custom":
    "{program} failed with error {code} ({hex}), which Templ can't name.",
  "sol.instruction-error":
    "Instruction {index} ({program}) failed with {name}.",
  "sol.insufficient-funds":
    "Failed because an account didn't have enough {asset}.",
  "sol.insufficient-fee":
    "Failed because the fee payer {payer} couldn't cover the fee.",
  "sol.insufficient-rent":
    "Failed because account {index} ({address}) would have dropped below Solana's minimum balance for an account.",
  "sol.compute-exceeded":
    "Failed because it used up its compute limit of {limit} units.",
  "sol.compute-exceeded.default":
    "Failed because it used up its compute limit. The transaction didn't set one, so the network default applied.",
  "sol.tx-error": "Failed with {name}.",
  "sol.tx-error.unknown": "Failed with an error Templ can't name ({raw}).",
  "sol.fee": "Fee {fee} SOL.",
  "sol.fee.price":
    "It paid {price} micro-lamports per compute unit as a priority fee.",
  "sol.bridge-source":
    "The source step on Solana went through ({label}). Templ doesn't check delivery on the destination network.",
  "sol.no-movement":
    "Succeeded, but no token or SOL balance of {subjectShort} changed in it, apart from the fee.",
  "sol.logs-truncated":
    "Solana cut this transaction's logs short, so some program messages are missing.",
} as const;
export type StaffTextKey = keyof typeof STAFF_TEXT;

export function staffText(
  key: StaffTextKey,
  values: Readonly<Record<string, string | number | undefined>> = {},
): string {
  return fill(STAFF_TEXT[key], values);
}

export const UNAVAILABLE_TEXT: Readonly<Record<UnavailableReason, string>> = {
  "provider-error": "a provider didn't answer",
  budget: "the workspace's chain-read limit is used up",
  "not-configured": "Templ doesn't check this network yet",
  "stale-head": "the providers' latest block was too old",
};

/** The sentence a revert finding adds for its reason. */
export const REASON_TEXT: Readonly<Record<FailureReason, string>> = {
  slippage: "The price moved more than the slippage limit allowed.",
  deadline: "It reached the chain after its time limit.",
  allowance: "The spending limit was lower than the amount.",
  balance: "The sender held less than the amount.",
  "fee-balance": "The fee payer couldn't cover the fee.",
  rent: "An account would have dropped below Solana's minimum balance.",
  "vault-limit": "The amount was above the vault's current limit.",
  paused: "The contract was paused.",
  unauthorized: "The caller isn't allowed to do this.",
  signature: "A signature or permit was expired or invalid.",
  "transfer-failed": "A token transfer inside the call failed.",
  "out-of-gas": "It ran out of gas.",
  compute: "It used up its compute limit.",
  arithmetic: "Often a balance or allowance that was too small.",
  other: "",
};

export const NEXT_STEPS: Readonly<
  Record<NextStepId, { text: string; needsNewTransaction: boolean }>
> = {
  "ns.recheck": {
    text: "Run the check again in a minute. If it keeps failing, look it up on {explorer}.",
    needsNewTransaction: false,
  },
  "ns.ask-network": {
    text: "Ask which network they used. Templ checked {networkList}.",
    needsNewTransaction: false,
  },
  "ns.not-found-wait": {
    text: "If they sent it in the last few minutes, run the check again soon. If they use a smart wallet, ask for the transaction hash from the explorer, because some apps show an operation hash instead.",
    needsNewTransaction: false,
  },
  "ns.wait": {
    text: "Nothing to do yet. Run the check again in a few minutes.",
    needsNewTransaction: false,
  },
  "ns.nonce-gap": {
    text: "An earlier transaction from this wallet is stuck, and this one waits for it. Their wallet shows it as pending. Clearing it needs a new transaction from their wallet, which only they can start.",
    needsNewTransaction: true,
  },
  "ns.underpriced": {
    text: "It can still go through if the base fee drops. Speeding it up needs a new transaction from their wallet, which only they can start.",
    needsNewTransaction: true,
  },
  "ns.replaced": {
    text: "Ask for the hash of the transaction that replaced it, or look up {from} on {explorer} and find nonce {nonce}.",
    needsNewTransaction: false,
  },
  "ns.slippage": {
    text: "Explain the slippage limit. Trying again needs a new quote and a new transaction in the app, which only they can start.",
    needsNewTransaction: true,
  },
  "ns.deadline": {
    text: "It reached the chain after its time limit. Trying again needs a new transaction in the app, which only they can start.",
    needsNewTransaction: true,
  },
  "ns.allowance": {
    text: "The spending limit was lower than the amount. A new approval in the app fixes it, and only they can start it. Point them to the app, not to a link in chat.",
    needsNewTransaction: true,
  },
  "ns.balance": {
    text: "The wallet held too little {token} at that block. Check for a fee-on-transfer token or an earlier transaction that spent it.",
    needsNewTransaction: false,
  },
  "ns.vault-limit": {
    text: "The vault refused the amount because it's above the vault's current limit. Check the vault's cap or withdrawal limit.",
    needsNewTransaction: false,
  },
  "ns.paused": {
    text: "{pausedState} Check with your team whether that was on purpose.",
    needsNewTransaction: false,
  },
  "ns.unauthorized": {
    text: "The wallet isn't allowed to call this. Check whether they used the right account.",
    needsNewTransaction: false,
  },
  "ns.signature": {
    text: "The signed permit was expired or invalid. A new one comes from the app, and only they can sign it.",
    needsNewTransaction: true,
  },
  "ns.out-of-gas": {
    text: "The gas limit was too low. Check whether your app sets the gas limit for this action. A new attempt needs a new transaction.",
    needsNewTransaction: true,
  },
  "ns.compute": {
    text: "The compute limit was too low. Check whether your app sets it for this action. A new attempt needs a new transaction.",
    needsNewTransaction: true,
  },
  "ns.rent": {
    text: "The transaction would have left an account below Solana's minimum balance. Usually the wallet tried to spend nearly all its SOL.",
    needsNewTransaction: false,
  },
  "ns.escalate": {
    text: "Share the transaction and the error with your engineers.",
    needsNewTransaction: false,
  },
  "ns.indexer": {
    text: "The chain shows the {category}. If your app shows an old balance, check your indexer or front-end cache.",
    needsNewTransaction: false,
  },
  "ns.approval-only": {
    text: "The approval went through, but the next step never ran. Ask whether they finished it in the app.",
    needsNewTransaction: false,
  },
  "ns.unlimited-approval": {
    text: "If they didn't mean to let {spender} spend their {token}, treat it as a possible scam approval and escalate. Removing it needs a new transaction from their wallet.",
    needsNewTransaction: true,
  },
  "ns.no-movement": {
    text: "No tokens moved for this wallet. If your protocol queues withdrawals or claims, check the queue for this wallet.",
    needsNewTransaction: false,
  },
  "ns.empty-address": {
    text: "Check whether {to} is your contract on another network. Escalate to your engineers before you promise anything about the funds.",
    needsNewTransaction: false,
  },
  "ns.sent-to-token": {
    text: "Tokens sent to a token's own contract usually can't come back. Escalate to your engineers and don't promise recovery.",
    needsNewTransaction: false,
  },
  "ns.sent-to-protocol": {
    text: "Escalate to your engineers. Whether {label} can return a plain transfer depends on the contract.",
    needsNewTransaction: false,
  },
  "ns.bridge": {
    text: "Check delivery with the bridge's own status page.",
    needsNewTransaction: false,
  },
  "ns.wallet-mismatch": {
    text: "The sender isn't the wallet they signed in with. Ask them to verify {from} before you share account details.",
    needsNewTransaction: false,
  },
  "ns.unexpected-network": {
    text: "The profile says the protocol doesn't run on {network}. Escalate before you promise anything about the funds.",
    needsNewTransaction: false,
  },
  "ns.expired": {
    text: "It never ran and nothing moved. Doing it again needs a new transaction in the app.",
    needsNewTransaction: true,
  },
  "ns.sol-not-found": {
    text: "If they sent it in the last minute, run the check again soon. Templ checks Solana mainnet only.",
    needsNewTransaction: false,
  },
  "ns.none": { text: "Nothing to fix on chain.", needsNewTransaction: false },
};

/** Values a next step uses when the facts don't supply one. */
export const NEXT_STEP_DEFAULTS: Readonly<Record<string, string>> = {
  explorer: "a block explorer",
  networkList: "the networks it supports",
  from: "the sender",
  nonce: "of this transaction",
  token: "the token",
  category: "transaction",
  spender: "the spender",
  to: "the address",
  label: "the contract",
  network: "this network",
  pausedState: "The contract was paused.",
};

export function nextStepText(
  id: NextStepId,
  values: Readonly<Record<string, string | undefined>> = {},
): string {
  return fill(NEXT_STEPS[id].text, values, NEXT_STEP_DEFAULTS);
}

export const MEMBER_NOUNS = [
  "deposit",
  "withdrawal",
  "swap",
  "transfer",
  "transaction",
] as const;
export type MemberSlotName =
  | "network"
  | "foundNetwork"
  | "hintNetwork"
  | "networks"
  | "noun"
  | "block"
  | "slot"
  | "token"
  | "outToken"
  | "inToken"
  | "amount"
  | "outAmount"
  | "inAmount"
  | "pausedState";
/** Slot values offered to a member template. Callers offer a token label
 * only when it came from Templ's reviewed list or the workspace profile, and
 * an amount only when its decimals did too. */
export type MemberSlots = Partial<Record<MemberSlotName, string>>;

const TOKEN_LABEL = /^[A-Za-z0-9.+-]{1,12}$/;
const AMOUNT = /^(?:\d{1,3}(?:,\d{3})*(?:\.\d{1,6})?|<0\.000001)$/;
const HEIGHT = /^\d{1,3}(?:,\d{3})*$/;

function validNetworkList(value: string): boolean {
  const last = value.lastIndexOf(" or ");
  const names =
    last < 0
      ? [value]
      : [...value.slice(0, last).split(", "), value.slice(last + 4)];
  return (
    names.length > 0 && names.every((name) => MEMBER_NETWORK_NAMES.has(name))
  );
}

/** The only values a member slot accepts. */
export function validMemberSlot(
  name: string,
  value: string | undefined,
): boolean {
  if (typeof value !== "string") return false;
  switch (name) {
    case "network":
    case "foundNetwork":
    case "hintNetwork":
      return MEMBER_NETWORK_NAMES.has(value);
    case "networks":
      return validNetworkList(value);
    case "noun":
      return (MEMBER_NOUNS as readonly string[]).includes(value);
    case "pausedState":
      return [
        "Deposits were paused.",
        "Withdrawals were paused.",
        "Swaps were paused.",
      ].includes(value);
    case "block":
    case "slot":
      return HEIGHT.test(value);
    case "token":
    case "outToken":
    case "inToken":
      return TOKEN_LABEL.test(value);
    case "amount":
    case "outAmount":
    case "inAmount":
      return AMOUNT.test(value);
    default:
      return false;
  }
}

export const MEMBER_TEMPLATES: Readonly<
  Record<MemberTemplateId, { text: string; fallback: string | null }>
> = {
  "m.confirmed": {
    text: "This {noun} on {network} went through in block {block}.",
    fallback: null,
  },
  "m.confirmed-final": {
    text: "This {noun} on {network} went through in block {block} and is final.",
    fallback: null,
  },
  "m.confirmed-sol": {
    text: "This {noun} on Solana went through in slot {slot}.",
    fallback: null,
  },
  "m.confirmed-sol-final": {
    text: "This {noun} on Solana went through in slot {slot} and is final.",
    fallback: null,
  },
  "m.deposit": {
    text: "This deposit on {network} went through in block {block}. It moved {amount} {token} from the wallet into the vault.",
    fallback: "This deposit on {network} went through in block {block}.",
  },
  "m.withdrawal": {
    text: "This withdrawal on {network} went through in block {block}. The vault paid out {amount} {token} to the wallet.",
    fallback: "This withdrawal on {network} went through in block {block}.",
  },
  "m.swap": {
    text: "This swap on {network} went through in block {block}. It traded {outAmount} {outToken} for {inAmount} {inToken}.",
    fallback:
      "This swap on {network} went through in block {block}. It traded one token for another.",
  },
  "m.swap-sol": {
    text: "This swap on Solana went through in slot {slot}. It traded {outAmount} {outToken} for {inAmount} {inToken}.",
    fallback:
      "This swap on Solana went through in slot {slot}. It traded one token for another.",
  },
  "m.approval-only": {
    text: "This transaction on {network} set a spending limit for {token} and didn't move any {token}.",
    fallback:
      "This transaction on {network} set a spending limit for a token and didn't move any tokens.",
  },
  "m.approval-unlimited": {
    text: "This transaction on {network} set a spending limit with no cap for {token} and didn't move any {token}.",
    fallback:
      "This transaction on {network} set a spending limit with no cap for a token and didn't move any tokens.",
  },
  "m.no-movement": {
    text: "This transaction on {network} went through in block {block}, but no tokens moved to or from the wallet in it.",
    fallback: null,
  },
  "m.no-movement-sol": {
    text: "This transaction on Solana went through in slot {slot}, but no tokens moved to or from the wallet in it.",
    fallback: null,
  },
  "m.failed-slippage": {
    text: "This swap on {network} didn't go through because the price moved more than its slippage limit allowed. The tokens stayed in the wallet, and only the network fee was spent.",
    fallback: null,
  },
  "m.failed-deadline": {
    text: "This swap on {network} didn't go through because it reached the chain after its time limit. The tokens stayed in the wallet, and only the network fee was spent.",
    fallback: null,
  },
  "m.failed-allowance": {
    text: "This {noun} on {network} didn't go through because its spending limit for {token} was lower than the amount. The tokens stayed in the wallet, and only the network fee was spent.",
    fallback:
      "This {noun} on {network} didn't go through because its spending limit was lower than the amount. The tokens stayed in the wallet, and only the network fee was spent.",
  },
  "m.failed-balance": {
    text: "This {noun} on {network} didn't go through because the wallet held less {token} than the amount at that moment. Only the network fee was spent.",
    fallback:
      "This {noun} on {network} didn't go through because the wallet held less than the amount at that moment. Only the network fee was spent.",
  },
  "m.failed-vault-limit": {
    text: "This {noun} on {network} didn't go through because the amount was above the vault's current limit. The tokens stayed in the wallet, and only the network fee was spent.",
    fallback: null,
  },
  "m.failed-paused": {
    text: "This {noun} on {network} didn't go through because the contract was paused at that moment. The tokens stayed in the wallet, and only the network fee was spent.",
    fallback: null,
  },
  "m.failed-paused-action": {
    text: "This {noun} on {network} didn't go through. {pausedState} The tokens stayed in the wallet, and only the network fee was spent.",
    fallback: null,
  },
  "m.failed-out-of-gas": {
    text: "This {noun} on {network} ran out of gas and didn't go through. The tokens stayed in the wallet, and only the network fee was spent.",
    fallback: null,
  },
  "m.failed-compute": {
    text: "This transaction on Solana hit its compute limit and didn't go through. The tokens stayed in the wallet, and only the network fee was spent.",
    fallback: null,
  },
  "m.failed-sol-balance": {
    text: "This transaction on Solana didn't go through because an account didn't have enough SOL for it. Only the network fee was spent.",
    fallback: null,
  },
  "m.failed-rent": {
    text: "This transaction on Solana didn't go through because it would have left an account below Solana's minimum balance. Only the network fee was spent.",
    fallback: null,
  },
  "m.failed": {
    text: "This {noun} on {network} didn't go through. The tokens stayed in the wallet, and only the network fee was spent.",
    fallback: null,
  },
  "m.userop-failed": {
    text: "This transaction on {network} went through, but the smart wallet's action inside it failed. The tokens stayed in the wallet.",
    fallback: null,
  },
  "m.pending": {
    text: "This transaction on {network} is waiting to go into a block. It hasn't gone through yet.",
    fallback: null,
  },
  "m.pending-behind": {
    text: "This transaction on {network} is waiting for an earlier transaction from the same wallet to go through first.",
    fallback: null,
  },
  "m.pending-low-fee": {
    text: "This transaction on {network} is waiting because its fee is below what {network} needs right now. It can still go through if fees drop.",
    fallback: null,
  },
  "m.processed": {
    text: "Solana has picked up this transaction, but it isn't confirmed yet.",
    fallback: null,
  },
  "m.replaced": {
    text: "This transaction on {network} won't go through. Another transaction from the same wallet took its place, and nothing moved in this one.",
    fallback: null,
  },
  "m.expired": {
    text: "This transaction expired before Solana ran it. Nothing moved and no fee was charged.",
    fallback: null,
  },
  "m.not-found": {
    text: "We couldn't find this transaction on {networks} yet. If it was sent in the last few minutes, it may still show up.",
    fallback: null,
  },
  "m.not-found-sol": {
    text: "We couldn't find this transaction on Solana yet. If it was sent in the last minute, it may still show up.",
    fallback: null,
  },
  "m.bridge-source": {
    text: "The first step of this transfer went through on {network} in block {block}. We can't see the other network from here, so someone on the team will check that it arrived.",
    fallback: null,
  },
  "m.bridge-source-sol": {
    text: "The first step of this transfer went through on Solana in slot {slot}. We can't see the other network from here, so someone on the team will check that it arrived.",
    fallback: null,
  },
  "m.unavailable": {
    text: "We couldn't read {network} just now, so someone on the team will check this transaction.",
    fallback:
      "We couldn't check this transaction just now, so someone on the team will look at it.",
  },
  "m.empty-address": {
    text: "This transaction on {network} went to an address that has no contract on {network}, so nothing ran there. Someone on the team will look at it.",
    fallback: null,
  },
  "m.sent-to-token": {
    text: "The {token} in this transaction went to the {token} contract's own address. Someone on the team will look at it.",
    fallback:
      "The tokens in this transaction went to the token contract's own address. Someone on the team will look at it.",
  },
  "m.sent-to-protocol": {
    text: "The {token} in this transaction went straight to a protocol contract instead of through its deposit step. Someone on the team will look at it.",
    fallback:
      "The tokens in this transaction went straight to a protocol contract instead of through its deposit step. Someone on the team will look at it.",
  },
  "m.other-network": {
    text: "We found this transaction on {foundNetwork}, not {hintNetwork}.",
    fallback: null,
  },
};

function renderVariant(template: string, slots: MemberSlots): string | null {
  let valid = true;
  const text = template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = slots[key as MemberSlotName];
    if (!validMemberSlot(key, value)) valid = false;
    return value ?? "";
  });
  return valid ? text : null;
}

/** The template with every slot validated, else its fallback, else null. */
export function renderMember(
  id: MemberTemplateId,
  slots: MemberSlots,
): string | null {
  const template = MEMBER_TEMPLATES[id];
  return (
    renderVariant(template.text, slots) ??
    (template.fallback ? renderVariant(template.fallback, slots) : null)
  );
}
