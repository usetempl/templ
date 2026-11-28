import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath, URL as FileURL } from "node:url";
import { simulate, type Rng } from "@templ/chat/simulation.test.helpers";
import { CRYPTO_SUPPORT_WORKSPACE } from "@templ/chat/support-models";
import { afterEach, expect, vi } from "vitest";
import { createCryptoChatLanguage } from "./crypto-chat-language";
import { CRYPTO_CHAT_STRINGS } from "./crypto-chat-strings";
import { cryptoVoiceNotesOn } from "./crypto-voice-loader";
import { mountCryptoVoiceNotes } from "./crypto-voice-notes";
import { VOICE_RATE, encodeVoiceWav, type VoiceCaptureFailure, type startVoiceCapture } from "./crypto-voice-recorder";
import { CRYPTO_VOICE_STRINGS } from "./crypto-voice-strings";
import { transcribeVoiceNote, type VoiceSend } from "./crypto-voice-transcribe";
import type { TailHost } from "./support-widget";

// This portable source has no production workspace identity. Exercise an isolated desk.
vi.mock("@templ/chat/support-models", async (original) => ({
  ...await original<typeof import("@templ/chat/support-models")>(),
  CRYPTO_SUPPORT_WORKSPACE: "01990000-0000-7000-8000-000000000003",
}));


const API = "https://community.usetempl.com";
const BASE = `${API}/widget/${CRYPTO_SUPPORT_WORKSPACE}`;
const NEIGHBOR = "01990000-0000-7000-8000-00000000000c";
const BUILD = "0123456789abcdef";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const WORKLET = readFileSync(
  fileURLToPath(new FileURL("../../public/voice/pcm-recorder-v1.js", import.meta.url)), "utf8");
/** Every fixed line voice notes may show, before a locale bundle translates it. */
const LINES = new Set<string>([...CRYPTO_VOICE_STRINGS, ...CRYPTO_CHAT_STRINGS]);
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

type Posted = { pcm?: ArrayBuffer; peak?: number; limit?: boolean; done?: boolean; frames?: number };
type Processor = {
  port: { onmessage: ((event: { data: unknown }) => void) | null };
  process(inputs: Float32Array[][]): boolean;
};
/** The published recorder, run outside a browser at one device rate. */
function recorder(rate: number, maxFrames?: number) {
  const posted: Posted[] = [];
  let registered: (new (options: object) => Processor) | undefined;
  class AudioWorkletProcessor {
    port = { postMessage: (message: Posted) => void posted.push(message), onmessage: null };
  }
  new Function("AudioWorkletProcessor", "registerProcessor", "sampleRate", WORKLET)(
    AudioWorkletProcessor,
    (_name: string, processor: new (options: object) => Processor) => {
      registered = processor;
    },
    rate,
  );
  return { posted, node: new registered!({ processorOptions: { maxFrames } }) };
}
/** Records a tone from a device with one or two channels and returns the note. */
function record(draw: Rng, rate: number, seconds: number, hertz: number, amplitude: number, maxFrames?: number) {
  const { posted, node } = recorder(rate, maxFrames);
  const stereo = draw.chance(0.5);
  const blocks = Math.ceil((seconds * rate) / 128);
  for (let block = 0; block < blocks; block++) {
    const left = new Float32Array(128);
    const right = new Float32Array(128);
    for (let index = 0; index < 128; index++) {
      const tone = amplitude * Math.sin((2 * Math.PI * hertz * (block * 128 + index)) / rate);
      // Two channels that differ still average to the tone.
      const apart = stereo ? (draw.next() - 0.5) * 0.2 : 0;
      left[index] = tone + apart;
      right[index] = tone - apart;
    }
    expect(node.process([stereo ? [left, right] : [left]])).toBe(true);
  }
  node.port.onmessage!({ data: "stop" });
  expect(node.process([[new Float32Array(128)]])).toBe(false);
  const chunks = posted.flatMap(message => message.pcm ? [new Int16Array(message.pcm)] : []);
  const samples = Int16Array.from(chunks.flatMap(chunk => [...chunk]));
  return { posted, chunks, samples, inputFrames: blocks * 128 };
}
/** How strongly one frequency shows in the middle of a note, in sample units. */
function strength(samples: Int16Array, hertz: number) {
  let [cosine, sine, count] = [0, 0, 0];
  for (let index = 1_600; index < samples.length - 1_600; index++, count++) {
    const angle = (2 * Math.PI * hertz * index) / VOICE_RATE;
    cosine += samples[index] * Math.cos(angle);
    sine += samples[index] * Math.sin(angle);
  }
  return (2 * Math.hypot(cosine, sine)) / count;
}

simulate("any microphone rate becomes one exact 16 kHz mono WAV file", async draw => {
  const rate = draw.pick([8_000, 22_050, 32_000, 44_100, 44_101, 48_000, 96_000]);
  const seconds = draw.int(6, 15) / 10;
  const hertz = draw.int(200, 3_000);
  const amplitude = draw.int(10, 80) / 100;
  const note = record(draw, rate, seconds, hertz, amplitude);
  const frames = note.samples.length;
  // The note lasts as long as the visitor spoke, to the sample.
  expect(frames).toBe(Math.ceil((note.inputFrames * VOICE_RATE) / rate));
  expect(note.posted.at(-1)).toEqual({ done: true, frames });
  expect(note.posted.some(message => message.limit)).toBe(false);
  // Speech frequencies keep their level.
  expect(Math.abs(strength(note.samples, hertz) / 32_767 - amplitude)).toBeLessThan(0.01);
  // The level the meter reads follows the loudest sample; the abrupt end of the tone may ring a little over it.
  const peak = Math.max(...note.posted.map(message => message.peak ?? 0));
  expect(peak).toBeGreaterThan(amplitude * 0.9);
  expect(peak).toBeLessThan(amplitude * 1.15 + 0.01);

  // Sound above what 16 kHz can carry is removed, never folded into the note.
  const top = Math.min(15_000, rate / 2 - 1_000);
  if (top >= 9_500) {
    const high = record(draw, rate, 0.6, draw.int(9_500, top), 0.8).samples;
    const middle = high.subarray(1_600, high.length - 1_600);
    expect(Math.sqrt(middle.reduce((sum, sample) => sum + sample * sample, 0) / middle.length)).toBeLessThan(33);
  }

  const wav = encodeVoiceWav({ chunks: note.chunks, frames, peak });
  expect(wav.type).toBe("audio/wav");
  expect(wav.size).toBe(44 + frames * 2);
  const file = new DataView(await wav.arrayBuffer());
  const ascii = (at: number) => String.fromCharCode(...[0, 1, 2, 3].map(index => file.getUint8(at + index)));
  expect([ascii(0), ascii(8), ascii(12), ascii(36)]).toEqual(["RIFF", "WAVE", "fmt ", "data"]);
  expect([file.getUint32(4, true), file.getUint32(16, true), file.getUint32(40, true)]).toEqual([36 + frames * 2, 16, frames * 2]);
  // PCM, one channel, 16,000 samples a second, 32,000 bytes a second, 2-byte frames, 16 bits.
  expect([file.getUint16(20, true), file.getUint16(22, true), file.getUint32(24, true), file.getUint32(28, true),
    file.getUint16(32, true), file.getUint16(34, true)]).toEqual([1, 1, 16_000, 32_000, 2, 16]);
  for (let check = 0; check < 20; check++) {
    const index = draw.int(0, frames - 1);
    expect(file.getInt16(44 + index * 2, true)).toBe(note.samples[index]);
  }

  // The recorder itself stops at the longest note.
  const limit = draw.int(2_000, 6_000);
  const capped = record(draw, rate, 0.6, hertz, amplitude, limit);
  expect(capped.samples.length).toBe(limit);
  expect(capped.posted.filter(message => message.limit).length).toBe(1);
  expect(capped.posted.at(-1)).toEqual({ done: true, frames: limit });
}, { runs: 7 });

function make<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
/** The hosted crypto chat's composer as the widget draws it. */
function chat(policy: object) {
  const widget = make("div");
  document.body.append(widget);
  const root = widget.attachShadow({ mode: "open" });
  const panel = make("section", "panel conversation-chat");
  const body = make("div", "body");
  body.append(make("div", "messages"));
  const form = make("form", "form");
  const composer = make("div", "composer");
  const draft = make("textarea");
  const send = make("button", "send");
  send.type = "submit";
  composer.append(draft, send);
  form.append(composer);
  panel.append(body, form);
  const style = make("style");
  root.append(style, panel);
  const submitted: string[] = [];
  form.addEventListener("submit", event => {
    event.preventDefault();
    submitted.push(draft.value);
  });
  const lifetime = new AbortController();
  const memberChanges = new Set<() => void>();
  const widgetHost = {
    el: (tag: keyof HTMLElementTagNameMap, text?: string, className?: string) => make(tag, className, text),
    icon: () => {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.append(document.createElementNS("http://www.w3.org/2000/svg", "path"));
      return svg;
    },
    style,
    draft,
    lifetime: lifetime.signal,
    options: { workspace: CRYPTO_SUPPORT_WORKSPACE, container: widget },
    policy,
    client: {
      session: { principalId: "visitor", address: "", expiresAt: Number.MAX_SAFE_INTEGER },
      onSessionChange(fn: () => void) {
        memberChanges.add(fn);
        return () => memberChanges.delete(fn);
      },
    },
    errorText: () => "Support is unavailable. Try again.",
  };
  const find = (name: string) => root.querySelector<HTMLButtonElement>(`.crypto-voice-${name}`)!;
  return {
    host: widgetHost as unknown as TailHost, lifetime, draft, submitted, find,
    switchMember() {
      widgetHost.client.session.principalId += "-next";
      for (const update of memberChanges) update();
    },
    answer(next: object) {
      widgetHost.policy = next;
    },
    store: createCryptoChatLanguage(CRYPTO_SUPPORT_WORKSPACE, API, async () => new Response("{}", { status: 404 })),
    state: () => composer.dataset.cryptoVoice,
    lines: () => [...root.querySelectorAll(".crypto-voice-status,.crypto-voice-error")].map(node => node.textContent ?? ""),
    labels: () => [...root.querySelectorAll("[aria-label]")].map(node => node.getAttribute("aria-label")!),
  };
}
type Microphone = {
  frames: number;
  peak: number;
  released: boolean;
  samples?: Int16Array;
  start(): void;
  fail(voice: VoiceCaptureFailure): void;
};
/** A microphone the scenario opens, fills and refuses by hand. */
function microphones() {
  const opened: Microphone[] = [];
  const capture: typeof startVoiceCapture = () => {
    let start!: () => void;
    let refuse!: (reason: unknown) => void;
    const started = new Promise<void>((resolve, reject) => {
      start = resolve;
      refuse = reject;
    });
    const entry: Microphone = {
      frames: 0, peak: 0, released: false, start,
      // A recorder that cannot start releases what it opened.
      fail(voice) {
        entry.released = true;
        refuse(Object.assign(new Error(voice), { voice }));
      },
    };
    opened.push(entry);
    return {
      started,
      frames: () => entry.frames,
      peak: () => entry.peak,
      async stop() {
        entry.released = true;
        entry.samples = new Int16Array(entry.frames).fill(123);
        return { chunks: [entry.samples], frames: entry.frames, peak: entry.peak };
      },
      cancel() {
        entry.released = true;
      },
    };
  };
  return { opened, capture };
}
type Asked = {
  id: string;
  size: number;
  aborted(): boolean;
  uploaded(): void;
  answer(text: string): void;
  refuse(reason: unknown): void;
};
/** A transcription service that answers when the scenario says so. */
function transcription() {
  const requests: Asked[] = [];
  const transcribe: typeof transcribeVoiceNote = (_host, wav, id, { signal, uploaded }) =>
    new Promise<string>((answer, refuse) => {
      requests.push({ id, size: wav.size, aborted: () => signal.aborted, uploaded, answer, refuse });
    });
  return { requests, transcribe };
}

simulate("a voice note reaches the case only as text sent through the composer", async draw => {
  const review = JSON.parse(readFileSync(new FileURL("../../test/fixtures/crypto-privacy-source-review.json", import.meta.url), "utf8"));
  const page = readFileSync(new FileURL("../app/privacy/page.tsx", import.meta.url));
  expect(createHash("sha256").update(page).digest("hex")).toBe(review.portablePageSha256);
  const [lookups, language, recording] = review.approvals;
  expect(lookups.reviewedAfterSha256).toBe(language.reviewedBeforeSha256);
  expect(language.reviewedAfterSha256).toBe(recording.reviewedBeforeSha256);
  expect(recording.reviewedAfterSha256).toBe(review.portablePageSha256);
  // No neighbor, embed or unset flag gets voice notes.
  for (let row = 0; row < 8; row++) {
    const workspace = draw.pick([CRYPTO_SUPPORT_WORKSPACE, NEIGHBOR]);
    const flag = draw.pick([true, true, false, "true", 1, undefined]);
    const hosted = draw.chance(0.7);
    const container = draw.chance(0.8) ? document.body : undefined;
    expect(cryptoVoiceNotesOn({ options: { workspace, container }, policy: { hosted, cryptoVoiceNotes: flag } } as never))
      .toBe(workspace === CRYPTO_SUPPORT_WORKSPACE && flag === true && hosted && !!container);
  }

  const desk = chat({ hosted: true });
  const audio = microphones();
  const service = transcription();
  const voice = mountCryptoVoiceNotes(desk.host, desk.store, {
    build: BUILD, capture: audio.capture, transcribe: service.transcribe, play: () => () => {},
  });
  const mic = desk.find("mic");
  const pointer = (type: string, y: number) =>
    new PointerEvent(type, { pointerId: 7, isPrimary: true, button: 0, clientY: y, bubbles: true, composed: true });
  /** The finger lifts; the browser's click follows. */
  const lift = () => {
    window.dispatchEvent(pointer("pointerup", 500));
    mic.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  };
  const escape = () =>
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  const check = () => {
    for (const text of [...desk.lines(), ...desk.labels()]) if (text) expect(LINES.has(text), text).toBe(true);
  };
  /** Where a stopped recording goes: too short is dropped, a silent one never sends itself. */
  const stopped = (entry: Microphone, send: boolean) =>
    entry.frames < 6_400 ? "idle" : entry.peak < 0.005 || !send ? "review" : "uploading";

  voice.refresh();
  expect(desk.state()).toBeUndefined();
  expect(mic.hidden).toBe(true);
  mic.click();
  expect(audio.opened.length).toBe(0);
  desk.answer({ hosted: true, cryptoVoiceNotes: true });
  voice.refresh();
  expect(desk.state()).toBe("idle");
  // Nothing opens the microphone before the visitor presses it.
  expect(audio.opened.length).toBe(0);

  for (let round = 0; round < 6; round++) {
    const before = desk.submitted.length;
    const asked = service.requests.length;
    const hold = draw.chance(0.5);
    let down = hold;
    if (hold) mic.dispatchEvent(pointer("pointerdown", 500));
    else mic.click();
    expect(desk.state()).toBe("starting");
    const entry = audio.opened.at(-1)!;
    if (draw.chance(0.15)) {
      entry.fail(draw.pick(["denied", "missing", "failed"] as const));
      await settle();
      expect(desk.state()).toBe("idle");
      expect(desk.lines()[1]).not.toBe("");
      check();
      if (down) lift();
      expect(desk.state()).toBe("idle");
      continue;
    }
    entry.start();
    await settle();
    expect(desk.state()).toBe(hold ? "holding" : "locked");
    entry.frames = draw.pick([3_000, 7_000, 9_000, 40_000]);
    entry.peak = draw.chance(0.8) ? 0.4 : 0.001;

    for (let step = 0; step < 8; step++) {
      const state = desk.state();
      check();
      if (state === "holding") {
        const move = draw.pick(["lift", "slide", "taken", "escape"]);
        if (move === "slide") window.dispatchEvent(pointer("pointermove", 440));
        else if (move === "taken") window.dispatchEvent(pointer("pointercancel", 500));
        else if (move === "escape") escape();
        else lift();
        if (move === "lift" || move === "taken") down = false;
        await settle();
        expect(desk.state()).toBe(move === "slide" ? "locked" : move === "escape" ? "idle"
          : move === "taken" ? stopped(entry, false) : entry.frames >= 8_000 ? stopped(entry, true) : "locked");
      } else if (state === "locked") {
        const move = draw.pick(["send", "stop", "cancel", "escape", "hidden"]);
        if (move === "send") desk.find("send").click();
        else if (move === "stop") desk.find("stop").click();
        else if (move === "cancel") desk.find("discard").click();
        else if (move === "escape") escape();
        else {
          Object.defineProperty(document, "hidden", { value: true, configurable: true });
          document.dispatchEvent(new Event("visibilitychange"));
          Reflect.deleteProperty(document, "hidden");
        }
        await settle();
        expect(desk.state()).toBe(move === "cancel" || move === "escape" ? "idle" : stopped(entry, move === "send"));
      } else if (state === "review") {
        const move = draw.pick(["send", "send", "discard", "escape", "listen"]);
        if (move === "send") desk.find("send").click();
        else if (move === "discard") desk.find("discard").click();
        else if (move === "escape") escape();
        else desk.find("play").click();
        await settle();
        expect(desk.state()).toBe(move === "send" ? "uploading" : move === "listen" ? "review" : "idle");
      } else break;
      // The microphone is released the moment recording ends, however it ends.
      if (desk.state() !== "holding" && desk.state() !== "locked") expect(entry.released).toBe(true);
    }
    if (down) lift();

    if (desk.state() === "uploading") {
      const request = service.requests.at(-1)!;
      expect(service.requests.length).toBe(asked + 1);
      expect(entry.released).toBe(true);
      expect(request.size).toBe(44 + entry.frames * 2);
      const text = draw.text("gm wen refund 0x ", draw.int(3, 40)).trim() || "gm";
      const end = draw.pick(["text", "editable", "busy", "too-long", "failed", "connection", "stopped", "wordless", "switched"]);
      expect(entry.samples?.some(sample => sample !== 0)).toBe(false);
      if (draw.chance(0.7)) {
        request.uploaded();
        expect(desk.state()).toBe("transcribing");
      }
      check();
      // Nothing is shown as sent while the service works.
      expect(desk.submitted.length).toBe(before);
      expect(desk.draft.value).toBe("");
      if (end === "busy" || end === "too-long" || end === "failed" || end === "connection") {
        request.refuse(Object.assign(new Error(end), { voice: end }));
      } else if (end === "switched") {
        desk.switchMember();
        expect(request.aborted()).toBe(true);
        request.answer(text);
      } else if (end === "stopped") {
        desk.find("discard").click();
        expect(desk.state()).toBe("idle");
        expect(request.aborted()).toBe(true);
        request.answer(text);
      } else {
        if (end === "editable") desk.draft.maxLength = 1;
        request.answer(end === "wordless" ? "" : end === "editable" ? "longer transcript" : text);
      }
      await settle();
      check();
      expect(entry.samples?.some(sample => sample !== 0)).toBe(false);
      expect(desk.find("play").hidden).toBe(true);
      if (end === "editable") {
        expect(desk.lines()).toContain("This voice note is too long for one message. Shorten it, then send.");
        expect(desk.submitted.length).toBe(before);
        expect(desk.draft.value).toBe("longer transcript");
        desk.draft.removeAttribute("maxlength");
      } else if (end !== "text") {
        if (end === "too-long") expect(desk.lines()).toContain("Record a shorter voice note.");
        expect(desk.state()).toBe("idle");
        expect(desk.submitted.length).toBe(before);
        expect(desk.draft.value).toBe("");
      } else {
        // The composer's own send carries the transcript, once.
        expect(desk.submitted.slice(before)).toEqual([text]);
        expect(desk.draft.value).toBe(text);
        expect(desk.state()).toBeUndefined();
      }
    } else expect(service.requests.length).toBe(asked);

    if (desk.state() === "review") escape();
    desk.draft.value = "";
    desk.draft.dispatchEvent(new Event("input", { bubbles: true }));
    voice.refresh();
    expect(desk.state()).toBe("idle");
  }

  // A press that is still recording when the chat goes away releases the microphone.
  mic.click();
  const last = audio.opened.at(-1)!;
  if (draw.chance(0.5)) {
    last.start();
    await settle();
  }
  desk.lifetime.abort();
  for (const entry of audio.opened) expect(entry.released).toBe(true);
  for (const request of service.requests) expect(request.id).toMatch(UUID);
});

simulate("a note goes to this workspace's transcription with the visitor's own session and nothing else", async draw => {
  const token = draw.text("0123456789abcdef", 64);
  const id = "019ab3c0-0000-7000-8000-000000000001";
  const wav = new Blob([new Uint8Array(draw.int(44, 400))], { type: "audio/wav" });
  const returning = draw.chance(0.5);
  const checks: string[] = [];
  let guests = 0;
  let session = returning ? { principalId: "visitor" } : undefined;
  const client = {
    get session() {
      return session;
    },
    async guest() {
      guests++;
      session = { principalId: "visitor" };
    },
    adopt: () => [session && { token }, async (path: string) => void checks.push(path), undefined, BASE] as const,
  };
  // Each row is the service's answers in order; "page" is a proxy's HTML with a 200.
  const [statuses, failure] = draw.pick<[readonly (number | "page")[], string?]>([
    [[200]], [[401, 200]], [[401, 401], "session"], [[413], "too-long"], [[429], "busy"], [[503], "busy"],
    [[404], "unavailable"], [[403], "unavailable"], [[500], "failed"], [["page"], "failed"],
  ]);
  const sent: Parameters<VoiceSend>[0][] = [];
  const send: VoiceSend = async request => {
    const status = statuses[sent.length];
    sent.push(request);
    request.uploaded();
    return status === "page" ? { status: 200, body: "<html>" }
      : { status, body: JSON.stringify(status === 200 ? { text: "  gm, wen refund  " } : { error: "No." }) };
  };
  let uploads = 0;
  const run = transcribeVoiceNote({ client } as unknown as TailHost, wav, id, {
    build: BUILD, signal: new AbortController().signal, uploaded: () => void uploads++, send,
  });
  if (failure) await expect(run).rejects.toMatchObject({ voice: failure });
  else await expect(run).resolves.toBe("gm, wen refund");
  const requests = statuses.length;
  expect(sent.length).toBe(requests);
  expect(uploads).toBe(requests);
  // A first-time visitor gets a session as a first typed message would; a returning one is checked first.
  expect(guests).toBe(returning ? 0 : 1);
  expect(checks).toEqual(Array<string>(requests - (returning ? 0 : 1)).fill("/conversations/status"));
  for (const request of sent) {
    expect(request.url).toBe(`${BASE}/voice/transcribe?clientId=${id}`);
    expect(request.headers).toEqual({ Authorization: `Bearer ${token}`, "Content-Type": "audio/wav", "X-Templ-Widget": BUILD });
    expect(request.body).toBe(wav);
  }
});
