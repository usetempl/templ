# Templ

A swap fails in your app. The visitor opens Help, asks where the funds are, and ticks the transaction hash to share it. Your team reads the question and the hash in its inbox and replies. The visitor reads the reply in the same chat.

Templ gives your team one inbox for conversations from an embedded widget, a standalone support page, or both. A visitor can start from a link even when your app is down.

![One Standard case on a workspace that accepts guests. The message and the details the visitor chose pass the worker's access check. The team and a permitted AI agent read them, and the visitor reads the reply.](docs/support-case.svg)

[How a message reaches the team, how retries work, and where AI joins](docs/support-delivery.md)

## Give visitors a way to reach you

| Choose | Set it up |
| --- | --- |
| **Standalone chat** | In your workspace, open **Widget → Guest support**. When available, turn on **Host a support page on Templ** and select **Save guest support**. Select **Open your support page** and copy the address. Use that address for a Support link in your footer, docs or status page. |
| **Embedded widget** | Open **Widget** and copy the install prompt for your workspace, or follow the manual guide. Connect the widget to a Help button on your HTTPS site. Your app can offer the visitor a choice of relevant details to share. |
| **Both** | Enable the support page and install the widget for the same workspace. Both reach the same team inbox. A visitor who follows the standalone link can describe the problem there. App context is available through the integration on the page where the problem happened. |

Try each entry point you plan to offer in a test workspace. Send a question, reply from the inbox, and reopen the original chat to read the reply. Use a private test destination for any staff alerts. [Hosted setup](https://docs.usetempl.com/install/) · [Manual widget guide](https://docs.usetempl.com/developers/widget/) · [Setup troubleshooting](https://docs.usetempl.com/install/troubleshooting/)

## What the visitor shares

- **Message.** A workspace can accept guests, ask for a wallet address, or require wallet sign-in. Guest support needs only a message.
- **Wallet proof.** The visitor signs a sign-in message to prove control of the wallet. The team sees that wallet as verified.
- **Reported address.** Your app can report the connected address without a signature. The visitor ticks a box to share it. A workspace that asks for an address shows it before Send. The team sees it as not verified.
- **Transaction and app details.** The visitor can share up to five transaction hashes, the network, and details your app supplies, such as the action and error. The widget sends only the rows the visitor ticks.

Reply notices are a separate opt-in. The visitor can add an email when the workspace offers them.

[Widget setup and wallet options](https://docs.usetempl.com/developers/widget)

## Who can read messages

| Chat mode | Who can read the message text |
| --- | --- |
| Standard | The visitor, team members with case access and the server operator. If case policy allows AI, the authorized agent and the model provider it uses can process the input sent to them. |
| Customer-managed encryption | Approved participant devices and the workspace's own validation and recovery services. The workspace controls its keys and backups. Under the default customer-managed custody, Templ-hosted AI and Templ operators cannot read the message text. |
| Templ-operated encryption | Approved participant devices and Templ's validation and recovery services. This mode runs only on Templ's own support workspace. |

The two encrypted modes differ in who holds the keys. In both, the sender's client encrypts each message before it sends it. The relay stores ciphertext and still sees case and delivery metadata. The agent setup for Standard cases gives no access to encrypted cases. With Templ-operated encryption, an approved AI recipient can read messages when the case policy permits it.

A Standard case has an AI mode. In **AI answers**, an agent with workspace access can reply. In **AI drafts only**, the agent drafts or hands off, and a person sends the reply. **AI off** blocks the agent from the case. A reply from a person moves a case in AI answers to AI drafts only. The agent's model provider receives the text the agent sends.

[Encryption code](packages/e2ee) · [Hosted security and data](https://docs.usetempl.com/security)

## Try a complete conversation

Use Node 22.23.4 and pnpm 10.34.7.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm test:support
```

The check runs the support worker locally in Workerd with temporary test accounts. It sends a guest message, saves one authorized team reply, and reopens the chat to read both messages.

## Run it yourself or ask Templ to host it

**Self-host.** The [MIT license](LICENSE) covers Templ's code. You supply the runtime, storage, secrets, and domains. For customer-managed encryption, you also operate the key services. This source includes the [web app](apps/web), [support worker](apps/workers/community), and encryption code.

Run `pnpm build` to build the web app. For your deployment, set `NEXT_PUBLIC_TEMPL_SITE_ORIGIN` to your web origin and `NEXT_PUBLIC_TEMPL_API_ORIGIN` to your support worker. Set these values at build time. Your deployment also needs the worker's storage bindings and its own secrets. The public build starts with hosted features off. [Configure web origins, worker storage and chat access](docs/self-host.md)

**Templ Hosted.** Templ runs your chat, inbox and message storage. Start with 10 free test tickets. Both monthly plans cover all seats. A case counts once when the visitor gets its first substantive answer.

| Per workspace | Starter | Plus |
| --- | ---: | ---: |
| Monthly price | $29 | $99 |
| Answered cases included | 100 | 500 |
| Each additional case | $0.20 | $0.19 |
| Templ AI credit included | $0 | $20 |

New workspaces can choose either plan. Open **Plan & usage → Start paid month** to see the networks and stablecoins available for your workspace. Templ activates the month after it verifies the payment. Bring your own AI provider or prepay for Templ AI. On Starter, set a monthly limit before using Templ AI. [Create a hosted workspace](https://usetempl.com/create?next=plan) · [Pricing](https://docs.usetempl.com/pricing/) · [Stablecoin payments](https://docs.usetempl.com/pricing/stablecoin-payments/)

[Connect your own knowledge sources and AI](docs/support-delivery.md#connect-ai)

[Source revision](SOURCE.json) · [Third-party notices](NOTICE)
