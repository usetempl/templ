import versions from "./brand-asset-versions.json";

/** The content key changes when the founder's generated asset changes. */
export function brandAsset(path: keyof typeof versions): string {
  return `${path}?v=${versions[path]}`;
}
