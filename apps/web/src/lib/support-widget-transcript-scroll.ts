/** Keep an open standalone conversation anchored as messages and the composer change size. */
export function followTranscript(body: HTMLElement, form: HTMLFormElement, signal: AbortSignal) {
  const jump = document.createElement("button");
  jump.type = "button";
  jump.className = "jump-latest";
  jump.textContent = "Jump to latest";
  jump.hidden = true;
  form.prepend(jump);

  // Match the conversation's existing near-bottom threshold.
  const atEnd = () => body.scrollHeight - body.scrollTop - body.clientHeight < 72;
  let following = true;
  let height = body.clientHeight;
  function remember() {
    if (!body.clientHeight) return;
    height = body.clientHeight;
    following = atEnd();
    jump.hidden = following;
  }
  function latest() {
    body.scrollTop = body.scrollHeight;
    remember();
  }
  body.addEventListener("scroll", () => {
    if (body.clientHeight === height) remember();
  }, {passive: true, signal});
  const resize = new ResizeObserver(() => {
    if (!body.clientHeight) return;
    if (following) latest();
    else remember();
  });
  resize.observe(body);
  signal.addEventListener("abort", () => resize.disconnect(), {once: true});
  jump.addEventListener("click", () => {
    latest();
    const rows = body.querySelectorAll<HTMLElement>(".message[data-message-id]");
    const target = rows.item(rows.length - 1) ?? body;
    target.tabIndex = -1;
    target.focus({preventScroll: true});
  }, {signal});

  return {
    latest,
    remember,
    beforeRender() {
      if (!body.clientHeight) return;
      if (body.clientHeight === height ? atEnd() : following) return latest;
      const top = body.getBoundingClientRect().top;
      const anchor = Array.from(body.querySelectorAll<HTMLElement>(".message[data-message-id]"))
        .find(row => row.getBoundingClientRect().bottom > top);
      const offset = anchor && anchor.getBoundingClientRect().top - top;
      const previous = body.scrollTop;
      return () => {
        if (anchor && offset !== undefined && body.contains(anchor)) {
          const delta = anchor.getBoundingClientRect().top - body.getBoundingClientRect().top - offset;
          // WebKit truncates scrollTop. Round opposite layout shifts equally so the offsets cancel.
          body.scrollTop += Math.sign(delta) * Math.round(Math.abs(delta));
        } else body.scrollTop = previous;
        remember();
      };
    },
  };
}
