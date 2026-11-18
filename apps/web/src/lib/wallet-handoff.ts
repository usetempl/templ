import { SITE } from "./site-environment";
import { LINKED_INBOX_VIEWS } from "./inbox-link-view";

export type WalletHandoff = {
  mobile: boolean;
  siteUrl?: string;
  deepLink?: string;
  /** The rebuilt link opens one request or an inbox view (it carries
   * `support` or `view`), not only a page. */
  request?: true;
};

export class WalletHandoffRequired extends Error {
  constructor() {
    super("Choose a wallet to continue.");
    this.name = "WalletHandoffRequired";
  }
}

// Public app pages and a workspace (a native room id, UUIDv7). Other pages
// are not forwarded.
const SAFE_PATH =
  /^\/(?:(?:create|inbox|rooms\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/?)?$/i;
const ROOM_PATH = /^\/rooms\//i;
/** The only search parameters a workspace link keeps, in this order. The
 * `tc-` id is opaque: opening it still needs a staff session and current
 * access. */
const SAFE_QUERY = [
  ["team", /^1$/],
  ["tab", /^inbox$/],
  ["view", new RegExp(`^(?:${LINKED_INBOX_VIEWS.join("|")})$`)],
  ["support", /^tc-[0-9a-f]{32}$/],
] as const;

export function walletHandoff(
  href: string,
  userAgent: string,
  touchPoints = 0,
): WalletHandoff {
  const mobile =
    /Android|iPhone|iPad|iPod/i.test(userAgent) ||
    (/Macintosh/i.test(userAgent) && touchPoints > 1);
  const options: WalletHandoff = { mobile };
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return options;
  }
  if (
    url.protocol !== "https:" ||
    url.origin !== SITE.origin ||
    url.port ||
    url.username ||
    url.password
  )
    return options;

  // Only public app routes leave this browser. Never forward credentials,
  // fragments, local URLs, or arbitrary path contents. A workspace link keeps
  // only the allowlisted parameters whose values match; everything else,
  // including a repeated or malformed parameter, is dropped.
  const pathname = SAFE_PATH.test(url.pathname) ? url.pathname : "/";
  const query = new URLSearchParams();
  if (ROOM_PATH.test(pathname))
    for (const [name, pattern] of SAFE_QUERY) {
      const values = url.searchParams.getAll(name);
      if (values.length === 1 && pattern.test(values[0]))
        query.set(name, values[0]);
    }
  const encoded = query.toString();
  const search = encoded ? `?${encoded}` : "";
  options.siteUrl = `${url.origin}${pathname}${search}`;
  if (query.has("support") || query.has("view")) options.request = true;
  if (mobile) {
    // MetaMask's official dapp-link generator uses /dapp/<HTTPS URL without scheme>.
    // https://github.com/MetaMask/metamask-deeplinks/blob/master/js/bundle.js
    options.deepLink = `https://metamask.app.link/dapp/${url.host}${pathname}${search}`;
  }
  return options;
}

export type SolanaWalletApp = "phantom" | "solflare" | "backpack";
export type SolanaBrowserLink = {
  wallet: SolanaWalletApp;
  name: string;
  href: string;
};
/** Each wallet's published "browse" link, which opens a page in the wallet's
 * own browser. Both parts are URL-encoded; `ref` is the requesting site.
 * https://docs.phantom.com/phantom-deeplinks/other-methods/browse
 * https://docs.solflare.com/solflare/technical/deeplinks/other-methods/browse
 * https://docs.backpack.app/deeplinks/other-methods/browse */
const SOLANA_BROWSE: readonly {
  wallet: SolanaWalletApp;
  name: string;
  base: string;
}[] = [
  {
    wallet: "phantom",
    name: "Phantom",
    base: "https://phantom.app/ul/browse/",
  },
  {
    wallet: "solflare",
    name: "Solflare",
    base: "https://solflare.com/ul/v1/browse/",
  },
  {
    wallet: "backpack",
    name: "Backpack",
    base: "https://backpack.app/ul/v1/browse/",
  },
];

/** Links that open the handoff's cleaned page in a Solana wallet's browser,
 * only on a phone and only for a URL `walletHandoff` rebuilt. */
export function solanaBrowserLinks(
  options: WalletHandoff,
): SolanaBrowserLink[] {
  if (!options.mobile || !options.siteUrl || !options.deepLink) return [];
  const url = encodeURIComponent(options.siteUrl);
  const ref = encodeURIComponent(new URL(options.siteUrl).origin);
  return SOLANA_BROWSE.map(({ wallet, name, base }) => ({
    wallet,
    name,
    href: `${base}${url}?ref=${ref}`,
  }));
}
