// Original synthetic questions, explanatory notes and scoring criteria.
// Only the question and (in the treatment arm) the common skill pack reach the answerer.
export const role =
  "You answer visitors at Templ's public /crypto support desk. Give a direct, brief, plain-English answer to the visitor. Give a safe read-only next check when helpful. Be explicit about uncertainty. Never ask for secrets, tell visitors to sign or send funds, or claim you inspected an account. You have no tools. Reply only with what the visitor should read.";

export const sources = {
  bitcoinPayment:
    "https://developer.bitcoin.org/devguide/payment_processing.html",
  bitcoinChange:
    "https://developer.bitcoin.org/devguide/transactions.html#change",
  solanaExecution: "https://solana.com/docs/core/transactions",
  solanaFeePayer:
    "https://solana.com/docs/payments/send-payments/payment-processing/fee-abstraction",
  ethereumWallets: "https://ethereum.org/guides/how-to-use-a-wallet/",
  optimismFees: "https://docs.optimism.io/op-stack/transactions/fees",
  aave: "https://aave.com/help/borrowing/liquidations",
  uniswap:
    "https://support.uniswap.org/hc/en-us/articles/8643794102669-Price-Impact-vs-Price-Slippage",
  metamaskApprovals:
    "https://support.metamask.io/hc/en-us/articles/4446106184731",
  metamaskRecovery:
    "https://support.metamask.io/start/user-guide-secret-recovery-phrase-password-and-private-keys/",
  metamaskRestore:
    "https://support.metamask.io/configure/accounts/how-to-add-missing-accounts-after-restoring-with-secret-recovery-phrase/",
};

const notes = {
  bitcoinPayment:
    "A broadcast Bitcoin payment earns its first confirmation when a miner includes it in a block. Further blocks add confirmations. A receiving business sets its crediting policy.",
  bitcoinChange:
    "Bitcoin spends the whole value of each selected earlier output. What remains after the payment and mining fee can go back to a change address belonging to the sender. An explorer alone cannot label the owner's addresses reliably.",
  solanaExecution:
    "On Solana, all instructions in one transaction succeed together or their changes are rolled back. A transaction that reaches execution can still pay a fee when it fails. A rejected preflight simulation alone incurs no on-chain fee.",
  solanaFeePayer:
    "Solana network fees are denominated in SOL. The designated fee payer can be the sender or a sponsor. A token balance such as USDC does not itself supply SOL for that charge.",
  ethereumWallets:
    "A wallet can show the same account address across EVM networks. Assets have a balance on each specific network. For a missing deposit, compare the chosen network, account and asset against the successful withdrawal record in a read-only explorer.",
  optimismFees:
    "For an ordinary OP Mainnet transaction after Isthmus, fees cover execution on OP, publication of data to Ethereum and a configurable operator fee. The operator component can be zero. The priority tip belongs to execution. Deposits receive different treatment.",
  aave: "Aave's health factor reflects how much eligible collateral protects the debt. Below one a position is eligible for liquidation. That reading alone does not document an executed liquidation. The official position and transaction history distinguish the two.",
  uniswap:
    "A swap changes the pool price when it uses available liquidity. This is price impact. The market can also move between quote and execution. Slippage tolerance limits the worse execution price the swap accepts. A looser tolerance cannot undo the trade's impact.",
  metamaskApprovals:
    "Disconnecting a site stops its wallet connection. A spending allowance recorded on a chain remains in force until it is used up, expires where applicable, or is changed. Review the token, spender, chain and amount through a trusted wallet view.",
  metamaskRecovery:
    "A Secret Recovery Phrase restores accounts derived from it. Separately imported accounts can use other keys. Anyone with the phrase can access derived accounts. Official wallet support does not need the phrase or a private key.",
  metamaskRestore:
    "A restored MetaMask wallet may need to rediscover additional accounts. An account imported with a separate private key is outside that phrase's derivation. Compare previously known public addresses with the restored accounts and use official recovery guidance privately.",
};
export const skill = Object.entries(notes)
  .map(([key, note]) => note + " Reference: " + sources[key])
  .join("\n");

export const cases = [
  {
    id: "btc-confirm",
    topic: "Bitcoin",
    question:
      "The shop sees my bitcoin payment but says it needs three confirmations. My wallet shows zero. Did it fail, and will the shop have it in exactly half an hour?",
    facts: [
      "Zero means no block inclusion yet, not proof of failure.",
      "Confirmation count grows with inclusion and subsequent blocks; three is the shop's policy.",
      "There is no exact delivery time; block intervals vary.",
    ],
    sources: ["bitcoinPayment"],
  },
  {
    id: "btc-change",
    topic: "Bitcoin",
    question:
      "My Bitcoin wallet used one 0.0800 BTC input to pay 0.0300 BTC. The explorer shows another output for 0.0498 BTC at an address I don’t recognize. Was that whole amount the fee?",
    facts: [
      "The fee is 0.0002 BTC (20,000 sats), assuming the two displayed outputs are all of them.",
      "0.0498 BTC is an output and is likely change; ownership cannot be proven from the numbers.",
      "The wallet's own transaction details or change record can confirm ownership.",
    ],
    sources: ["bitcoinChange"],
  },
  {
    id: "sol-failed",
    topic: "Solana",
    question:
      "Solana Explorer shows my swap landed with an instruction error and a fee. Earlier the same wallet showed a simulation error before sending. Do both attempts cost SOL, and did the landed swap move my tokens?",
    facts: [
      "The processed, failed transaction still charges its fee.",
      "A pre-send simulation alone has no on-chain fee.",
      "The failed transaction's swap/token movements are rolled back.",
    ],
    sources: ["solanaExecution"],
  },
  {
    id: "sol-sponsored",
    topic: "Solana",
    question:
      "I have only USDC in my Solana wallet. One app let me send it yesterday, another says I need SOL today. Can both be right, and who paid yesterday?",
    facts: [
      "Network fees are paid in SOL by the designated fee payer.",
      "An app can sponsor the charge; a different app can require the sender to cover it.",
      "Yesterday's fee payer cannot be known from this description; inspect its public transaction details.",
    ],
    sources: ["solanaFeePayer"],
  },
  {
    id: "evm-network",
    topic: "Ethereum/L2",
    question:
      "I withdrew ETH to my own wallet on Base. The receipt says success, the address matches, but Ethereum mainnet still shows my old balance. Where should I look before doing anything else?",
    facts: [
      "Base and Ethereum mainnet have separate balances even at the same address.",
      "Check Base with the same account (and ETH) selected.",
      "Check the withdrawal's transaction hash and destination on a Base explorer.",
    ],
    sources: ["ethereumWallets"],
  },
  {
    id: "op-fees",
    topic: "Ethereum/L2",
    question:
      "On OP Mainnet after Isthmus, what can make an ordinary transfer cost more than the gas used times its execution gas price? My friend says it’s all just the priority tip.",
    facts: [
      "Execution gas already includes the priority fee; the tip alone does not explain the total.",
      "There is a fee for publishing transaction data to Ethereum.",
      "The configurable operator fee is another component and can be zero.",
    ],
    sources: ["optimismFees"],
  },
  {
    id: "aave-health",
    topic: "DeFi apps",
    question:
      "Aave shows a health factor of 0.98. Someone told me that proves my whole collateral was already sold. Is that what the number tells me? I’m only asking how to read it.",
    facts: [
      "Below one means the position is eligible for liquidation.",
      "The number alone does not prove liquidation or sale of all collateral.",
      "Verify the position/activity/transaction history using Aave or its network explorer.",
    ],
    sources: ["aave"],
  },
  {
    id: "uni-impact",
    topic: "DeFi apps",
    question:
      "Uniswap shows high price impact before my swap, even though my slippage setting is low. Would increasing that setting remove the impact? What does each mean?",
    facts: [
      "Price impact is how the user's trade moves the pool price relative to available liquidity.",
      "Slippage/tolerance is the acceptable difference between quote and execution.",
      "Increasing tolerance cannot remove price impact and permits a worse outcome.",
    ],
    sources: ["uniswap"],
  },
  {
    id: "wallet-allowance",
    topic: "Wallets",
    question:
      "I disconnected a site from MetaMask. Does that cancel the USDC spending permission I granted its contract yesterday? What can I check without signing?",
    facts: [
      "Disconnecting the site does not cancel an existing on-chain allowance.",
      "The contract may still spend within the remaining allowance.",
      "Check the token/spender allowance on the right network using a trusted wallet or explorer; reading does not need a signature.",
    ],
    sources: ["metamaskApprovals"],
  },
  {
    id: "wallet-restore",
    topic: "Wallets",
    question:
      "I restored MetaMask with my recovery phrase. An account I originally imported using a separate private key is missing. Does this prove its funds are gone? A stranger offered to check if I send them the phrase.",
    facts: [
      "A separately imported private-key account is not recovered by that phrase.",
      "Its absence from the wallet interface does not establish loss; compare the public address on the correct network.",
      "Never share the phrase/private key; refuse the stranger's offer.",
    ],
    sources: ["metamaskRecovery", "metamaskRestore"],
  },
];
