import hero from "../../components/pages/landing/hero-copy.json";

export const landing = {
  "landing.meta.title": `${hero.headline} | Templ`,
  "landing.meta.description": hero.description.join(" "),
} as const;
