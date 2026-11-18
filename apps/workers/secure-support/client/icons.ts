/** Tabler Icons 3.36.1 (MIT), from the installed @tabler/icons-react icon nodes.
 * Rendered as DOM to keep the isolated client independent of React. */
const nodes = {
  clock: [["path", {d: "M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0"}], ["path", {d: "M12 7v5l3 3"}]],
  check: [["path", {d: "M5 12l5 5l10 -10"}]],
  "person":[["path",{"d":"M8 7a4 4 0 1 0 8 0a4 4 0 0 0 -8 0","key":"svg-0"}],["path",{"d":"M6 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2","key":"svg-1"}]],"notify":[["path",{"d":"M10 5a2 2 0 1 1 4 0a7 7 0 0 1 4 6v3a4 4 0 0 0 2 3h-16a4 4 0 0 0 2 -3v-3a7 7 0 0 1 4 -6","key":"svg-0"}],["path",{"d":"M9 17v1a3 3 0 0 0 6 0v-1","key":"svg-1"}]],"wallet":[["path",{"d":"M17 8v-3a1 1 0 0 0 -1 -1h-10a2 2 0 0 0 0 4h12a1 1 0 0 1 1 1v3m0 4v3a1 1 0 0 1 -1 1h-12a2 2 0 0 1 -2 -2v-12","key":"svg-0"}],["path",{"d":"M20 12v4h-4a2 2 0 0 1 0 -4h4","key":"svg-1"}]],"new":[["path",{"d":"M12 5l0 14","key":"svg-0"}],["path",{"d":"M5 12l14 0","key":"svg-1"}]],"close":[["path",{"d":"M18 6l-12 12","key":"svg-0"}],["path",{"d":"M6 6l12 12","key":"svg-1"}]],"send":[["path",{"d":"M10 14l11 -11","key":"svg-0"}],["path",{"d":"M21 3l-6.5 18a.55 .55 0 0 1 -1 0l-3.5 -7l-7 -3.5a.55 .55 0 0 1 0 -1l18 -6.5","key":"svg-1"}]],"more":[["path",{"d":"M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0","key":"svg-0"}],["path",{"d":"M11 19a1 1 0 1 0 2 0a1 1 0 1 0 -2 0","key":"svg-1"}],["path",{"d":"M11 5a1 1 0 1 0 2 0a1 1 0 1 0 -2 0","key":"svg-2"}]],"lock":[["path",{"d":"M5 13a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v6a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-6","key":"svg-0"}],["path",{"d":"M11 16a1 1 0 1 0 2 0a1 1 0 0 0 -2 0","key":"svg-1"}],["path",{"d":"M8 11v-4a4 4 0 1 1 8 0v4","key":"svg-2"}]]} as const;

export function domIcon(name: keyof typeof nodes) {
  const ns = "http://www.w3.org/2000/svg", svg = document.createElementNS(ns, "svg");
  for (const [key, value] of Object.entries({viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.75", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", width: "18", height: "18"})) svg.setAttribute(key, value);
  for (const [tag, attrs] of nodes[name]) {
    const child = document.createElementNS(ns, tag);
    for (const [key, value] of Object.entries(attrs)) if (key !== "key") child.setAttribute(key, value);
    svg.append(child);
  }
  return svg;
}

export function labelIcon(button: HTMLButtonElement, name: keyof typeof nodes, label: string) {
  button.replaceChildren(domIcon(name)); button.setAttribute("aria-label", label); button.title = label;
  return button;
}
