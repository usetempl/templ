import type { Metadata } from "next";
import cryptoDesk from "@/lib/crypto-desk-copy.json";
import { CRYPTO_SUPPORT_WORKSPACE } from "@templ/chat/support-models";
import { APP_ENVIRONMENT } from "@/lib/site-environment";

type SearchParams = Record<string, string | string[] | undefined>;

/** Tab, case and invitation links keep opening the signed-in chat. */
export const visitorLink = ({ tab, support, invite }: SearchParams) =>
  !tab && !support && !invite;

/** The names the community worker resolves to the public crypto desk. */
const DESK_NAMES = new Set(["crypto", "eth", "ethereum"]);

/** Share details for a production visitor link to the public crypto desk, or
 * null. Every desk name shares the fixed /crypto link, and nothing from the
 * request reaches the metadata. */
export async function cryptoDeskMetadata(
  slug: string,
  searchParams: SearchParams,
  hostedWorkspace: (slug: string) => Promise<string | null>,
): Promise<Metadata | null> {
  const name = slug.toLowerCase();
  if (
    !CRYPTO_SUPPORT_WORKSPACE || APP_ENVIRONMENT !== "production" ||
    !visitorLink(searchParams) ||
    !DESK_NAMES.has(name)
  )
    return null;
  try {
    if ((await hostedWorkspace(name)) !== CRYPTO_SUPPORT_WORKSPACE) return null;
  } catch {
    // The page handles the failed lookup.
    return null;
  }
  const title = "Crypto help desk by Templ";
  const { description, headline } = cryptoDesk;
  const images = [{ url: "https://usetempl.com/art/og/crypto-help.png", width: 1200, height: 630, alt: headline }];
  return {
    title: { absolute: title },
    description,
    alternates: { canonical: "/crypto" },
    openGraph: {
      type: "website",
      title,
      description,
      url: "/crypto",
      images,
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images,
    },
  };
}
