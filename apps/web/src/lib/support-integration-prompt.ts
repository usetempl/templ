import {
  SUPPORT_APP_ACTIONS,
  SUPPORT_APP_LIMITS,
  SUPPORT_FAILURE_KINDS,
} from "@templ/chat/support-app-context";
import { SITE } from "./site-environment";
import { PRODUCT_LIMITS } from "@templ/chat/plans";

/** The short entry prompt delegates current setup details to the hosted guide. */
export function startInstallPrompt(hosts: InstallHosts = SITE): string {
  return `Read ${hosts.origin}/llms.txt and follow the install guide.
Ask whether I want an embedded widget, a standalone support link, or both.
Help me create a workspace at ${hosts.origin}/create or use one I manage.
Start with the visitor link in Your support chat. Open it in a separate browser, send a test question, then answer from Cases. A self-hosted team uses its own domain.
For an existing workspace without a support link, open Settings → Chat → Guest support, select Host a support page on Templ and Save guest support. Use Copy support link for the saved URL. Link-only setup needs no widget code.
For the widget, ask me to copy its public workspace ID from Settings → Chat. It is not a credential.
Use Connect's wallet confirmation only when current availability says Connect is open.
Use free integration mode: ${PRODUCT_LIMITS.freeSupportTickets} lifetime test tickets, with ${PRODUCT_LIMITS.freeTeamRepliesPerTicket} team replies per ticket. Templ AI stays off.
Preserve existing paid access, grants, team roles and AI settings.
For an embed, reuse the app’s wallet connection and use the workspace install prompt to add Help, wallet updates and failure capture. For both, keep the link and the widget on this workspace.
Check current availability. Keep unavailable features off.
Never request passwords, private keys, recovery phrases or staff tokens.
Test a guest question and a team reply. Tell me what needs attention.
Stop before payment. When I want a hosted name, open Choose a hosted name under Your support chat, then show me how to reserve it and choose a monthly plan. Payment is in USDC and renewals are manual.`;
}

/** The hosts a prompt names. Every build uses its own `SITE`; tests and the
 * docs check pass the production hosts. */
export type InstallHosts = Pick<typeof SITE, "origin" | "community">;

/** The release facts the prompt reads. `supportWidgetSolanaVerified` adds
 * the Solana wallet lines. `supportWidgetLoopback` mirrors the worker's
 * SUPPORT_WIDGET_LOOPBACK, so the prompt offers localhost only while the
 * worker accepts it. */
export type InstallPromptRelease = {
  supportWidgetSolanaVerified?: boolean;
  supportWidgetLoopback?: boolean;
  supportConnectVerified?: boolean;
};

export type InstallPromptWorkspaceFeatures = { solanaSignIn?: boolean };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The setup steps the install prompt and coding-tool guide share. */
export function installConnectSteps(hosts: InstallHosts = SITE): string {
  return `If no workspace ID is configured, start Connect:
   - Check ${hosts.origin}/api/status. If support.connectVerified is false, use the manual setup below.
   - Detect the app's exact HTTPS origins from its config. Origins have no path, query, fragment or trailing slash.
   - POST ${hosts.community}/connect/start with JSON { origins: [...] }. Add appName only when the app has a name. Use only origins you checked. Send no auth token.
   - Read code, connectUrl, pollToken, expiresAt and interval from the response.
   - Show me only connectUrl and code. Ask me to open that one link and sign in with my wallet.
   - I confirm the app and origins there. I can create a workspace or choose one I manage.
   - Keep pollToken only in memory. Never print it, log it, save it to a file or commit it.
   - POST ${hosts.community}/connect/poll with JSON { pollToken }. Wait at least interval seconds between polls. Honor Retry-After and each larger interval.
   - For pending, keep polling until expiresAt. For denied or expired, stop and report it.
   - For approved, check workspaceId is a UUID. Save only workspaceId in the app's public config, then continue.
   - If Connect fails, report the error and offer the manual setup below. Never invent an ID.
   Manual setup:
   - Ask me to create a workspace at ${hosts.origin}/create, then paste its ID from Settings → Chat.
   - Check the ID is a UUID. Save only that ID in the app's public config, then continue.
   - Keep support off until a valid ID is configured and support.widgetVerified is true.`;
}

/** The module the prompt asks the coding tool to add, as `templ-support.ts`.
 * `apps/web/test/widget-snippets/install-module.ts` holds the same text with
 * the staging hosts; tsc checks it against the served types, and a test
 * keeps the two equal byte for byte. */
export function installModule(hosts: InstallHosts = SITE): string {
  return `// templ-support.ts: one Templ support widget for the whole app.
import type {
  SupportContextInput,
  SupportFailureCapture,
  SupportWallet,
  SupportWidget,
} from "${hosts.origin}/support-widget.js";

/** true only if the app has no Help button of its own. */
const SHOW_LAUNCHER = false;

/** The page's style nonce, needed only when the content security policy
 * limits style-src. Return it from where the app keeps it. */
function styleNonce(): string | undefined {
  return undefined;
}

let wallet: SupportWallet | null = null;
let widget: SupportWidget | undefined;
let loading: Promise<SupportWidget> | undefined;
let retries = 0;
type SavedFailure = {
  input: SupportContextInput;
  capture: Promise<SupportFailureCapture>;
};
const failures = new Set<SavedFailure>();
let capturing: Promise<void> | undefined;

/** Read the selected wallet now. These reads never connect or sign. */
async function snapshotWallet(): Promise<SupportFailureCapture["wallet"]> {
  const selected = wallet;
  try {
    if (selected?.evm) {
      const [accounts, chain] = await Promise.all([
        selected.evm.request({ method: "eth_accounts" }),
        selected.evm.request({ method: "eth_chainId" }),
      ]);
      const address = Array.isArray(accounts) ? accounts[0] : undefined;
      const chainId = typeof chain === "string" ? Number(chain) : NaN;
      if (
        typeof address === "string" && /^0x[0-9a-f]{40}$/i.test(address) &&
        !/^0x0{40}$/i.test(address) && Number.isSafeInteger(chainId) && chainId > 0
      ) return { network: "evm", address: address.toLowerCase() as \`0x\${string}\`, chainId };
    } else if (selected?.solana) {
      const address = "accounts" in selected.solana
        ? selected.solana.accounts.find((account) =>
            !account.chains || account.chains.some((chain) => chain.startsWith("solana:")),
          )?.address
        : selected.solana.publicKey?.toBase58();
      if (address) return { network: "solana", address };
    }
  } catch {
    // An unreadable wallet stays a guest snapshot.
  }
  return null;
}

/** Keep each failure until the widget accepts it. Get help retries this queue. */
async function captureSavedFailures(mounted: SupportWidget): Promise<void> {
  if (capturing) return capturing;
  const attempt = (async () => {
    let failed = false;
    let reason: unknown;
    for (const saved of failures) {
      const capture = await saved.capture;
      if (widget !== mounted || !failures.has(saved)) throw new Error("Support was closed.");
      try {
        await mounted.captureFailure(saved.input, capture);
        failures.delete(saved);
      } catch (error) {
        failed = true;
        reason = error;
      }
    }
    if (failed) throw reason;
  })();
  capturing = attempt;
  try {
    await attempt;
  } finally {
    if (capturing === attempt) capturing = undefined;
  }
}

/** Loads and mounts the widget once. \`workspace\` is the Templ workspace ID. */
export function loadSupport(workspace: string): Promise<SupportWidget> {
  if (loading) return loading;
  const url = "${hosts.origin}/support-widget.js";
  const source = retries ? url + "?retry=" + retries : url;
  const attempt: Promise<SupportWidget> = import(
    /* webpackIgnore: true */ /* @vite-ignore */ source
  ).then(({ mountSupportWidget }) => {
    if (loading !== attempt) throw new Error("Support was closed.");
    const mounted: SupportWidget = mountSupportWidget({
      workspace,
      apiUrl: "${hosts.community}",
      wallet,
      showLauncher: SHOW_LAUNCHER,
      styleNonce: styleNonce(),
    });
    widget = mounted;
    return mounted;
  });
  attempt.catch(() => {
    if (loading === attempt) {
      loading = undefined;
      retries++;
    }
  });
  loading = attempt;
  return attempt;
}

/** The app's Help button. Pass context only for something the user is
 * looking at, such as a pending deposit; they choose whether to share it. */
export async function openSupport(
  workspace: string,
  context?: SupportContextInput,
) {
  const mounted = await loadSupport(workspace);
  await captureSavedFailures(mounted).catch(() => {});
  if (widget !== mounted) throw new Error("Support was closed.");
  if (context) mounted.setContext(context);
  mounted.open();
}

/** Call from the app's handler when a wallet action fails.
 * It saves the failure with the wallet and network at that moment.
 * Its details start selected. Nothing is sent until the user presses Send. */
export async function captureSupportFailure(
  workspace: string,
  failure: SupportContextInput,
) {
  if (!${JSON.stringify(SUPPORT_FAILURE_KINDS)}.includes(failure.app?.failure?.kind ?? "")) {
    throw new Error("Add a failure kind.");
  }
  const capturedAt = new Date().toISOString();
  const saved = {
    input: structuredClone(failure),
    capture: snapshotWallet().then((wallet) => ({ capturedAt, wallet })),
  };
  failures.add(saved);
  const mounted = await loadSupport(workspace);
  await captureSavedFailures(mounted);
}

/** Call whenever the app's wallet connects, switches account or chain, or
 * disconnects. EVM: { evm: provider }. Solana: { solana: wallet }. None: null. */
export function setSupportWallet(next: SupportWallet | null) {
  wallet = next;
  widget?.setWallet(next);
}

/** Call on app sign-out and when the app shell unmounts. */
export function closeSupport() {
  loading = undefined;
  capturing = undefined;
  failures.clear();
  widget?.destroy();
  widget = undefined;
}
`;
}

/** The one install prompt: the landing page, the workspace’s Chat settings,
 * the docs and /agents.md all show it. One prompt covers EVM and Solana
 * apps; the coding tool finds the wallet library. The Chat settings page passes its
 * workspace ID. */
export function installPrompt({
  release,
  workspaceId,
  supportUrl,
  workspaceFeatures = {},
  workspaceOptions = {},
  hosts = SITE,
}: {
  release: InstallPromptRelease;
  workspaceId?: string;
  supportUrl?: string;
  workspaceFeatures?: InstallPromptWorkspaceFeatures;
  workspaceOptions?: { loopback?: boolean };
  hosts?: InstallHosts;
}): string {
  const solana =
    release.supportWidgetSolanaVerified === true ||
    workspaceFeatures.solanaSignIn === true;
  const loopback =
    release.supportWidgetLoopback === true ||
    workspaceOptions.loopback === true;
  const id = workspaceId && UUID.test(workspaceId) ? workspaceId : undefined;
  const origin = hosts.origin;
  const socket = new URL(hosts.community);
  socket.protocol = "wss:";
  const workspaceLine = id ? ` Use ${id}.` : ` ${installConnectSteps(hosts)}`;
  const testing = loopback
    ? " For local testing, this workspace also supports http://localhost:<port>."
    : " For local testing, use your host's HTTPS preview or an HTTPS tunnel to your local server. Open the app at that URL before testing.";
  return `Add Templ support chat to this app.
Start at ${origin} and read ${origin}/llms.txt for the install guide.
Ask whether I want the widget, a standalone chat link, or both.
New teams can test the visitor link under Your support chat before installing anything. To turn it on in an existing workspace, open Settings → Chat → Guest support. Select Host a support page on Templ and Save guest support. Use Copy support link${id ? ` and check that the saved address is ${supportUrl ?? `${origin}/help/${id}`}` : " to get this workspace’s address"}. Link to it from the app’s official Help or Support entry. For link only, stop after verifying the page. No widget code is needed.
For an embed or both, follow the widget steps below. Reuse the wallet connection the app already has.

Templ loads from a hosted ES module. There is no npm package. Don't install one or copy the hosted module into the repo.

Before you change code:
- Read ${origin}/agents.md and the widget guide it links.
- Check ${origin}/api/status. If support.widgetVerified is false, build the integration behind a config switch. Keep the switch off by default and tell me.
- Find the wallet library. EVM apps usually use wagmi, viem, ethers, RainbowKit, ConnectKit, Reown AppKit, Privy or Dynamic.${solana ? " Solana apps usually use @solana/wallet-adapter-react or a Wallet Standard wallet." : ""}
- Find the app shell and its Help or Support button. Find its sign-out and content security policy.
- Check the workspace's Plan page. New workspaces start in free integration mode.
  Free mode has ${PRODUCT_LIMITS.freeSupportTickets} lifetime test tickets and ${PRODUCT_LIMITS.freeTeamRepliesPerTicket} team replies per ticket. Templ AI stays off.
  Preserve existing paid access, grants, team roles and AI settings.
  Never request a staff token or wallet key to configure the workspace.
  The manager confirms workspace changes in Templ.

Install:
1. Add templ-support.ts with the code below. Use .js for a JavaScript app. In TypeScript, save ${origin}/support-widget.d.ts next to it. Add that file to tsconfig "include".
2. Read the workspace ID from the app's public config. Follow the app's naming, such as NEXT_PUBLIC_TEMPL_WORKSPACE or VITE_TEMPL_WORKSPACE.${workspaceLine}
3. Call setSupportWallet every time the wallet connects, changes account or network, or disconnects:
   - EVM: setSupportWallet({ evm: provider }). Use the EIP-1193 provider of the wallet the user picked. With wagmi, use await connector.getProvider() for the connector from useAccount(). Don't use window.ethereum when the app picked another provider.${solana ? "\n   - Solana: setSupportWallet({ solana: wallet }). Use useWallet() from @solana/wallet-adapter-react or the Wallet Standard wallet the user picked." : ""}
   - No wallet: setSupportWallet(null). Users can still ask without one.
4. Make the app's Help button call openSupport(workspaceId).
   If it rejects, show "Support couldn't load. Try again." Let the user press Help again to retry.
   If the app has no Help button, set SHOW_LAUNCHER to true.
   Call loadSupport(workspaceId) when the app shell mounts. Catch its rejection and show the same error with a Retry button.
   Make Retry call loadSupport(workspaceId) again. Hide the error after a successful mount.
   Clear the error and retry handler on sign-out or shell unmount. Ignore late failures after cleanup.
5. Find each handler where a wallet action fails.
   Handle wallet rejection, failed simulation, failed submission, and failure after a transaction was sent.
   Call captureSupportFailure(workspaceId, failure) there right away.
   Don't wait for it before showing the error. Catch its rejection so the app keeps working.
   The helper saves the details, time and wallet before loading the widget.
   A wallet change during loading must not replace that saved wallet.
   The helper keeps saved details after a failed load or capture.
   Get help retries capture before opening the chat. Never clear saved details after a failed attempt.
   Use only fields the app has:
   { network, transactionHash, app: { page, action, product, shown, error, appVersion, device, failure } }
   Show the app's error with a "Get help" button.
   Make that button call openSupport(workspaceId).
   Keep a Help link beside each pending transaction.
   Make that link call openSupport(workspaceId, { network, transactionHash }).
   Field rules:
   - network: "eip155:<chainId>"${solana ? ' or "solana"' : ""}.
   - page: starts with "/", path only, no query or fragment.
     Keep page at most ${SUPPORT_APP_LIMITS.pageChars} characters.
   - action: one of ${SUPPORT_APP_ACTIONS.join(", ")}.
   - product: a label (at most ${SUPPORT_APP_LIMITS.labelBytes} bytes), or an address with its network.
   - shown.value: the value the app showed, at most ${SUPPORT_APP_LIMITS.shownChars} characters.
     Use shown.metric to name what it measures.
     Set shown.asOf to an ISO 8601 time string.
   - error.code: at most ${SUPPORT_APP_LIMITS.codeChars} characters.
     Use only letters, digits and _ . : - in error.code.
     Keep error.message at most ${SUPPORT_APP_LIMITS.messageBytes} bytes.
     Never put other people's wallet addresses, tokens, cookies, emails or keys in error.
   - appVersion and device: short strings, at most ${SUPPORT_APP_LIMITS.shortBytes} bytes each.
   - failure.kind is required: one of ${SUPPORT_FAILURE_KINDS.join(", ")}.
     Without it, nothing is saved.
     Optional failure.amount: a decimal string such as 25.5, at most ${SUPPORT_APP_LIMITS.amountChars} characters.
     No sign, exponent or leading zeros.
     Optional failure.asset: the asset's symbol (at most ${SUPPORT_APP_LIMITS.shortBytes} bytes), or its address with its network.
   Any other field Templ can't read is left out with a console warning.
   The rest are still saved.
   The user still chooses what to share.
6. Call closeSupport() when the user signs out of the app. Also call it when the app shell unmounts. This clears saved details. On wallet disconnect, call only setSupportWallet(null). Keep the widget open across route changes.
7. If the app sets a content security policy, allow ${origin} in script-src. Allow ${hosts.community} and ${socket.origin} in connect-src. Allow ${origin} in img-src. If the policy limits style-src, make styleNonce() return the page's style nonce. If script-src uses a nonce with strict-dynamic, give the script that bundles templ-support.ts the page's nonce. Don't add a policy the app doesn't have.
8. Make the widget look like it belongs in this app from the first visit.
   Read the app's styles first. Match its font, button colors, backgrounds, borders, corners, and Help placement.
   Use appearance options on mountSupportWidget for the app's defaults.
   Saved workspace appearance settings take precedence when the widget loads.
   Leave out defaults: theme "auto", radius "soft", and position "right".
   Auto follows the host page's theme, then the user's system setting.
   Set accent to "#rrggbb" or { light: "#rrggbb", dark: "#rrggbb" }.
   Filled buttons keep the chosen accent. The widget adjusts text, links, and focus rings for contrast.
   Radius accepts "square", "soft", or "round". Position accepts "right" or "left".
   Keep the host app's font with font "inherit", or choose "system", "sans", "serif", or "mono".
   Set colors.light and colors.dark with background, surface, text, muted, and border hex colors.
   An optional logo URL changes the header and launcher icon.
   Call the returned widget's setAppearance(partial) when the app changes theme or accent.
   Each call changes only the options passed. It keeps the case and draft.

Rules:
- Don't add a second connect button or wallet modal.
- Never ask for a private key or recovery phrase.
- Support code must never start a transaction or a signature request.
  The widget requests its own sign-in signature only when the user chooses Sign in.
  The app's own user actions, such as Deposit, may request signatures and send transactions.
- Don't pass the app's login token, cookies or any data the user didn't choose to share.

\`\`\`ts
${installModule(hosts)}\`\`\`

The widget works on public HTTPS websites without website approval. Sessions stay scoped to each website and workspace.${testing}

Then test it:
- Open Help or the support launcher and send a message without a wallet.
- Reply from ${origin}/inbox. Check that the reply shows in the app.
- Connect a wallet, switch accounts and disconnect.${solana ? " Test both EVM and Solana when the app supports them." : ""}
- Make a wallet action fail, then press Get help.
- Check the selected failure details. Users can remove details before sending.
- Change wallets while the widget loads. Check that the failure keeps the wallet from that moment.
- Add a review-only Preview failed transaction control.
  Preview failed transaction opens support with a simulated error and a known failed transaction. Send no transaction.
  Keep this control out of the normal customer flow.
- In the team inbox, resolve the test case. Send a follow-up in the same chat.
  Check that the team sees it in the original case and that the visitor can still read the earlier messages after reloading.
- Block the widget module once, then press Get help to retry. Check that the saved details appear.
- Without a Help button, block the first widget load. Check the error and press Retry to load the launcher.
Tell me which checks passed and what's still missing.`;
}
