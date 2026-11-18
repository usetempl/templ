export type AppEnvironment = "staging" | "production";

const configured = process.env.NEXT_PUBLIC_APP_ENV ?? "staging";
if (configured !== "staging" && configured !== "production")
  throw new Error("NEXT_PUBLIC_APP_ENV must be staging or production.");

export const APP_ENVIRONMENT: AppEnvironment = configured;
/** Public URLs for a local or self-hosted instance. */
const localSite = "http://127.0.0.1:6969";
export const SITE = {
  origin: process.env.NEXT_PUBLIC_TEMPL_SITE_ORIGIN ?? localSite,
  frame: process.env.NEXT_PUBLIC_TEMPL_FRAME_ORIGIN ?? "http://127.0.0.1:8789",
  community: process.env.NEXT_PUBLIC_TEMPL_API_ORIGIN ?? "http://127.0.0.1:8787",
  docs: process.env.NEXT_PUBLIC_TEMPL_DOCS_ORIGIN ?? localSite,
  blog: process.env.NEXT_PUBLIC_TEMPL_BLOG_ORIGIN ?? localSite,
} as const;
