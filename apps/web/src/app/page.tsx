import type { Metadata, Viewport } from "next";
import { copy } from "@/lib/copy";
import hero from "@/components/pages/landing/hero-copy.json";
import { LandingPage } from "@/components/pages/landing/landing-page";

const title = copy("landing.meta.title");
const description = copy("landing.meta.description");
const images = [
  {
    url: "/art/og/templ-og.png?v=private-support",
    width: 1200,
    height: 630,
    alt: hero.headline,
  },
];

export const metadata: Metadata = {
  title: { absolute: title },
  description,
  openGraph: {
    type: "website",
    siteName: "Templ",
    url: "/",
    title,
    description,
    images,
  },
  twitter: { card: "summary_large_image", title, description, images },
  alternates: { canonical: "/" },
};

export const viewport: Viewport = {
  colorScheme: "light",
  themeColor: "#fcfcfc",
};

export default function HomePage() {
  return <LandingPage />;
}
