import type { TailHost } from "./support-widget";

/** Shared source, bundled separately into each wallet family's chunk. */
export function signInSteps() {
  let host: TailHost | undefined;
  let rows: HTMLElement[] = [];
  let stage = 1;
  const update = (next: number) => {
    stage = next;
    rows.forEach((row, index) => {
      const done = stage > index + 1;
      const locked = stage < index + 1;
      row.dataset.state = done ? "done" : locked ? "locked" : "current";
      row.setAttribute("aria-disabled", String(locked));
      row.lastElementChild!.textContent = done ? "✓" : locked ? "" : "→";
    });
  };
  return {
    update,
    mount(next: TailHost) {
      if (host === next) return;
      host = next;
      host.welcome.querySelector(".sign-steps")?.remove();
      host.style.textContent +=
        '.sign-steps{display:grid;gap:8px;margin:16px 0}.sign-step{display:flex;align-items:center;gap:12px;min-height:58px;padding:10px 14px;border:1px solid var(--b);border-radius:12px;background:var(--s);font-size:14px}.sign-step[data-state="current"]{border-color:var(--a)}.sign-step[data-state="locked"]{border-style:dashed}.sign-step b{display:grid;place-items:center;width:32px;height:34px;border-radius:4px 4px 12px 4px;background:var(--s2);color:var(--t);font-size:24px;line-height:1}.sign-step span:last-child{margin-left:auto}.sign-step[data-state="done"] span:last-child{color:var(--t)}';
      const list = host.el("div", undefined, "sign-steps");
      list.setAttribute("role", "group");
      list.setAttribute("aria-label", "Wallet sign-in steps");
      rows = ["Connect wallet", "Sign to verify"].map((label, index) => {
        const row = host!.el("div", undefined, "sign-step");
        row.setAttribute("role", "group");
        row.setAttribute("aria-label", label);
        const mark = host!.el("span");
        mark.setAttribute("aria-hidden", "true");
        row.append(
          host!.el("b", String(index + 1)),
          host!.el("span", label),
          mark,
        );
        list.append(row);
        return row;
      });
      host.signIn.before(list);
      update(stage);
    },
  };
}
