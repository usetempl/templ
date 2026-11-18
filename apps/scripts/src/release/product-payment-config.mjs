import assert from "node:assert/strict";
import ts from "typescript";
import { getAddress } from "viem";

export const PRODUCT_RAIL_PAIRS = Object.freeze({
  "ethereum-usdc": { chainId: 1, symbol: "USDC" },
  "ethereum-usdt": { chainId: 1, symbol: "USDT" },
  "base-usdc": { chainId: 8453, symbol: "USDC" },
  "bnb-usdc": { chainId: 56, symbol: "USDC" },
  "bnb-usdt": { chainId: 56, symbol: "USDT" },
  "solana-usdc": { chainId: "solana", symbol: "USDC" },
  "solana-usdt": { chainId: "solana", symbol: "USDT" },
});
export const RAIL_IDS = Object.freeze(Object.keys(PRODUCT_RAIL_PAIRS));
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function canonicalSolanaAddress(value) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  let number = 0n;
  for (const char of value) number = number * 58n + BigInt(BASE58.indexOf(char));
  let bytes = 0;
  for (let rest = number; rest > 0n; rest >>= 8n) bytes++;
  const zeros = value.match(/^1*/)[0].length;
  return bytes + zeros === 32;
}

/** Read only literal issuer data from the shared TypeScript allowlist. */
export function readProductAssets(source) {
  const file = ts.createSourceFile("product-payment-assets.ts", source, ts.ScriptTarget.Latest, true);
  const declaration = file.statements.filter(ts.isVariableStatement)
    .flatMap((node) => [...node.declarationList.declarations])
    .find((node) => node.name.getText(file) === "PRODUCT_PAYMENT_ASSETS");
  assert.ok(declaration?.initializer, "Stablecoin allowlist");
  const value = (node) => {
    if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return value(node.expression);
    if (ts.isStringLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    assert.ok(ts.isObjectLiteralExpression(node), "Allowlist contains literal data");
    return Object.fromEntries(node.properties.map((property) => {
      assert.ok(ts.isPropertyAssignment(property), "Allowlist property");
      return [property.name.text, value(property.initializer)];
    }));
  };
  return value(declaration.initializer);
}

export function assertPaymentRecipient(recipient, asset, chain, tokenAddresses = [asset]) {
  assert.equal(typeof recipient, "string", "Payment recipient");
  if (chain === "solana") {
    assert.ok(canonicalSolanaAddress(recipient), "Canonical base58 recipient");
    assert.notEqual(recipient, "11111111111111111111111111111111", "Zero recipient");
    // Read 2026-09-30: Solana's designated burn address.
    // https://raw.githubusercontent.com/solana-labs/solana/master/sdk/program/src/incinerator.rs
    assert.notEqual(recipient, "1nc1nerator11111111111111111111111111111111", "Dead recipient");
    for (const token of tokenAddresses) assert.notEqual(recipient, token, "Recipient cannot be a token mint");
  } else {
    assert.match(recipient, /^0x[0-9a-fA-F]{40}$/, "EVM recipient");
    assert.equal(getAddress(recipient), recipient, "Checksummed recipient");
    assert.doesNotMatch(recipient, /^0x0{40}$/i, "Zero recipient");
    assert.doesNotMatch(recipient, /^0x0{36}dead$/i, "Dead recipient");
    for (const token of tokenAddresses) assert.notEqual(recipient.toLowerCase(), token.toLowerCase(), "Recipient cannot be a token contract");
  }
}

/** Sorted rail settings. Missing recipients or assets leave a rail closed. */
export function paymentRecipients(release, assets) {
  const offer = release.productOffer;
  assert.ok(offer && typeof offer === "object", "productOffer block");
  assert.equal(offer.payment, "direct-transfer", "Payment method");
  assert.equal(offer.contract, undefined, "Payment offer has no contract");
  assert.equal(offer.multisigPayerVerified, undefined, "Wallet proof governs every payer");
  assert.ok(offer.recipients && typeof offer.recipients === "object" && !Array.isArray(offer.recipients), "Payment recipients");
  for (const rail of Object.keys(offer.recipients)) assert.ok(RAIL_IDS.includes(rail), `Unknown payment rail ${rail}`);
  const result = {};
  for (const rail of [...RAIL_IDS].sort()) {
    const recipient = offer.recipients[rail];
    const pair = PRODUCT_RAIL_PAIRS[rail];
    const asset = assets[pair.chainId]?.[pair.symbol];
    if (recipient === null || recipient === undefined) continue;
    assert.ok(asset, `${rail} needs an allowlisted stablecoin`);
    assertPaymentRecipient(recipient, asset.address, pair.chainId, Object.values(assets[pair.chainId]).map((token) => token.address));
    if (rail === "base-usdc" && release.protocolRecipient !== undefined)
      assert.equal(recipient, release.protocolRecipient, "Base recipient matches protocolRecipient");
    result[rail] = { recipient, asset: asset.address, decimals: asset.decimals, chain: pair.chainId };
  }
  return result;
}
