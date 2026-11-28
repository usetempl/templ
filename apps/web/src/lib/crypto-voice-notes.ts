import { fillTokens, type CryptoChatLanguageStore } from "./crypto-chat-language";
import type { CryptoChatString } from "./crypto-chat-strings";
import { cryptoVoiceNotesOn } from "./crypto-voice-loader";
import {
  VOICE_MAX_FRAMES,
  VOICE_MIN_FRAMES,
  VOICE_RATE,
  encodeVoiceWav,
  playVoiceClip,
  startVoiceCapture,
  type VoiceCapture,
  type VoiceCaptureFailure,
  type VoiceClip,
} from "./crypto-voice-recorder";
import type { CryptoVoiceString } from "./crypto-voice-strings";
import { transcribeVoiceNote, type VoiceNoteFailure } from "./crypto-voice-transcribe";
import type { TailHost } from "./support-widget";
import { widgetMessageId } from "./support-widget-message-id";

/** Tabler outline icons, each as one path for the widget's icon helper. */
const MIC = "M9 5a3 3 0 0 1 6 0v5a3 3 0 0 1-6 0zM5 10a7 7 0 0 0 14 0M8 21h8M12 17v4";
const LOCK = "M5 13a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2zM8 11V7a4 4 0 0 1 8 0v4";
const TRASH = "M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3";
const CLOSE = "M6 6l12 12M18 6L6 18";
const STOP = "M5 7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z";
const PLAY = "M7 4v16l13-8z";
const SEND = "M4 12l16-8-6 16-3-7zM11 13l9-9";

/** A release after this much audio sends; a shorter press keeps recording without holding. */
const HOLD_FRAMES = VOICE_RATE / 2;
/** Sliding this far up while holding locks the recording. */
const LOCK_SLIDE = 56;
/** A note whose loudest sample stays under this (about -46 dBFS) holds no speech. */
const QUIET = 0.005;
const BARS = 16;
const STYLE = `
.composer[data-crypto-voice]{position:relative;overflow:visible}
.composer[data-crypto-voice=idle]>.send,.composer[data-crypto-voice]:not([data-crypto-voice=idle])>:not(.crypto-voice,.crypto-voice-mic,.crypto-voice-lock){display:none}
.crypto-voice-mic,.crypto-voice-lock,.crypto-voice button{display:grid;place-items:center;flex:none;width:44px;height:44px;border-radius:50%;color:var(--m)}
:is(.crypto-voice-mic,.crypto-voice-lock,.crypto-voice button) svg{width:20px;height:20px}
.crypto-voice-mic{touch-action:none;-webkit-touch-callout:none;-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent;transition:transform .16s,background .16s}
.crypto-voice-mic[aria-pressed=true],.crypto-voice .crypto-voice-send{background:var(--a);color:var(--oa)}
.crypto-voice-mic[aria-pressed=true]{transform:scale(1.1)}
.crypto-voice-lock{position:absolute;inset-block-end:calc(100% + 12px);inset-inline-end:0;z-index:4;border:1px solid var(--b2);background:var(--bg);color:var(--t);box-shadow:0 4px 16px var(--shc)}
.crypto-voice{display:flex;flex:1;align-items:center;gap:2px;min-width:0;min-height:44px;border-radius:22px;background:var(--s)}
.crypto-voice-dot{flex:none;width:8px;height:8px;margin-inline:6px 4px;border-radius:50%;background:var(--d);animation:blink 1.2s infinite}
.crypto-voice-time{flex:none;min-width:5ch;margin-inline:4px auto;color:var(--t);font-size:14px;font-variant-numeric:tabular-nums}
.crypto-voice-level{display:flex;flex:1;align-items:center;justify-content:flex-end;gap:3px;min-width:0;height:24px;padding-inline:4px;overflow:hidden}
.crypto-voice-level i{flex:none;width:3px;height:calc(4px + var(--v,0)*18px);border-radius:2px;background:var(--m);transition:height .1s linear}
.crypto-voice-level[data-calm] i:nth-child(n+4){display:none}
.crypto-voice-working{display:flex;flex:1;gap:4px;padding-inline:6px}
.crypto-voice-working i{width:6px;height:6px;border-radius:50%;background:var(--m);animation:blink 1.2s infinite}
.crypto-voice-working i:nth-child(2){animation-delay:.2s}
.crypto-voice-working i:nth-child(3){animation-delay:.4s}
.crypto-voice-status,.crypto-voice-error{margin:0 6px 6px;color:var(--m);font-size:13px;line-height:1.4;text-align:start;overflow-wrap:anywhere}
.crypto-voice-error{color:var(--d)}
.crypto-voice-status:empty,.crypto-voice-error:empty{display:none}
@media(hover:hover){
  .crypto-voice-mic:not([aria-pressed]):hover,.crypto-voice button:hover{background:var(--s2);color:var(--t)}
  .crypto-voice .crypto-voice-send:hover{background:var(--ah);color:var(--oh)}
}
`;

type State = "idle" | "starting" | "holding" | "locked" | "stopping" | "review" | "uploading" | "transcribing";
type Text = CryptoVoiceString | CryptoChatString;
type Line = readonly [text: Text, values?: Readonly<Record<string, string>>];

const MICROPHONE_LINES: Record<VoiceCaptureFailure, CryptoVoiceString> = {
  denied: "Microphone access is blocked. Allow it in your browser settings, or type your message.",
  missing: "No microphone was found. Type your message instead.",
  unsupported: "Voice notes don’t work in this browser. Type your message instead.",
  failed: "Couldn’t start the microphone. Try again or type your message.",
};
const NOTE_LINES: Partial<Record<VoiceNoteFailure, Text>> = {
  connection: "Connection interrupted. Try again.",
  secret: "This looks like a wallet recovery phrase, so it wasn't sent. Don't share it with anyone.",
  silent: "Couldn’t find any words in the voice note. Try again or type your message.",
  short: "That was too short. Record a little longer.",
  limited: "Wait a moment before sending again.",
  spent: "Couldn’t turn the voice note into text. Try again.",
  busy: "Support is busy. Try again soon.",
  unavailable: "Voice notes are not available right now. Type your message instead.",
};
/** The widget's own reviewed lines for a session that cannot send. */
const SESSION_LINES: readonly CryptoChatString[] = [
  "Sign in again to keep your case.",
  "Your wallet changed. Sign in again.",
  "Your wallet changed. Try again.",
  "Wait a moment before sending again.",
  "Support is busy. Try again soon.",
  "Connection interrupted. Try again.",
  "The check couldn't load. Try again.",
  "You are banned from posting in this chat.",
  "You are muted in this chat.",
];

/** The crypto desk's voice notes: a microphone in the empty composer records a note,
 * the service turns it into text, and that text goes out as the visitor's own message
 * through the composer, with the same review, language, clock and tick as typed text.
 * The recording is discarded after transcription. `deps` replaces the browser's audio and network in a
 * simulation. Returns the refresh the menu calls after each render. */
export function mountCryptoVoiceNotes(
  host: TailHost,
  store: CryptoChatLanguageStore,
  deps: {
    build?: string;
    capture?: typeof startVoiceCapture;
    transcribe?: typeof transcribeVoiceNote;
    play?: typeof playVoiceClip;
  } = {},
) {
  const { capture = startVoiceCapture, transcribe = transcribeVoiceNote, play: playNote = playVoiceClip } = deps;
  const signal = host.lifetime!;
  const { el, draft } = host;
  const composer = draft.closest<HTMLElement>(".composer")!;
  const form = draft.closest("form")!;
  const send = composer.querySelector<HTMLButtonElement>(".send")!;
  const panel = form.closest<HTMLElement>(".panel");
  const page = draft.ownerDocument;
  const view = page.defaultView ?? window;
  const root = draft.getRootNode() as Document | ShadowRoot;
  const calm = view.matchMedia?.("(prefers-reduced-motion: reduce)");
  host.style.textContent += STYLE;

  const own = <T extends HTMLElement>(node: T) => {
    node.dataset.cryptoLanguage = "";
    return node;
  };
  const control = (className: string, path: string) => {
    const node = own(el("button", undefined, className));
    node.type = "button";
    node.append(host.icon("chat", path));
    return node;
  };
  const quiet = (node: HTMLElement) => {
    node.setAttribute("aria-hidden", "true");
    return node;
  };
  const mic = control("crypto-voice-mic", MIC);
  const lock = control("crypto-voice-lock", LOCK);
  const strip = own(el("div", undefined, "crypto-voice"));
  strip.setAttribute("role", "group");
  const discard = control("crypto-voice-discard", TRASH);
  const play = control("crypto-voice-play", PLAY);
  const dot = quiet(el("span", undefined, "crypto-voice-dot"));
  const time = el("bdi", undefined, "crypto-voice-time");
  time.setAttribute("role", "timer");
  const meter = quiet(el("span", undefined, "crypto-voice-level"));
  const bars = Array.from({ length: BARS }, () => el("i"));
  meter.append(...bars);
  const working = quiet(el("span", undefined, "crypto-voice-working"));
  working.append(el("i"), el("i"), el("i"));
  const stop = control("crypto-voice-stop", STOP);
  const sendNote = control("crypto-voice-send", SEND);
  strip.append(discard, play, dot, time, meter, working, stop, sendNote);
  const status = own(el("p", undefined, "crypto-voice-status"));
  status.setAttribute("role", "status");
  const alert = own(el("p", undefined, "crypto-voice-error"));
  alert.setAttribute("role", "alert");
  composer.append(strip, lock, mic);
  composer.before(status, alert);

  let state: State = "idle";
  /** This page fell back to the text composer. */
  let off = false;
  let holding = false;
  let pointer: { id: number; y: number } | undefined;
  /** The press on the microphone that is still down, even after it locked. */
  let pressed: number | undefined;
  let fromPointer = false;
  let pointerTimer: number | undefined;
  let recording: VoiceCapture | undefined;
  let since = 0;
  let note: VoiceClip | undefined;
  let sending: AbortController | undefined;
  /** The visitor who recorded the note. Nobody else's session sends it. */
  let owner: string | undefined;
  let notice: Line | undefined;
  let problem: Line | undefined;
  let noticeTimer: number | undefined;
  let slow = false;
  let slowTimer: number | undefined;
  let ticking: number | undefined;
  let playing: { stop(): void } | undefined;
  let playable = true;
  const levels: number[] = Array<number>(BARS).fill(0);
  let levelAt = 0;
  let digits: [string, Intl.NumberFormat] | undefined;

  const say = (text: Text, values?: Readonly<Record<string, string>>) =>
    fillTokens(store.state.strings.get(text) ?? text, values);
  const write = (node: HTMLElement, text: string) => {
    if (node.textContent !== text) node.textContent = text;
  };
  const name = (node: HTMLElement, text: Text, hint: Text = text) => {
    const [label, title] = [say(text), say(hint)];
    if (node.getAttribute("aria-label") !== label) node.setAttribute("aria-label", label);
    if (node.title !== title) node.title = title;
  };
  const glyph = (node: HTMLElement, path: string) => node.querySelector("path")?.setAttribute("d", path);
  function clock(frames: number) {
    const { code } = store.state.shown;
    if (digits?.[0] !== code) digits = [code, new Intl.NumberFormat(code, { minimumIntegerDigits: 2, useGrouping: false })];
    const seconds = Math.floor(frames / VOICE_RATE);
    return `${digits[1].format(Math.floor(seconds / 60))}:${digits[1].format(seconds % 60)}`;
  }
  const longest = (): Line => ["Voice notes can be up to {duration}.", {
    duration: new Intl.NumberFormat(store.state.shown.code, { style: "unit", unit: "minute", unitDisplay: "long" })
      .format(VOICE_MAX_FRAMES / VOICE_RATE / 60),
  }];
  const live = () => state === "holding" || state === "locked";
  const silent = () => !!recording && Date.now() - since > 3000 && recording.peak() < QUIET;

  function line(): Line | undefined {
    if (state === "starting") return ["Waiting for the microphone…"];
    if (live()) return [silent() ? "No sound yet. Check your microphone."
      : state === "holding" ? "Recording. Release to send, or slide up to lock." : "Recording. Send when you finish."];
    if (state === "review") return notice ?? ["Listen, then send. Your voice note is sent as text."];
    if (state === "uploading") return ["Uploading voice note…"];
    if (state === "transcribing")
      return [slow ? "Still working. Longer voice notes take more time." : "Turning your voice note into text…"];
    return state === "idle" ? notice : undefined;
  }

  function paint() {
    if (signal.aborted) return;
    const on = !off && cryptoVoiceNotesOn(host);
    if (!on && state !== "idle") reset();
    // A composer that went away takes the microphone with it; the note waits for review.
    if (form.hidden && live()) void finish(false);
    const active = state !== "idle";
    const shown = on && !form.hidden && (active || (!draft.value && !send.disabled));
    if (shown) composer.dataset.cryptoVoice = state;
    else delete composer.dataset.cryptoVoice;
    mic.hidden = !shown || !(state === "idle" || state === "starting" || state === "holding");
    if (state === "holding" || (state === "starting" && holding)) mic.setAttribute("aria-pressed", "true");
    else mic.removeAttribute("aria-pressed");
    lock.hidden = !shown || state !== "holding";
    strip.hidden = !shown || !active;
    const listed = live() || state === "review";
    play.hidden = state !== "review" || !playable;
    dot.hidden = meter.hidden = !live();
    time.hidden = !listed;
    working.hidden = listed;
    stop.hidden = state !== "locked";
    sendNote.hidden = state !== "locked" && state !== "review";
    meter.toggleAttribute("data-calm", calm?.matches === true);
    write(time, live() ? clock(recording?.frames() ?? 0) : note ? clock(note.frames) : "");
    if (strip.getAttribute("aria-label") !== say("Voice note")) strip.setAttribute("aria-label", say("Voice note"));
    name(mic, "Record a voice note", "Hold to record and release to send. Tap once to record without holding.");
    name(lock, "Lock recording");
    name(stop, "Stop recording");
    name(sendNote, "Send voice note");
    name(discard, state === "review" ? "Discard" : "Cancel");
    glyph(discard, listed ? TRASH : CLOSE);
    name(play, playing ? "Stop playing" : "Play voice note");
    const shownLine = line();
    write(status, shownLine ? say(...shownLine) : "");
    write(alert, problem ? say(...problem) : "");
  }

  function set(next: State) {
    const active = root.activeElement;
    const focused = !!active && (active === mic || active === lock || strip.contains(active));
    state = next;
    view.clearInterval(ticking);
    view.clearTimeout(slowTimer);
    slow = false;
    if (live()) ticking = view.setInterval(paint, 250);
    if (next === "transcribing")
      slowTimer = view.setTimeout(() => {
        slow = true;
        paint();
      }, 15_000);
    paint();
    if (!focused) return;
    // A keyboard or screen-reader visitor stays on the control that acts next.
    const target = next === "locked" || next === "review" ? sendNote
      : next === "starting" || next === "holding" ? mic
        : next === "idle" ? (mic.hidden ? draft : mic) : discard;
    if (root.activeElement !== target) target.focus({ preventScroll: true });
  }

  function drop() {
    const tracked = pointer;
    pointer = undefined;
    if (tracked)
      try {
        mic.releasePointerCapture(tracked.id);
      } catch { /* The press already ended. */ }
  }
  function silence() {
    const current = playing;
    playing = undefined;
    current?.stop();
  }
  function discardAudio() {
    if (!note) return;
    for (const chunk of note.chunks) chunk.fill(0);
    note = undefined;
  }
  function reset() {
    recording?.cancel();
    recording = undefined;
    drop();
    const abort = sending;
    sending = undefined;
    abort?.abort();
    silence();
    discardAudio();
    notice = undefined;
    view.clearInterval(ticking);
    view.clearTimeout(slowTimer);
    state = "idle";
  }

  function level(peak: number) {
    // -54 dBFS and quieter draws nothing; full scale fills the bar.
    const value = Math.max(0, Math.min(1, 1 + Math.log10(Math.max(peak, 1e-3)) / 2.7));
    if (calm?.matches) {
      // Reduced motion: three steady steps, changed at most twice a second.
      const now = Date.now();
      if (now - levelAt < 500) return;
      levelAt = now;
      const step = Math.round(value * 3);
      bars.forEach((bar, index) => bar.style.setProperty("--v", index < step ? "1" : "0"));
      return;
    }
    levels.push(value);
    levels.shift();
    bars.forEach((bar, index) => bar.style.setProperty("--v", levels[index].toFixed(2)));
  }

  function begin(hold: boolean) {
    if (state !== "idle" || composer.dataset.cryptoVoice !== "idle") return;
    silence();
    view.clearTimeout(noticeTimer);
    notice = problem = undefined;
    owner = host.client.session?.principalId;
    holding = hold;
    levels.fill(0);
    for (const bar of bars) bar.style.removeProperty("--v");
    let started: VoiceCapture;
    try {
      started = capture({
        level,
        limit: () => void finish(false, longest()),
        ended: () => void finish(false),
      });
    } catch {
      off = true;
      problem = [MICROPHONE_LINES.unsupported];
      return set("idle");
    }
    recording = started;
    set("starting");
    started.started.then(() => {
      if (recording !== started) return;
      since = Date.now();
      set(holding ? "holding" : "locked");
    }, (reason: { voice?: VoiceCaptureFailure } | null) => {
      if (recording !== started) return;
      recording = undefined;
      drop();
      const kind = reason?.voice ?? "failed";
      if (kind === "unsupported") off = true;
      problem = [MICROPHONE_LINES[kind]];
      set("idle");
    });
  }

  function lockNow() {
    if (state === "starting") holding = false;
    else if (state === "holding") {
      drop();
      set("locked");
    }
  }

  async function finish(sendNow: boolean, reason?: Line) {
    const stopping = recording;
    if (!stopping || !live()) return;
    recording = undefined;
    drop();
    set("stopping");
    const clip = await stopping.stop();
    if (state !== "stopping" || signal.aborted) return;
    if (clip.frames < VOICE_MIN_FRAMES) {
      problem = ["That was too short. Record a little longer."];
      return set("idle");
    }
    note = clip;
    if (clip.peak < QUIET) {
      problem = ["Couldn’t hear anything. Check your microphone and try again."];
      return set("review");
    }
    if (sendNow) return upload();
    notice = reason;
    set("review");
  }

  async function upload() {
    if (!note || (state !== "review" && state !== "stopping")) return;
    silence();
    notice = problem = undefined;
    const abort = sending = new AbortController();
    set("uploading");
    try {
      const wav = encodeVoiceWav(note);
      discardAudio();
      const text = await transcribe(host, wav, widgetMessageId(), {
        build: deps.build,
        signal: abort.signal,
        uploaded() {
          if (sending === abort && state === "uploading") set("transcribing");
        },
      });
      if (sending !== abort) return;
      sending = undefined;
      const visitor = host.client.session?.principalId;
      if (!visitor || (owner && owner !== visitor)) {
        problem = ["Sign in again to keep your case."];
        return set("idle");
      }
      if (!text) {
        problem = ["Couldn’t find any words in the voice note. Try again or type your message."];
        return set("idle");
      }
      set("idle");
      deliver(text);
    } catch (reason) {
      if (sending !== abort) return;
      sending = undefined;
      const { voice = "failed", cause } = (reason ?? {}) as { voice?: VoiceNoteFailure; cause?: unknown };
      if (voice === "unavailable") off = true;
      discardAudio();
      const known = host.errorText(cause);
      problem = voice === "session"
        ? [SESSION_LINES.find(text => text === known) ?? "Support is unavailable. Try again."]
        : voice === "too-long" ? ["Record a shorter voice note."]
          : [NOTE_LINES[voice] ?? "Couldn’t turn the voice note into text. Try again."];
      set("idle");
    }
  }

  /** The transcript becomes the visitor's message through the composer's own send. An
   * occupied composer keeps its draft and takes the text for the visitor to check. */
  function deliver(text: string) {
    const free = !draft.value.trim() && !send.disabled && !form.hidden;
    const fits = text.length <= (draft.maxLength > 0 ? draft.maxLength : 2000);
    draft.value = draft.value.trim() ? `${draft.value}\n${text}` : text;
    draft.dispatchEvent(new Event("input", { bubbles: true }));
    if (free && fits) {
      form.requestSubmit(send);
    } else {
      notice = [fits ? "Your voice note is in the message box. Check it, then send."
        : "This voice note is too long for one message. Shorten it, then send."];
      draft.focus();
    }
    paint();
  }

  function cancel() {
    if (state === "idle") return;
    view.clearTimeout(noticeTimer);
    if (state === "uploading" || state === "transcribing") {
      const abort = sending;
      sending = undefined;
      abort?.abort();
    }
    recording?.cancel();
    recording = undefined;
    drop();
    silence();
    discardAudio();
    problem = undefined;
    const said: Line = live() || state === "starting" ? ["Stopped. Your voice note was not sent."] : ["Voice note discarded."];
    notice = said;
    noticeTimer = view.setTimeout(() => {
      if (notice !== said) return;
      notice = undefined;
      paint();
    }, 4000);
    set("idle");
  }

  function listen() {
    if (state !== "review" || !note) return;
    if (playing) {
      silence();
    } else {
      try {
        const entry = { stop() {} };
        entry.stop = playNote(note, () => {
          if (playing === entry) playing = undefined;
          glyph(play, PLAY);
          paint();
        });
        playing = entry;
        glyph(play, STOP);
      } catch {
        playable = false;
      }
    }
    paint();
  }

  mic.addEventListener("pointerdown", event => {
    if (event.button || !event.isPrimary || state !== "idle") return;
    fromPointer = true;
    pressed = event.pointerId;
    view.clearTimeout(pointerTimer);
    pointer = { id: event.pointerId, y: event.clientY };
    try {
      mic.setPointerCapture(event.pointerId);
    } catch { /* The window still reports the release. */ }
    begin(true);
    if (state === "idle") drop();
  }, { signal });
  const released = (event: PointerEvent) => {
    if (pressed !== event.pointerId) return;
    pressed = undefined;
    // The click that follows a press starts nothing of its own. A press the system took
    // away has no click.
    if (event.type === "pointerup")
      pointerTimer = view.setTimeout(() => {
        fromPointer = false;
      }, 700);
    else fromPointer = false;
    if (pointer?.id !== event.pointerId) return;
    drop();
    if (state === "starting") holding = false;
    else if (state !== "holding") return;
    // A press the system took away never sends; the note waits for review.
    else if (event.type !== "pointerup") void finish(false);
    else if ((recording?.frames() ?? 0) >= HOLD_FRAMES) void finish(true);
    else set("locked");
  };
  view.addEventListener("pointerup", released, { signal });
  view.addEventListener("pointercancel", released, { signal });
  view.addEventListener("pointermove", event => {
    if (pointer?.id === event.pointerId && pointer.y - event.clientY >= LOCK_SLIDE) lockNow();
  }, { signal });
  mic.addEventListener("contextmenu", event => event.preventDefault(), { signal });
  mic.addEventListener("click", () => {
    if (fromPointer) fromPointer = false;
    else begin(false);
  }, { signal });
  lock.addEventListener("click", lockNow, { signal });
  stop.addEventListener("click", () => void finish(false), { signal });
  sendNote.addEventListener("click", () => void (state === "locked" ? finish(true) : upload()), { signal });
  discard.addEventListener("click", cancel, { signal });
  play.addEventListener("click", listen, { signal });
  // A held Enter starts one recording; it never reaches the next control as a second press.
  composer.addEventListener("keydown", event => {
    if (event.repeat && (event.key === "Enter" || event.key === " ") &&
      (event.target as Element).closest("[data-crypto-language]")) event.preventDefault();
  }, { signal });
  page.addEventListener("keydown", event => {
    if (event.key !== "Escape" || event.defaultPrevented || state === "idle") return;
    const path = event.composedPath();
    if (panel && !path.includes(panel) && path[0] !== page.body && path[0] !== page.documentElement) return;
    event.preventDefault();
    event.stopPropagation();
    cancel();
  }, { capture: true, signal });
  page.addEventListener("visibilitychange", () => {
    if (!page.hidden) return;
    if (state === "starting") cancel();
    else void finish(false);
  }, { signal });
  view.addEventListener("pagehide", () => {
    reset();
    paint();
  }, { signal });
  draft.addEventListener("input", () => {
    if (state === "idle") notice = problem = undefined;
    paint();
  }, { signal });
  const watched = new MutationObserver(paint);
  watched.observe(send, { attributes: true, attributeFilter: ["disabled"] });
  watched.observe(form, { attributes: true, attributeFilter: ["hidden"] });
  const offLanguage = store.subscribe(paint);
  const offSession = host.client.onSessionChange(() => {
    const visitor = host.client.session?.principalId;
    if (owner && visitor !== owner) {
      reset();
      problem = undefined;
    }
    owner = visitor;
    paint();
  });
  signal.addEventListener("abort", () => {
    reset();
    view.clearTimeout(noticeTimer);
    view.clearTimeout(pointerTimer);
    watched.disconnect();
    offLanguage();
    offSession();
  }, { once: true });
  paint();
  return { refresh: paint };
}
