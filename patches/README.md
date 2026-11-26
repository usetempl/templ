# Dependency patches

`pnpm-workspace.yaml` lists these patches under `patchedDependencies`, and
`pnpm-lock.yaml` pins each one by hash. `pnpm install --frozen-lockfile`
applies them. This checkout has no dedicated test for any of them.

## viem 2.55.0: hardened browser compatibility

The staging browser failed while creating a public client:

`TypeError: Cannot assign to read only property 'call' of function ...`

viem attaches token-call helpers to functions with ordinary assignment. This
fails when `Function.prototype.call` is non-writable: assignment cannot shadow
that inherited property, even when the new function itself is extensible.
The same issue affects importing five ERC-20 action namespaces after hardening.

This patch defines the helpers as own properties with `Object.defineProperty`.
They preserve the normal assignment flags: writable, enumerable and configurable.
The TypeScript namespaces reserve the own property before their generated
assignment; the ESM and CommonJS builds define the helper directly.

The patch does not modify or unfreeze global intrinsics. It does not change
transaction calldata, amounts, approvals, wallet confirmation, signatures or
access rules. Existing dependency versions remain pinned in the lockfile.

Keep the patch when upgrading viem until the replacement version creates
clients with a non-writable `Function.prototype.call` and no local changes.

## stream-json 1.9.1: `__proto__` keys

`Assembler.js` stored every parsed key by assignment, so a `__proto__` key in
the input could replace the prototype of the object being assembled. The patch
defines that key as an own writable, enumerable and configurable property.
Other keys keep ordinary assignment.

stream-json reaches this workspace through jayson, a dependency of
`@solana/web3.js`.

## bigint-buffer 1.1.5: pure JavaScript only

The patch removes the native addon load from `dist/node.js` and the `install`
script from `package.json`. The four conversions keep the package's own
pure-JavaScript code. The lockfile still lists the `bindings` package for
bigint-buffer, but the patched code never loads it.

bigint-buffer reaches this workspace through `@solana/buffer-layout-utils`, a
dependency of `@solana/spl-token`. `pnpm-workspace.yaml` ignores advisory
GHSA-3gc7-fjrx-p6mg for the native addon on this basis.
