/** Own's opening scene for an empty chat: three conversation bubbles send
 * lime packets into a sealed lock, above a large loading label. Decorative
 * only; callers keep the accessible status text. CSS animates transform and
 * opacity, and reduced motion stays static. */
import styles from "./loading-scene.module.css";

type Shape = [tag: string, attributes: Record<string, string>, children?: Shape[] | string];
const ns = "http://www.w3.org/2000/svg";
const c = (name: string) => styles[name]!;
const bubble = (x: number, y: number, name: "bubble" | "memberBubble"): Shape => ["g", {class: c(name)}, [
  ["rect", {x: String(x), y: String(y), width: "44", height: "26", rx: "9"}],
  ["line", {x1: String(x + 9), y1: String(y + 10), x2: String(x + 33), y2: String(y + 10)}],
  ["line", {x1: String(x + 9), y1: String(y + 17), x2: String(x + 25), y2: String(y + 17)}],
]];
const layer = (children: Shape[], extra = "") => ["g", {class: `${c("layer")}${extra && ` ${extra}`}`}, children] as Shape;
// Centre (180, 130). Bubbles sit on the 84-unit ring; the spark orbits at 112.
// Reserve a separate lower band for the moving label, below every orbit.
const scene: Shape = ["svg", {viewBox: "0 0 360 348", class: c("art"), "aria-hidden": "true", focusable: "false"}, [
  layer([
    ["circle", {cx: "180", cy: "130", r: "112", class: c("track")}],
    ["circle", {cx: "180", cy: "130", r: "84", class: c("faint")}],
    ["g", {class: c("spin")}, [["circle", {cx: "180", cy: "130", r: "56", class: c("dash")}]]],
  ]),
  layer([["g", {class: c("orbit")}, [
    // Trail points 20° and 10° behind the spark on the same ring.
    ["circle", {cx: "141.7", cy: "24.8", r: "2", class: c("trail")}],
    ["circle", {cx: "160.6", cy: "19.7", r: "3", class: c("trail")}],
    ["circle", {cx: "180", cy: "18", r: "4", class: c("spark")}],
  ]]], c("late")),
  layer([
    ["line", {x1: "107", y1: "88", x2: "180", y2: "130", class: c("link")}],
    ["line", {x1: "253", y1: "88", x2: "180", y2: "130", class: c("link")}],
    ["line", {x1: "180", y1: "214", x2: "180", y2: "130", class: c("link")}],
    ["circle", {cx: "107", cy: "88", r: "3.5", class: `${c("packet")} ${c("fromLeft")}`}],
    ["circle", {cx: "253", cy: "88", r: "3.5", class: `${c("packet")} ${c("fromRight")}`}],
    ["circle", {cx: "180", cy: "214", r: "3.5", class: `${c("packet")} ${c("fromBelow")}`}],
  ]),
  layer([bubble(85, 75, "bubble"), bubble(231, 75, "memberBubble"), bubble(158, 201, "bubble")], c("late")),
  layer([
    ["circle", {cx: "180", cy: "130", r: "30", class: c("halo")}],
    ["circle", {cx: "180", cy: "130", r: "30", class: `${c("halo")} ${c("haloLater")}`}],
    ["circle", {cx: "180", cy: "130", r: "30", class: c("seal")}],
    // Tabler Icons 3.36.1 lock (MIT), as in icons.ts.
    ["svg", {x: "166", y: "116", width: "28", height: "28", viewBox: "0 0 24 24", class: c("lock")}, [
      ["path", {d: "M5 13a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v6a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-6"}],
      ["path", {d: "M11 16a1 1 0 1 0 2 0a1 1 0 0 0 -2 0"}],
      ["path", {d: "M8 11v-4a4 4 0 1 1 8 0v4", class: c("shackle")}],
    ]],
  ]),
  layer([["g", {class: c("labelFloat")}, [
    ["text", {x: "180", y: "304", "text-anchor": "middle", class: c("label")}, "Encrypting…"],
  ]]], c("labelIn")),
]];

function draw([tag, attributes, children = []]: Shape): Element {
  const result = document.createElementNS(ns, tag);
  for (const [key, value] of Object.entries(attributes)) result.setAttribute(key, value);
  if (typeof children === "string") result.textContent = children;
  else result.append(...children.map(draw));
  return result;
}

export function openingScene() {
  const root = document.createElement("div");
  root.className = c("scene");
  root.append(draw(scene));
  return root;
}

/** The first-send illustration follows the phase announced beside it. */
export function sendMotion() {
  const packets: Shape[] = [2, 10, 18].map((x) => [
    "rect", {class: c("sendPacket"), x: String(x), y: "10.5", width: "6", height: "6", rx: "2"},
  ]);
  return draw(["svg", {viewBox: "0 0 64 24", class: c("sendMotion"),
    "aria-hidden": "true", focusable: "false"}, [
    ["path", {class: c("sendTrack"), d: "M2 13.5H62"}],
    ...packets,
    ["path", {class: c("sendShackle"), d: "M29 9V6.5a3 3 0 0 1 6 0V9"}],
    ["rect", {class: c("sendLock"), x: "26", y: "9", width: "12", height: "9", rx: "2.5"}],
    ["path", {class: c("sendScan"), d: "M28.5 11H35.5"}],
    ["rect", {class: c("sendOut"), x: "40", y: "10.5", width: "6", height: "6", rx: "2"}],
  ]]) as SVGSVGElement;
}
