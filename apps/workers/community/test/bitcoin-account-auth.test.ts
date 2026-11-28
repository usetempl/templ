import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { AccountMethods } from "@templ/chat/wallets";
import { NONCE_COOKIE, SESSION_COOKIE } from "../src/common";
import { shardRecord } from "./session-fixture";
import {
  addressFromPrivateKey,
  signMessage as signBitcoinMessage,
} from "@orangecheck/bip322";
import {
  validateBitcoinAccountChallenge,
  type BitcoinAccountChallenge,
} from "@templ/chat/bitcoin-account-auth";
import { bitcoinWalletProofMessage } from "@templ/chat/bitcoin-wallet-proof";
import { setup, solanaWallet } from "./account-auth-fixture";

import { releaseActivationFixture } from "./release-activation.fixture";

const origin = "https://usetempl.com";
const released = {
  version: 4,
  environment: "production",
  productionReleaseEnabled: true,
  bitcoinAccountSignInVerified: true,
};
function signedSetup() {
  const s = setup(true, origin);
  const activation = releaseActivationFixture(s.env, released);
  return { ...s, activation };
}
describe("first-party Bitcoin account authentication", () => {
  type Browser = ReturnType<typeof setup>;
  const key = (n: number, kind: "p2tr" | "p2wpkh" = "p2wpkh") => {
    const secret = n.toString(16).padStart(64, "0");
    const address = addressFromPrivateKey(secret, kind);
    return {
      address,
      sign: (message: string) =>
        signBitcoinMessage(address, message, secret, {
          prefixed: kind === "p2tr",
          auxRand: new Uint8Array(32),
        }),
    };
  };
  type Wallet = ReturnType<typeof key>;
  type Actor = { cookies: string; principalId: string };
  async function issue(
    s: Browser,
    wallet: Wallet,
    actor?: Actor,
    connectCode?: string,
  ) {
    const path = actor ? "/auth/bitcoin/attach" : "/auth/bitcoin";
    const resp = await s.call(path + "/nonce", {
      cookies: actor?.cookies,
      body: {
        address: wallet.address.toUpperCase(),
        connectCode,
        expectedPrincipalId: actor?.principalId,
      },
    });
    expect(resp.status).toBe(200);
    const nonceCookie = s.cookieOf(resp, NONCE_COOKIE)!;
    const envelope = await s.parse<{
      message: string;
      expiresAt: number;
      challenge: BitcoinAccountChallenge;
    }>(resp);
    const expected = {
      origin,
      address: wallet.address,
      purpose: actor
        ? ("attach" as const)
        : connectCode
          ? ("connect" as const)
          : ("login" as const),
      principalId: actor?.principalId,
      connectCode,
    };
    expect(validateBitcoinAccountChallenge(envelope, expected)).toBe(true);
    const body = {
      expectedPrincipalId: actor?.principalId,
      message: envelope.message,
      signature: wallet.sign(envelope.message),
    };
    const cookies = actor ? actor.cookies + "; " + nonceCookie : nonceCookie;
    return {
      path,
      cookies,
      nonceCookie,
      body,
      envelope,
      expected,
      verify: () => s.call(path + "/verify", { cookies, body }),
    };
  }
  async function login(s: Browser, wallet: Wallet) {
    const result = await (await issue(s, wallet)).verify();
    expect(result.status).toBe(200);
    const body = await s.parse<{ principalId: string }>(result);
    expect(body).toMatchObject({
      authMethod: "bitcoin",
      bitcoinAddress: wallet.address,
      address: null,
      servicePrincipals: expect.arrayContaining([body.principalId]),
      walletAuthorizationExpiresAt: null,
    });
    expect(body).not.toHaveProperty("bitcoinAuthorization");
    return {
      principalId: body.principalId,
      cookies: s.cookieOf(result, SESSION_COOKIE)!,
    };
  }

  it.each(["p2wpkh", "p2tr"] as const)(
    "restores the same %s account after logout, including a dark reader",
    async (kind) => {
      const s = signedSetup(),
        wallet = key(17, kind);
      const first = await login(s, wallet);
      const methods = await s.parse<{ methods: AccountMethods }>(
        await s.call(
          "/auth/account?expectedPrincipalId=" + first.principalId,
          first,
        ),
      );
      expect(methods.methods).toMatchObject({
        bitcoinWallets: [{ address: wallet.address, current: true }],
        canRemove: { bitcoinWallets: false },
      });
      expect(
        (
          await s.call("/auth/bitcoin/remove", {
            cookies: first.cookies,
            body: {
              address: wallet.address,
              expectedPrincipalId: first.principalId,
            },
          })
        ).status,
      ).toBe(409);
      const started = await issue(s, wallet);
      s.env.BITCOIN_ACCOUNT_SIGN_IN_ENABLED = "false";
      expect(
        await s.parse(await s.call("/auth/capabilities")),
      ).not.toHaveProperty("bitcoin");
      expect(
        (
          await s.call("/auth/bitcoin/nonce", {
            body: { address: wallet.address },
          })
        ).status,
      ).toBe(404);
      expect((await started.verify()).status).toBe(404);
      expect((await s.call("/auth/session", first)).status).toBe(200);
      expect(
        (
          await s.call("/auth/logout", {
            cookies: first.cookies,
            body: { expectedPrincipalId: first.principalId },
          })
        ).status,
      ).toBe(200);
      expect((await s.call("/auth/session", first)).status).toBe(401);
      s.env.BITCOIN_ACCOUNT_SIGN_IN_ENABLED = "true";
      expect((await login(s, wallet)).principalId).toBe(first.principalId);
    },
  );

  it("checks consent, expiry, signature, nonce reuse, and account versus chat purpose", async () => {
    const s = signedSetup(),
      wallet = key(31),
      other = key(37);
    const challenge = await issue(s, wallet);
    for (const difference of [
      { origin: "https://other.invalid" },
      { address: other.address },
      { purpose: "attach" as const },
      { purpose: "connect" as const, connectCode: "ABCD-EFGH" },
    ]) {
      expect(
        validateBitcoinAccountChallenge(challenge.envelope, {
          ...challenge.expected,
          ...difference,
        }),
      ).toBe(false);
    }
    expect(
      validateBitcoinAccountChallenge(
        challenge.envelope,
        challenge.expected,
        challenge.envelope.expiresAt,
      ),
    ).toBe(false);
    const chat = bitcoinWalletProofMessage({
      origin,
      address: wallet.address,
      workspace: "01900000-0000-7000-8000-000000000041",
      conversation: "next",
      nonce: challenge.envelope.challenge.nonce,
      expiresAt: challenge.envelope.expiresAt,
    });
    expect(
      (
        await s.call("/auth/bitcoin/verify", {
          cookies: challenge.cookies,
          body: { message: chat, signature: wallet.sign(chat) },
        })
      ).status,
    ).toBe(401);
    expect((await challenge.verify()).status).toBe(401);
    const fresh = await issue(s, wallet);
    expect(
      (
        await s.call("/auth/bitcoin/verify", {
          cookies: fresh.cookies,
          body: { ...fresh.body, signature: other.sign(fresh.body.message) },
        })
      ).status,
    ).toBe(401);
    const two = await issue(s, wallet);
    expect(
      (await Promise.all([two.verify(), two.verify()]))
        .map((r) => r.status)
        .sort(),
    ).toEqual([200, 401]);
  });

  it("claims only the install code in the signed Connect consent", async () => {
    const s = signedSetup(),
      wallet = key(45);
    s.env.SUPPORT_CONNECT_ENABLED = "true";
    const start = async () => {
      const response = await s.call("/connect/start", {
        body: { origins: ["https://app.example"], appName: "Example" },
      });
      expect(response.status).toBe(201);
      return (await s.parse<{ code: string }>(response)).code;
    };
    const a = await start(),
      b = await start();
    const plain = await login(s, wallet);
    const deny = (code: string, actor: Actor, confirmed = true) =>
      s.call("/connect/" + code + "/deny", {
        cookies: actor.cookies,
        body: { expectedPrincipalId: actor.principalId, confirmed },
      });
    expect((await deny(a, plain)).status).toBe(403);
    const consent = await issue(s, wallet, undefined, a);
    expect(consent.body.message).toContain(origin + "/connect/" + a);
    expect(
      validateBitcoinAccountChallenge(consent.envelope, {
        ...consent.expected,
        connectCode: b,
      }),
    ).toBe(false);
    const loginResult = await consent.verify();
    expect(loginResult.status).toBe(200);
    const bound = {
      cookies: s.cookieOf(loginResult, SESSION_COOKIE)!,
      principalId: plain.principalId,
    };
    expect((await s.call("/auth/session", bound)).status).toBe(200);
    expect((await deny(b, bound)).status).toBe(403);
    expect((await deny(a, bound, false)).status).toBe(400);
    expect((await deny(a, bound)).status).toBe(200);
  });

  it("rechecks the stored Bitcoin consent before granting authority", async () => {
    const s = signedSetup(),
      wallet = key(53);
    const actor = await login(s, wallet);
    const record = await shardRecord(s.records.objects, actor.cookies);
    const stored = await record.get();
    await record.put({
      ...stored,
      bitcoinAuthorization: {
        ...stored.bitcoinAuthorization,
        challenge: {
          ...stored.bitcoinAuthorization.challenge,
          purpose: "attach",
          principalId: actor.principalId,
          sessionHash: record.hash,
        },
      },
    });
    expect((await s.call("/auth/session", actor)).status).toBe(401);
  });

  it("retains a legacy EVM account's history and keeps payment authority tied to the EVM proof", async () => {
    const s = signedSetup(),
      wallet = key(57);
    const evm = privateKeyToAccount(`0x${"34".repeat(32)}`);
    const legacy = evm.address.toLowerCase();
    const nonce = await s.call("/auth/nonce", {
      body: { address: evm.address },
    });
    const { message } = await s.parse<{ message: string }>(nonce);
    const signed = await s.call("/auth/verify", {
      cookies: s.cookieOf(nonce, NONCE_COOKIE),
      body: { message, signature: await evm.signMessage({ message }) },
    });
    expect(signed.status).toBe(200);
    const legacyActor = {
      cookies: s.cookieOf(signed, SESSION_COOKIE)!,
      principalId: legacy,
    };
    expect((await (await issue(s, wallet, legacyActor)).verify()).status).toBe(
      200,
    );
    const bitcoin = await login(s, wallet);
    const actual = await s.parse(await s.call("/auth/session", bitcoin));
    expect(actual).toMatchObject({
      principalId: bitcoin.principalId,
      servicePrincipals: [bitcoin.principalId, legacy],
      address: null,
      bitcoinAddress: wallet.address,
    });
    expect(
      await s.parse(await s.call("/auth/session", legacyActor)),
    ).toMatchObject({
      principalId: bitcoin.principalId,
      address: legacy,
      authMethod: "wallet",
      servicePrincipals: [bitcoin.principalId, legacy],
    });
  });

  it("attaches EVM authority only for the Bitcoin session that separately proved the EVM wallet", async () => {
    const s = signedSetup(),
      wallet = key(59);
    const first = await login(s, wallet),
      other = await login(s, wallet);
    const evm = privateKeyToAccount(`0x${"56".repeat(32)}`);
    const change = {
      address: evm.address,
      expectedPrincipalId: first.principalId,
    };
    const nonce = await s.call("/auth/wallets/nonce", {
      cookies: first.cookies,
      body: change,
    });
    const { message } = await s.parse<{ message: string }>(nonce);
    expect(nonce.status).toBe(200);
    const verified = await s.call("/auth/wallets/verify", {
      cookies: first.cookies + "; " + s.cookieOf(nonce, NONCE_COOKIE),
      body: {
        expectedPrincipalId: first.principalId,
        message,
        signature: await evm.signMessage({ message }),
      },
    });
    expect(verified.status).toBe(200);
    expect(await s.parse(await s.call("/auth/session", first))).toMatchObject({
      authMethod: "bitcoin",
      bitcoinAddress: wallet.address,
      address: evm.address.toLowerCase(),
    });
    expect(await s.parse(await s.call("/auth/session", other))).toMatchObject({
      authMethod: "bitcoin",
      bitcoinAddress: wallet.address,
      address: null,
    });
    expect(
      (
        await s.call("/auth/wallets/remove", {
          cookies: first.cookies,
          body: change,
        })
      ).status,
    ).toBe(200);
    expect(await s.parse(await s.call("/auth/session", first))).toMatchObject({
      authMethod: "bitcoin",
      bitcoinAddress: wallet.address,
      address: null,
    });
  });
  it("closes ordinary issuance when the signed flag is absent or the Worker version differs", async () => {
    const s = signedSetup(),
      wallet = key(63);
    const actor = await login(s, wallet);
    const { bitcoinAccountSignInVerified: _flag, ...oldRelease } = released;
    s.activation.setProjection(oldRelease);
    const issue = () =>
      s.call("/auth/bitcoin/nonce", { body: { address: wallet.address } });
    expect((await issue()).status).toBe(404);
    expect(
      await s.parse(await s.call("/auth/capabilities")),
    ).not.toHaveProperty("bitcoin");
    expect((await s.call("/auth/session", actor)).status).toBe(200);
    s.activation.setProjection(released);
    s.env.CF_VERSION_METADATA = { id: "99999999-9999-4999-8999-999999999999" };
    expect((await issue()).status).toBe(404);
  });

  it("preserves one usable Solana wallet across two concurrent removals on the signed dark release", async () => {
    const s = signedSetup(),
      wallet = key(65);
    const first = await s.solanaLogin(await solanaWallet()),
      next = await solanaWallet();
    const principalId = first.body.principalId;
    const actor = { cookies: first.cookies, principalId };
    expect((await (await issue(s, wallet, actor)).verify()).status).toBe(200);
    const bitcoin = await login(s, wallet);
    const nonce = await s.call("/auth/solana/attach/nonce", {
      cookies: first.cookies,
      body: { expectedPrincipalId: principalId, address: next.address },
    });
    const { message } = await s.parse<{ message: string }>(nonce);
    expect(
      (
        await s.call("/auth/solana/attach/verify", {
          cookies: first.cookies + "; " + s.cookieOf(nonce, NONCE_COOKIE),
          body: {
            expectedPrincipalId: principalId,
            message,
            signature: await next.sign(message),
          },
        })
      ).status,
    ).toBe(200);
    s.activation.setProjection({
      ...released,
      bitcoinAccountSignInVerified: false,
    });
    const remove = (address: string) =>
      s.call("/auth/solana/remove", {
        cookies: bitcoin.cookies,
        body: { expectedPrincipalId: principalId, address },
      });
    expect(
      (
        await Promise.all([
          remove(first.body.solanaAddress),
          remove(next.address),
        ])
      )
        .map((r) => r.status)
        .sort(),
    ).toEqual([200, 409]);
    const result = await s.parse<{ methods: AccountMethods }>(
      await s.call("/auth/account?expectedPrincipalId=" + principalId, bitcoin),
    );
    expect(result.methods.canRemove).toEqual({
      wallets: false,
      solanaWallets: false,
      bitcoinWallets: true,
    });
  });

  it("keeps a single usable EVM method when the account's Bitcoin sign-in is dark", async () => {
    const s = signedSetup(),
      wallet = key(67);
    const evm = privateKeyToAccount(`0x${"43".repeat(32)}`);
    const nonce = await s.call("/auth/nonce", {
      body: { address: evm.address },
    });
    const { message } = await s.parse<{ message: string }>(nonce);
    const logged = await s.call("/auth/verify", {
      cookies: s.cookieOf(nonce, NONCE_COOKIE),
      body: { message, signature: await evm.signMessage({ message }) },
    });
    const actor = {
      principalId: evm.address.toLowerCase(),
      cookies: s.cookieOf(logged, SESSION_COOKIE)!,
    };
    expect((await (await issue(s, wallet, actor)).verify()).status).toBe(200);
    const bitcoin = await login(s, wallet);
    s.activation.setProjection({
      ...released,
      bitcoinAccountSignInVerified: false,
    });
    const methods = await s.parse<{ methods: AccountMethods }>(
      await s.call(
        "/auth/account?expectedPrincipalId=" + bitcoin.principalId,
        bitcoin,
      ),
    );
    expect(methods.methods.canRemove.wallets).toBe(false);
    expect(
      (
        await s.call("/auth/wallets/remove", {
          cookies: bitcoin.cookies,
          body: {
            expectedPrincipalId: bitcoin.principalId,
            address: evm.address,
          },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await s.call("/auth/bitcoin/remove", {
          cookies: actor.cookies,
          body: {
            expectedPrincipalId: bitcoin.principalId,
            address: wallet.address,
          },
        })
      ).status,
    ).toBe(200);
    expect((await s.call("/auth/session", bitcoin)).status).toBe(401);
  });

  it("limits preview to a confirmed trial operator's existing account and its own test workspace", async () => {
    const s = signedSetup(),
      wallet = key(69);
    s.activation.setProjection({
      ...released,
      bitcoinAccountSignInVerified: false,
    });
    const evm = privateKeyToAccount(`0x${"45".repeat(32)}`);
    const legacy = evm.address.toLowerCase();
    Object.assign(s.env, {
      CONTACT_ADMIN_PRINCIPALS: legacy,
      TRIAL_OPERATOR_PRINCIPALS: legacy,
    });
    const original = s.env.ROOMS;
    const workspace = "01900000-0000-7000-8000-000000000042";
    s.env.ROOMS = {
      idFromName: (v: string) => original.idFromName(v),
      get: (id: DurableObjectId) =>
        String(id) === "native-room:" + workspace
          ? {
              fetch: async (request: Request) =>
                new URL(request.url).pathname === "/private/native/read"
                  ? Response.json({
                      room: { id: workspace, manager: legacy },
                      trialOperator: legacy,
                    })
                  : new Response(null, { status: 404 }),
            }
          : original.get(id),
    } as DurableObjectNamespace;
    const e = await s.call("/auth/nonce", { body: { address: legacy } });
    const text = (await s.parse<{ message: string }>(e)).message;
    const auth = await s.call("/auth/verify", {
      cookies: s.cookieOf(e, NONCE_COOKIE),
      body: {
        message: text,
        signature: await evm.signMessage({ message: text }),
      },
    });
    const cookies = s.cookieOf(auth, SESSION_COOKIE)!;
    let principalId = legacy;
    const preview = async (family: string, confirm = true) => {
      const body = {
        expectedPrincipalId: principalId,
        workspaceId: workspace,
        workerVersion: s.activation.worker.versionId,
        confirmed: confirm,
        address: wallet.address,
      };
      const path = "/auth/bitcoin/preview/" + family;
      const nonce = await s.call(path + "nonce", { cookies, body });
      if (nonce.status !== 200) return nonce;
      const { message } = await s.parse<{ message: string }>(nonce);
      return s.call(path + "verify", {
        cookies: cookies + "; " + s.cookieOf(nonce, NONCE_COOKIE),
        body: { ...body, message, signature: wallet.sign(message) },
      });
    };
    const cap = (v: string, session?: string) =>
      s.call(
        "/auth/bitcoin/preview/capability?workspaceId=" +
          workspace +
          "&expectedPrincipalId=" +
          principalId +
          "&workerVersion=" +
          v,
        { cookies: session },
      );
    expect((await cap(s.activation.worker.versionId)).status).toBe(401);
    expect(
      (await cap("99999999-9999-4999-8999-999999999999", cookies)).status,
    ).toBe(404);
    expect((await cap(s.activation.worker.versionId, cookies)).status).toBe(
      403,
    );
    const sol = await solanaWallet();
    const ownerNonce = await s.call("/auth/solana/attach/nonce", {
      cookies,
      body: { address: sol.address, expectedPrincipalId: legacy },
    });
    const m = (await s.parse<{ message: string }>(ownerNonce)).message;
    expect(
      (
        await s.call("/auth/solana/attach/verify", {
          cookies: cookies + "; " + s.cookieOf(ownerNonce, NONCE_COOKIE),
          body: {
            message: m,
            signature: await sol.sign(m),
            expectedPrincipalId: legacy,
          },
        })
      ).status,
    ).toBe(200);
    principalId = (
      await s.parse<{ principalId: string }>(
        await s.call("/auth/session", { cookies }),
      )
    ).principalId;
    expect(principalId).toMatch(/^account:/);
    expect(
      await s.parse(await cap(s.activation.worker.versionId, cookies)),
    ).toEqual({ eligible: true, workerVersion: s.activation.worker.versionId });
    expect((await preview("", false)).status).toBe(400);
    expect((await preview("")).status).toBe(403);
    expect((await preview("attach/")).status).toBe(200);
    principalId = (
      await s.parse<{ principalId: string }>(
        await s.call("/auth/session", { cookies }),
      )
    ).principalId;
    const verified = await preview("");
    expect(verified.status).toBe(200);
    expect(await s.parse(verified)).toMatchObject({
      authMethod: "bitcoin",
      principalId,
      bitcoinAddress: wallet.address,
    });
    expect(
      (
        await s.call("/auth/bitcoin/nonce", {
          body: { address: wallet.address },
        })
      ).status,
    ).toBe(404);
  });

  it("binds attachment to the issuing session; unlink and relink never restore its old Bitcoin sessions", async () => {
    const s = signedSetup(),
      wallet = key(41, "p2tr");
    const sol = await solanaWallet();
    const primary = await s.solanaLogin(sol),
      another = await s.solanaLogin(sol);
    const actor = {
      cookies: primary.cookies,
      principalId: primary.body.principalId,
    };
    const challenge = await issue(s, wallet, actor);
    expect(
      (
        await s.call("/auth/bitcoin/attach/verify", {
          cookies: another.cookies + "; " + challenge.nonceCookie,
          body: challenge.body,
        })
      ).status,
    ).toBe(401);
    const attach = () => issue(s, wallet, actor).then((ch) => ch.verify());
    expect((await attach()).status).toBe(200);
    const viaBitcoin = await login(s, wallet);
    expect(viaBitcoin.principalId).toBe(actor.principalId);
    const outsider = await s.solanaLogin(await solanaWallet());
    expect(
      (
        await (
          await issue(s, wallet, {
            cookies: outsider.cookies,
            principalId: outsider.body.principalId,
          })
        ).verify()
      ).status,
    ).toBe(409);
    s.env.BITCOIN_ACCOUNT_SIGN_IN_ENABLED = "false";
    expect(
      (
        await s.call("/auth/bitcoin/remove", {
          cookies: actor.cookies,
          body: {
            expectedPrincipalId: actor.principalId,
            address: wallet.address,
          },
        })
      ).status,
    ).toBe(200);
    s.env.BITCOIN_ACCOUNT_SIGN_IN_ENABLED = "true";
    expect((await attach()).status).toBe(200);
    expect((await s.call("/auth/session", viaBitcoin)).status).toBe(401);
    expect((await s.call("/auth/session", actor)).status).toBe(200);
    expect((await login(s, wallet)).principalId).toBe(actor.principalId);
  });
});
