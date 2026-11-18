/** The widget's `media` chunk: the Add screenshot button,
 * and a member adding a screenshot to their own request. The browser redraws the image as a PNG of at most
 * 2,048 pixels on its longest side, which drops its EXIF, GPS and text
 * metadata, and shrinks it until it fits the service's limit. The member
 * checks it before it goes. The service re-encodes it again from its pixels.
 * Loaded from the Add screenshot button, which shows only while Templ has
 * member screenshots on. The widget never reads screenshots back. */
import { FEATURE_LIMITS } from "@templ/chat/feature-limits";
import type { TailHost } from "./support-widget";

export const MEDIA_COPY = {
  type: "Choose a PNG, JPEG or WebP image.",
  large: "This image is too large. Try a smaller screenshot.",
  heading: "Check the screenshot",
  line: "Make sure it shows no recovery phrase, private key or password.",
  send: "Send screenshot",
  cancel: "Cancel",
  sent: "Screenshot sent.",
  full: "This case can't take more screenshots.",
} as const;
const TYPES = ["image/png", "image/jpeg", "image/webp"];
/** The largest file the picker takes before it is redrawn. */
const INPUT_BYTES = 10_000_000;
const LONGEST = 2048;

type Drawn = { width: number; height: number; close?(): void };
export type Encoder = {
  /** Decodes the file with its orientation applied. */
  decode(file: Blob): Promise<Drawn>;
  /** Draws it at this size and returns the PNG and what shows it. */
  encode(
    image: Drawn,
    width: number,
    height: number,
  ): Promise<{ png: Blob; preview: HTMLElement }>;
};
const browserEncoder: Encoder = {
  decode: (file) => createImageBitmap(file, { imageOrientation: "from-image" }),
  encode(image, width, height) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas
      .getContext("2d")!
      .drawImage(image as ImageBitmap, 0, 0, width, height);
    return new Promise((resolve, reject) =>
      canvas.toBlob(
        (png) =>
          png
            ? resolve({ png, preview: canvas })
            : reject(new Error(MEDIA_COPY.large)),
        "image/png",
      ),
    );
  },
};

/** The PNG to send: the file redrawn at most 2,048 pixels on its longest
 * side, then 80% smaller each time, up to four times, while it is over the
 * limit. */
export async function prepareScreenshot(
  file: Blob,
  encoder: Encoder = browserEncoder,
  limit: number = FEATURE_LIMITS.memberScreenshotMaxBytes,
) {
  if (!TYPES.includes(file.type)) throw new Error(MEDIA_COPY.type);
  if (file.size > INPUT_BYTES) throw new Error(MEDIA_COPY.large);
  let image: Drawn;
  try {
    image = await encoder.decode(file);
  } catch {
    throw new Error(MEDIA_COPY.type);
  }
  try {
    let scale = Math.min(1, LONGEST / Math.max(image.width, image.height));
    for (let attempt = 0; attempt < 5; attempt++, scale *= 0.8) {
      const width = Math.max(1, Math.round(image.width * scale));
      const height = Math.max(1, Math.round(image.height * scale));
      const drawn = await encoder.encode(image, width, height);
      if (drawn.png.size <= limit) return drawn;
    }
  } finally {
    image.close?.();
  }
  throw new Error(MEDIA_COPY.large);
}

/** A UUIDv7 for the upload, so a retry is taken once. */
function uploadId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let time = Date.now();
  for (let index = 5; index >= 0; index--) {
    bytes[index] = time & 255;
    time = Math.floor(time / 256);
  }
  bytes[6] = (bytes[6] & 15) | 0x70;
  bytes[8] = (bytes[8] & 63) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

type Adopted = readonly [
  { token: string } | undefined,
  (path: string, body?: object) => Promise<unknown>,
  unknown,
  string,
];
/** Sends the PNG to the member's thread: a lost answer is sent again with
 * the same id, twice at most. */
export async function uploadScreenshot(
  host: Pick<TailHost, "client">,
  thread: string,
  png: Blob,
  id = uploadId(),
  fetcher: typeof fetch = fetch,
) {
  const adopt = () => (host.client as unknown as { adopt(): Adopted }).adopt();
  // The member's own read of the thread first: it renews a guest's hour and
  // checks the thread is theirs before any bytes go.
  await adopt()[1](`/conversations/${thread}/workflow`);
  const [session, , , base] = adopt();
  if (!session) throw new Error("Sign in again to keep your case.");
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetcher(
        `${base}/conversations/${thread}/workflow?clientId=${id}`,
        {
          method: "POST",
          credentials: "omit",
          cache: "no-store",
          headers: {
            Authorization: `Bearer ${session.token}`,
            "Content-Type": "image/png",
          },
          body: png,
        },
      );
    } catch (reason) {
      if (attempt < 2) {
        await new Promise((done) => setTimeout(done, 1000));
        continue;
      }
      throw reason;
    }
    if (response.ok) return;
    const body = (await response.json().catch(() => null)) as {
      error?: unknown;
    } | null;
    if (response.status === 413) throw new Error(MEDIA_COPY.large);
    throw new Error(
      typeof body?.error == "string"
        ? body.error
        : response.status === 409
          ? MEDIA_COPY.full
          : "Support is unavailable. Try again.",
    );
  }
}

/** Check, then send or cancel, above the message box. Resolves true when
 * the member chose to send. */
function confirm(host: TailHost, preview: HTMLElement) {
  const { el } = host;
  const form = host.draft.closest("form")!;
  const box = el("div", undefined, "card");
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", MEDIA_COPY.heading);
  Object.assign(preview.style, {
    display: "block",
    maxWidth: "100%",
    maxHeight: "180px",
    margin: "8px 0",
    borderRadius: "10px",
  });
  const send = el("button", MEDIA_COPY.send, "primary");
  const cancel = el("button", MEDIA_COPY.cancel, "quiet");
  send.type = cancel.type = "button";
  box.append(
    el("strong", MEDIA_COPY.heading),
    el("p", MEDIA_COPY.line),
    preview,
    send,
    cancel,
  );
  form.insertBefore(box, form.querySelector(".composer"));
  send.focus();
  return {
    box,
    chosen: new Promise<boolean>((resolve) => {
      send.addEventListener("click", () => resolve(true));
      cancel.addEventListener("click", () => resolve(false));
    }),
  };
}

/** @public Lazy chunk entry: the member lines load it from the Add
 * screenshot button, through a dynamic import the dead-code check cannot
 * follow. */
export async function media(
  host: TailHost,
  thread: string,
  file: Blob,
  encoder?: Encoder,
) {
  const { png, preview } = await prepareScreenshot(file, encoder);
  const { box, chosen } = confirm(host, preview);
  try {
    if (!(await chosen)) return;
    box.replaceChildren(host.el("p", "Sending…"));
    await uploadScreenshot(host, thread, png);
    box.replaceChildren(host.el("p", MEDIA_COPY.sent));
    box.setAttribute("role", "status");
    await new Promise((done) => setTimeout(done, 2500));
  } finally {
    box.remove();
    host.draft.focus();
  }
}

const buttons = new WeakMap<
  TailHost,
  { node: HTMLButtonElement; thread: string }
>();
/** @public The Add screenshot button in the tools row, for `thread`: a
 * click opens the file picker at once; the chosen file is checked, shown
 * and sent. A new session hides it until the next thread shows. */
export function button(host: TailHost, thread: string) {
  let held = buttons.get(host);
  const tools = host.draft.closest("form")?.querySelector(".tools");
  if (!tools) return;
  if (!held) {
    const node = host.el("button", "Add screenshot", "quiet");
    node.type = "button";
    const entry = (held = { node, thread });
    buttons.set(host, held);
    node.addEventListener("click", () => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = TYPES.join();
      input.addEventListener("change", () => {
        const file = input.files?.[0];
        if (file) void host.run(() => media(host, entry.thread, file));
      });
      input.click();
    });
    host.client.onSessionChange(() => (node.hidden = true));
    tools.insertBefore(node, tools.children[1] ?? null);
  }
  held.thread = thread;
  held.node.hidden = false;
}
