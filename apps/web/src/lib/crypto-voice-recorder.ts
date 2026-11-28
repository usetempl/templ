/** Records a voice note on the hosted crypto chat as mono 16 kHz 16-bit PCM. The
 * browser's own audio graph feeds a first-party worklet (public/voice), so no recorder
 * codec is assumed. Nothing here runs before the visitor presses the microphone, and
 * the page never holds more than the longest note. */

export const VOICE_RATE = 16_000;
export const VOICE_MIN_FRAMES = 6_400;
export const VOICE_MAX_FRAMES = VOICE_RATE * 120;
const WORKLET = "/voice/pcm-recorder-v1.js";

export type VoiceClip = {
  readonly chunks: readonly Int16Array[];
  readonly frames: number;
  readonly peak: number;
};
export type VoiceCaptureFailure = "denied" | "missing" | "unsupported" | "failed";
type VoiceCaptureEvents = {
  level(peak: number): void;
  /** The note reached its longest length. */
  limit(): void;
  /** The browser or the device ended the microphone. */
  ended(): void;
};
export type VoiceCapture = {
  readonly started: Promise<void>;
  frames(): number;
  peak(): number;
  stop(): Promise<VoiceClip>;
  cancel(): void;
};

const failure = (voice: VoiceCaptureFailure) => Object.assign(new Error(`voice-${voice}`), { voice });
function refusal(reason: unknown): VoiceCaptureFailure {
  const name = (reason as { name?: string } | null)?.name;
  return name === "NotAllowedError" || name === "SecurityError" ? "denied"
    : name === "NotFoundError" || name === "OverconstrainedError" ? "missing" : "failed";
}

/** Call it inside the visitor's press: Safari lets an audio context run only then. */
export function startVoiceCapture(events: VoiceCaptureEvents): VoiceCapture {
  const context = new AudioContext({ latencyHint: "interactive" });
  const wake = () => {
    if (context.state === "suspended") void context.resume().catch(() => {});
  };
  wake();
  // A touch gives the page its activation only when the finger lifts; try again then.
  const gestures = new AbortController();
  for (const type of ["pointerup", "keyup"])
    document.addEventListener(type, wake, { capture: true, signal: gestures.signal });
  const chunks: Int16Array[] = [];
  let frames = 0;
  let peak = 0;
  let stream: MediaStream | undefined;
  let node: AudioWorkletNode | undefined;
  let released = false;
  let flushed: (() => void) | undefined;
  const silence = () => {
    for (const track of stream?.getTracks() ?? []) track.stop();
  };
  const close = () => {
    if (released) return;
    released = true;
    gestures.abort();
    silence();
    if (node) node.port.onmessage = null;
    void context.close().catch(() => {});
  };
  const microphone = navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false,
  });
  // A microphone that opens after a cancel is released at once.
  void microphone.then(opened => {
    stream = opened;
    if (released) silence();
  }, () => {});
  const started = (async () => {
    try {
      await context.audioWorklet.addModule(WORKLET);
    } catch {
      close();
      throw failure("unsupported");
    }
    let opened: MediaStream;
    try {
      opened = await microphone;
    } catch (reason) {
      close();
      throw failure(refusal(reason));
    }
    if (released) throw failure("failed");
    try {
      const recorder = node = new AudioWorkletNode(context, "templ-voice-recorder", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: "explicit",
        channelInterpretation: "speakers",
        processorOptions: { maxFrames: VOICE_MAX_FRAMES },
      });
      recorder.port.onmessage = ({ data }: MessageEvent<{ pcm?: ArrayBuffer; peak?: number; done?: boolean }>) => {
        if (data.done) return flushed?.();
        if (!data.pcm || frames >= VOICE_MAX_FRAMES) return;
        const block = new Int16Array(data.pcm).subarray(0, VOICE_MAX_FRAMES - frames);
        chunks.push(block);
        frames += block.length;
        const loudest = Math.min(1, Number(data.peak) || 0);
        peak = Math.max(peak, loudest);
        events.level(loudest);
        if (frames >= VOICE_MAX_FRAMES) events.limit();
      };
      // Browsers render a node only on a path to the output; this one stays silent.
      const mute = context.createGain();
      mute.gain.value = 0;
      context.createMediaStreamSource(opened).connect(recorder).connect(mute).connect(context.destination);
      wake();
    } catch {
      close();
      throw failure("unsupported");
    }
    for (const track of opened.getAudioTracks())
      track.addEventListener("ended", () => {
        if (!released) events.ended();
      }, { once: true });
  })();
  return {
    started,
    frames: () => frames,
    peak: () => peak,
    async stop() {
      // The microphone goes quiet before the filter's last block is read.
      silence();
      const recorder = node;
      if (recorder && !released)
        await new Promise<void>(resolve => {
          flushed = resolve;
          recorder.port.postMessage("stop");
          setTimeout(resolve, 500);
        });
      close();
      return { chunks, frames, peak };
    },
    cancel() {
      close();
      chunks.length = 0;
      frames = 0;
    },
  };
}

export function encodeVoiceWav({ chunks, frames }: VoiceClip) {
  const bytes = frames * 2;
  const header = new DataView(new ArrayBuffer(44));
  const ascii = (at: number, text: string) => {
    for (let index = 0; index < text.length; index++) header.setUint8(at + index, text.charCodeAt(index));
  };
  ascii(0, "RIFF");
  header.setUint32(4, 36 + bytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true);
  header.setUint16(22, 1, true);
  header.setUint32(24, VOICE_RATE, true);
  header.setUint32(28, VOICE_RATE * 2, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  ascii(36, "data");
  header.setUint32(40, bytes, true);
  const pcm = new DataView(new ArrayBuffer(bytes));
  let at = 0;
  for (const chunk of chunks)
    for (let index = 0; index < chunk.length && at < bytes; index++, at += 2) pcm.setInt16(at, chunk[index], true);
  return new Blob([header.buffer, pcm.buffer], { type: "audio/wav" });
}

/** Plays a note through the audio graph, which needs no media address. Call it inside
 * a click. Returns the stop; `ended` runs once, when the note ends or stops. */
export function playVoiceClip({ chunks, frames }: VoiceClip, ended: () => void) {
  const context = new AudioContext();
  let over = false;
  const release = () => void context.close().catch(() => {});
  const finish = () => {
    if (over) return;
    over = true;
    release();
    ended();
  };
  try {
    const buffer = context.createBuffer(1, frames, VOICE_RATE);
    const samples = buffer.getChannelData(0);
    let at = 0;
    for (const chunk of chunks)
      for (let index = 0; index < chunk.length && at < frames; index++) samples[at++] = chunk[index] / 32768;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.addEventListener("ended", finish, { once: true });
    source.start();
    void context.resume().catch(() => {});
  } catch (reason) {
    release();
    throw reason;
  }
  return finish;
}
