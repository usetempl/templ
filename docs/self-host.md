# Run a support conversation on your infrastructure

Start by exercising the complete guest and staff flow locally. Use Node 22.23.4 and pnpm 10.34.7 in the repository root.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm test:support
pnpm build
```

The conversation test starts the support worker under Workerd with temporary accounts and storage. It sends a guest message, saves a team reply, and reopens the guest session to read both. The build produces the web application. [Conversation test](../apps/workers/community/test/support-widget-session-workerd.test.ts)

## Configure your installation

- **Web origins.** Set `NEXT_PUBLIC_TEMPL_SITE_ORIGIN` to your HTTPS web origin and `NEXT_PUBLIC_TEMPL_API_ORIGIN` to your HTTPS support-worker origin before building the web app. Set the worker’s `APP_ORIGIN` to the web origin. A browser that sends requests to `127.0.0.1` after deployment is running a build made with the local defaults. [Web configuration](../apps/web/src/lib/site-environment.ts)
- **Worker and storage.** Deploy the community worker with durable storage in your own account. Its environment lists the object bindings for rooms, identities, subscriptions and quotas. The local harness shows the binding-to-class mapping and the media bucket. Supply your own domains, secrets and persistent storage for the features you enable. [Worker environment](../apps/workers/community/src/common.ts) · [Local binding map](../apps/workers/community/test/workerd-harness.ts)
- **Chat and keys.** Choose Standard or customer-managed encryption for your workspace. Customer-managed encryption requires your own key services and a recovery process you have tested. If you enable AI, give the agent access to the intended workspace and knowledge sources. [Who can read a conversation](../README.md#who-can-read-messages) · [Agent setup](support-delivery.md#connect-ai)

Use a test workspace on your own origins before opening support. Start a conversation through each entry point you enabled, answer from the team inbox, and reopen the original chat to verify the answer. Direct test notifications to a destination your team uses for testing. [Widget, standalone link, or both](../README.md#give-visitors-a-way-to-reach-you)
