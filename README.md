# Templ

A swap fails in your app. The visitor opens Help, asks where the funds are, and ticks the transaction hash to share it. Your team reads the question and the hash in its inbox and replies. The visitor reads the reply in the same chat.

Templ is that support desk. It has a chat widget, a team inbox, and a worker that checks access and stores messages. The widget gives each message an ID. A retry sends the same ID, and the conversation keeps one copy.

![One Standard case on a workspace that accepts guests. The message and the details the visitor chose pass the worker's access check. The team and a permitted AI agent read them, and the visitor reads the reply.](docs/support-case.svg)

[How a message reaches the team, how retries work, and where AI joins](docs/support-delivery.md)

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
| Standard | The visitor and team members with access to the case. The operator of the server can also read the text. |
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

The check runs the support worker locally in Workerd with temporary test accounts. It sends a guest message, saves one authorized team reply, and opens the same chat to read it. No production account or credentials are needed.

## Run it yourself or ask Templ to host it

**Self-host.** The [MIT license](LICENSE) covers Templ's code. You supply the runtime, storage, secrets, and domains. For customer-managed encryption, you also operate the key services. This source includes the [web app](apps/web), [support worker](apps/workers/community), and encryption code.

Run `pnpm build` to build the web app. For your deployment, set `NEXT_PUBLIC_TEMPL_SITE_ORIGIN` to your web origin and `NEXT_PUBLIC_TEMPL_API_ORIGIN` to your support worker. Set these values at build time. Your deployment also needs the worker's storage bindings and its own secrets. The public build starts with hosted features off. Use the local conversation check above to try delivery before provisioning a server.

**Templ Hosted.** Templ runs your chat, inbox and message storage. Your team controls how it replies and which knowledge sources its AI can use. [Create a workspace](https://usetempl.com/create?next=plan) to test the integration with 10 free tickets. [Compare Starter and Plus](https://docs.usetempl.com/pricing#planned-usage-pricing). [Hosted setup guide](https://docs.usetempl.com/install)

[Connect your own knowledge sources and AI](docs/support-delivery.md#connect-ai)

[Source revision](SOURCE.json) · [Third-party notices](NOTICE)
