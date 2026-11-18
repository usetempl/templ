import { getRelease, getReleaseConfiguration } from "@/lib/config";
import { ReleaseProvider } from "@/lib/release-context";
import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import { headers } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";
import { AppShell } from "@/components/app-shell";
import { AnalyticsProvider } from "@/components/analytics-provider";
import { AppTheme } from "@/components/app-theme";
import { APP_THEME_SCRIPT } from "@/lib/app-theme";
import { brandAsset } from "@/lib/brand-assets";
import { CommunityPreconnect } from "@/components/community-preconnect";
import { APP_ENVIRONMENT, SITE } from "@/lib/release-public";
import { searchRobotsMetadata } from "../../scripts/search-indexing.mjs";
import { ChatAuthProvider } from "@/lib/chat-auth";
import { WalletProvider } from "@/lib/wallet";
import { CommunityDirectoryProvider } from "@/lib/community-directory";
import { copy as t } from "@/lib/copy";
import { OPERATOR } from "@/lib/operator";
import "./globals.css";

const geist = Geist({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
  preload: false,
});
const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
  preload: false,
});

/** Landing metadata. Other pages set their own title (through the template)
 * and description; Next copies them into the share tags, and the layout adds
 * only the share image. */
export async function generateMetadata(): Promise<Metadata> {
  const RELEASE = await getRelease();
  const title = t("landing.meta.title");
  const description = t("landing.meta.description", {
    networks:
      RELEASE.supportWidgetSolanaVerified === true ? "EVM and Solana" : "EVM",
  });
  return {
    metadataBase: new URL(SITE.origin),
    title: {
      default: title,
      template: "%s | Templ",
    },
    description,
    robots: searchRobotsMetadata(APP_ENVIRONMENT, RELEASE),
    icons: { apple: "/apple-touch-icon.png" },
    openGraph: {
      type: "website",
      images: [{ url: "/art/og/templ-og.png", width: 1200, height: 630 }],
    },
    twitter: {
      card: "summary_large_image",
      images: ["/art/og/templ-og.png"],
    },
  };
}
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#FCFCFC" },
    { media: "(prefers-color-scheme: dark)", color: "#0D0D0D" },
  ],
  colorScheme: "light dark",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // The per-request CSP nonce is attached by proxy.ts. Waiting for the
  // request keeps every HTML response dynamic so framework scripts receive it.
  await connection();
  const configuration = await getReleaseConfiguration();
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html
      lang="en"
      suppressHydrationWarning
      data-scroll-behavior="smooth"
      className={`${geist.variable} ${geistMono.variable}`}
    >
      <head>
        <link
          id="templ-theme-icon"
          rel="icon"
          type="image/svg+xml"
          href={brandAsset("/favicon.svg")}
        />
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{ __html: APP_THEME_SCRIPT }}
        />
        <link
          rel="alternate"
          type="text/plain"
          title="llms.txt"
          href="/llms.txt"
        />
      </head>
      <body>
        <AppTheme />
        <script
          type="application/ld+json"
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "Organization",
              "@id": "https://usetempl.com/#organization",
              name: "Templ",
              legalName: OPERATOR.legalName,
              url: "https://usetempl.com",
              logo: "https://usetempl.com/favicon.svg",
            }).replace(/</g, "\\u003c"),
          }}
        />
        <CommunityPreconnect />
        <AnalyticsProvider />
        <a className="skip-link" href="#main-content">
          {t("shell.skipToContent")}
        </a>
        <ReleaseProvider configuration={configuration}>
          <WalletProvider>
            <ChatAuthProvider>
              <CommunityDirectoryProvider>
                <AppShell>{children}</AppShell>
              </CommunityDirectoryProvider>
            </ChatAuthProvider>
          </WalletProvider>
        </ReleaseProvider>
      </body>
    </html>
  );
}
