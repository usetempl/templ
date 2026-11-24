import type { Metadata, Viewport } from "next";
import { LandingPage } from "@/components/pages/landing/landing-page";

export const metadata: Metadata = {
  alternates: { canonical: "/" },
};

export const viewport: Viewport = {
  colorScheme: "light",
  themeColor: "#fcfcfc",
};

export default function HomePage() {
  return <LandingPage />;
}
