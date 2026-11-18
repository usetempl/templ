# Templ source snapshot

Templ is a support inbox and chat widget for apps. This snapshot contains the
web app, support Workers, the chat package and the encryption libraries.
See [SOURCE.json](SOURCE.json) for the source revision.

## Build and try a conversation

Use Node 22.23.4 and pnpm 10.34.7.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
pnpm test:support
pnpm --filter web start --port 6969
```

The support check starts a local Workerd instance with disposable credentials.
An anonymous visitor sends a message, a signed-in team member reads and answers
it, and the visitor resumes the conversation and reads the answer. The check
uses no hosted workspace, payment, wallet service or model provider.

The web build starts with hosted feature flags closed. It defaults to
`http://127.0.0.1:6969` and expects a separate API when used interactively.
Use `NEXT_PUBLIC_TEMPL_SITE_ORIGIN` and `NEXT_PUBLIC_TEMPL_API_ORIGIN` to point
the client at your own instance. This export includes a local test harness.
Operating a hosted service requires your own storage, secrets, domains and
activation setup. A hosted release manifest is intentionally absent.

The customer encryption libraries retain their separate identity and recovery
interfaces. An encrypted customer workspace approves its own devices and keeps
its own key backups. This export supplies no hosted encryption profile or
recovery key.

## Scope and license

Templ-owned code uses [MIT](LICENSE). See [NOTICE](NOTICE) for third-party
notices and trademark exclusions. The default mark is a neutral placeholder.
Dependencies install from their published packages and retain their licenses.

The snapshot omits hosted configuration and credentials, customer-specific
records and integrations, original artwork, production workflows and private
Git history.
