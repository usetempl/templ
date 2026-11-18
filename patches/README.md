# Dependency patches

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

### Regression check

Run:

```sh
pnpm --filter web exec vitest run src/lib/evm/viem-runtime.test.ts
```

The test uses isolated Node processes, not mocked clients. It covers the direct
app dependency and WalletConnect's transitive dependency, ESM and CommonJS,
and hardening before import, after import, or not at all. Each case constructs
public and wallet clients, extends both, and checks a token-call helper. No
network request, wallet signature or transaction is made. Only the test child
changes its own `Function.prototype.call`; application code never does.

The unpatched dependency fails the hardened cases with the reported error.
Keep this regression when upgrading viem. Remove the patch when the
replacement version passes it without local changes.

## image-size 2.0.2: malformed-file loops

Docusaurus (docs and blog) reads image dimensions with the archived
`image-size` package. Two malformed-file cases (HEIF boxes and ICNS entries
that never advance) loop forever. The patch adds the minimum-size guards.
`apps/scripts/src/release/dependency-backports.test.mjs` checks the installed
bytes, not only the patch declaration.
