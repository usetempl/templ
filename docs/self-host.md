# Run a support conversation on your infrastructure

For a chat that Templ runs, including the website preview that needs no sign-in, start at [usetempl.com/create](https://usetempl.com/create) and follow the [hosted steps](../README.md#run-it-yourself-or-ask-templ-to-host-it). This page covers running the source yourself.

Start by exercising the complete guest and staff flow locally. Use Node 22.23.4 and pnpm 10.34.7 in the repository root.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm test:support
pnpm build
```

The conversation test starts the support worker under Workerd with temporary accounts and storage. It sends a guest message, saves a team reply, and reopens the guest session to read both. The build produces the web application. [Conversation test](../apps/workers/community/test/support-widget-session-workerd.test.ts)

[CI](../.github/workflows/check.yml) runs these same commands. This checkout includes no deployment configuration and no check against a deployed instance. Verify the steps below on your own infrastructure.

## Configure your installation

- **Web origins.** Set `NEXT_PUBLIC_TEMPL_SITE_ORIGIN` to your HTTPS web origin and `NEXT_PUBLIC_TEMPL_API_ORIGIN` to your HTTPS support-worker origin before building the web app. Leave `NEXT_PUBLIC_APP_ENV` unset. This snapshot has no production release configuration, and a production build stops with an error. A browser that sends requests to `127.0.0.1` after deployment is running a build made with the local defaults. [Web configuration](../apps/web/src/lib/site-environment.ts)
- **Worker origin.** The worker reads the web origin from `APP_ORIGIN` and accepts only the values in `APP_ORIGINS`, which lists Templ's own origins. With any other value, every request returns 503 `Community is not configured.` Running on your own domain requires at least adding your web origin to that list in your copy. The worker builds its own links as `https://community.<web host>`, so serve it there and use that address for `NEXT_PUBLIC_TEMPL_API_ORIGIN`. This checkout does not test that change. [Origin check](../apps/workers/community/src/common.ts)
- **Worker and storage.** Deploy the community worker with durable storage in your own account. Its environment lists the object bindings for rooms, identities, subscriptions and quotas. The local harness shows the binding-to-class mapping, the rate limiters and the media bucket. Supply your own secrets and persistent storage for the features you enable. [Worker environment](../apps/workers/community/src/common.ts) · [Local binding map](../apps/workers/community/test/workerd-harness.ts)
- **Chat and keys.** Choose Standard or customer-managed encryption for your workspace. Customer-managed encryption requires your own key services and a recovery process you have tested. If you enable AI, give the agent access to the intended workspace and knowledge sources. [Who can read a conversation](../README.md#who-can-read-messages) · [Agent setup](support-delivery.md#connect-ai)

## Create and test a workspace

Open `/create` on your web origin. The page starts with the website preview. Your worker answers it with `Website previews are unavailable. Try again later.` unless `SUPPORT_SELF_SERVE_SETUP_ENABLED`, `SUPPORT_TRIAL_AI_PRACTICE_ENABLED` and `MANAGED_AGENT_ENABLED` are all `"true"`. Reading the website needs the `SUPPORT_KNOWLEDGE` object binding. Practice answers also need an `AI` binding, `MANAGED_AGENT_GATEWAY_ID` and a positive `MANAGED_AGENT_SPEND_CAP_USD_CENTS`. Without them, select **Set up without a website** for the form that creates a workspace after sign-in. [Preview gate](../apps/workers/community/src/guest-onboarding.ts) · [Preview test and its settings](../apps/workers/community/test/guest-onboarding-workerd.test.ts)

Use a visitor link on your own web domain. Where your release enables hosted support pages, the link uses `/help/<workspace-id>`. Copy it with **Your support chat → Copy chat link**.

Open the link as a guest, send a question, answer from **Cases**, then reopen the original chat to read the reply. You can add an embedded widget for that same workspace later, under **Settings → Chat**. To keep it in one theme, pass `lockedTheme: "light"` or `lockedTheme: "dark"` to `mountSupportWidget`. Leave it unset to give visitors the theme switch. Use a private destination for test notifications. [Widget, standalone link, or both](../README.md#give-visitors-a-way-to-reach-you)
