import type { CSSProperties } from "react";
import type { MemberProfile } from "@templ/chat/profiles";

/** A stable neutral pattern helps people tell accounts apart.
 * It encodes only the identifier's hash. */
function identiconStyle(seed: string): CSSProperties {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const cells = ['<rect x="3" y="3" width="1" height="1"/>'];
  for (let row = 0; row < 5; row++) {
    for (let column = 0; column < 3; column++) {
      if (((hash >>> (row * 3 + column)) & 1) === 0) continue;
      cells.push(
        `<rect x="${column + 1}" y="${row + 1}" width="1" height="1"/>`,
      );
      if (column < 2)
        cells.push(
          `<rect x="${5 - column}" y="${row + 1}" width="1" height="1"/>`,
        );
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 7 7" shape-rendering="crispEdges">${cells.join("")}</svg>`;
  const mask = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  return {
    background: "var(--fg-2)",
    maskImage: mask,
    WebkitMaskImage: mask,
    maskSize: "100% 100%",
    maskRepeat: "no-repeat",
  };
}

export function Identicon({
  seed,
  profile,
  size = 32,
  radius = 10,
  className,
}: {
  seed: string;
  profile?: MemberProfile | null;
  size?: number;
  radius?: number;
  className?: string;
}) {
  const style: CSSProperties = {
    display: "block",
    width: size,
    height: size,
    flex: "none",
    borderRadius: radius,
    ...(profile?.avatar ? {} : identiconStyle(seed.toLowerCase())),
  };
  if (profile?.avatar)
    return (
      <img
        src={profile.avatar}
        alt=""
        width={size}
        height={size}
        referrerPolicy="no-referrer"
        decoding="async"
        loading="lazy"
        className={className}
        style={{ ...style, objectFit: "cover", background: "var(--surface-4)" }}
      />
    );
  return <span aria-hidden="true" className={className} style={style} />;
}
