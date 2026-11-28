/* Templ voice notes: the recorder behind the microphone button on the hosted crypto chat.
 * The page loads it only after a visitor presses that button. Each block from the
 * microphone is mixed to mono, resampled to 16 kHz through a Kaiser-windowed sinc
 * low-pass filter and posted to the page as 16-bit PCM. It keeps no audio of its own
 * and stops at the length the page allows. */
const OUT_RATE = 16000;
/** A tenth of a second per message to the page. */
const CHUNK = 1600;
/** Stopband attenuation in dB, and the Kaiser window shape that reaches it. */
const ATTENUATION = 80;
const BETA = 0.1102 * (ATTENUATION - 8.7);
/** Device rates with no small ratio to 16 kHz use the nearest of this many filter phases. */
const MAX_PHASES = 1024;

/** The zeroth-order modified Bessel function of the first kind. */
function bessel(x) {
  let sum = 1;
  for (let k = 1, term = 1; k < 64; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
    if (term < sum * 1e-12) break;
  }
  return sum;
}
const gcd = (a, b) => (b ? gcd(b, a % b) : a);

class Resampler {
  constructor(inRate) {
    this.inRate = inRate;
    // The passband ends 10% below the lower Nyquist frequency and the stopband starts
    // at it, so nothing above 8 kHz folds back into the note.
    const edge = 0.5 * Math.min(1, OUT_RATE / inRate);
    const width = 0.1 * edge;
    const cutoff = edge - width / 2;
    const half = Math.ceil((ATTENUATION - 7.95) / (2.285 * 2 * Math.PI * width) / 2);
    const taps = 2 * half;
    const phases = Math.min(OUT_RATE / gcd(inRate, OUT_RATE), MAX_PHASES);
    this.half = half;
    this.taps = taps;
    this.phases = phases;
    this.kernels = new Float32Array(phases * taps);
    for (let phase = 0; phase < phases; phase++) {
      const at = phase * taps;
      let sum = 0;
      for (let tap = 0; tap < taps; tap++) {
        const distance = tap - half + 1 - phase / phases;
        const x = 2 * Math.PI * cutoff * distance;
        const value = (x ? Math.sin(x) / x : 1) *
          bessel(BETA * Math.sqrt(Math.max(0, 1 - (distance / half) ** 2)));
        this.kernels[at + tap] = value;
        sum += value;
      }
      // Every phase passes a steady signal at the same level.
      for (let tap = 0; tap < taps; tap++) this.kernels[at + tap] /= sum;
    }
    this.buffer = new Float32Array(taps + 4096);
    // Silence stands in for the samples before the first one.
    this.length = half - 1;
    this.center = half - 1;
    this.fraction = 0;
  }

  /** Adds `count` input samples and emits every output sample they complete. */
  push(samples, count, emit) {
    if (this.length + count > this.buffer.length) {
      const grown = new Float32Array(this.length + count + 4096);
      grown.set(this.buffer.subarray(0, this.length));
      this.buffer = grown;
    }
    this.buffer.set(count === samples.length ? samples : samples.subarray(0, count), this.length);
    this.length += count;
    const { buffer, kernels, taps, half, phases, inRate } = this;
    while (this.center + half < this.length) {
      const from = this.center - half + 1;
      const at = Math.floor((this.fraction * phases) / OUT_RATE) * taps;
      let sum = 0;
      for (let tap = 0; tap < taps; tap++) sum += kernels[at + tap] * buffer[from + tap];
      emit(sum);
      // Whole-number steps keep a two-minute note exactly in time.
      this.fraction += inRate;
      this.center += Math.floor(this.fraction / OUT_RATE);
      this.fraction %= OUT_RATE;
    }
    const spent = this.center - half + 1;
    if (spent > 0) {
      buffer.copyWithin(0, spent, this.length);
      this.length -= spent;
      this.center -= spent;
    }
  }
}

class VoiceRecorder extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const limit = options?.processorOptions?.maxFrames;
    this.limit = Number.isInteger(limit) && limit > 0 ? limit : OUT_RATE * 120;
    this.resampler = new Resampler(Math.round(sampleRate));
    this.mono = new Float32Array(128);
    this.chunk = new Int16Array(CHUNK);
    this.filled = 0;
    this.peak = 0;
    this.frames = 0;
    this.done = false;
    this.emit = (sample) => {
      if (this.frames >= this.limit) return;
      const clipped = sample < -1 ? -1 : sample > 1 ? 1 : sample;
      const level = clipped < 0 ? -clipped : clipped;
      if (level > this.peak) this.peak = level;
      this.chunk[this.filled++] = Math.round(clipped * 32767);
      this.frames++;
      if (this.filled === CHUNK || this.frames === this.limit) this.post();
      if (this.frames === this.limit) this.port.postMessage({ limit: true });
    };
    this.port.onmessage = (event) => {
      if (event.data === "stop") this.finish();
    };
  }

  post() {
    if (!this.filled) return;
    const pcm = this.chunk.slice(0, this.filled).buffer;
    this.port.postMessage({ pcm, peak: this.peak }, [pcm]);
    this.filled = 0;
    this.peak = 0;
  }

  /** Drains the filter's tail, so the note ends where the visitor stopped. */
  finish() {
    if (this.done) return;
    this.done = true;
    const { half } = this.resampler;
    this.resampler.push(new Float32Array(half), half, this.emit);
    this.post();
    this.port.postMessage({ done: true, frames: this.frames });
  }

  process(inputs) {
    if (this.done) return false;
    const channels = inputs[0];
    const count = channels?.[0]?.length ?? 0;
    if (!count || this.frames >= this.limit) return true;
    if (this.mono.length < count) this.mono = new Float32Array(count);
    const mono = this.mono;
    if (channels.length === 1) mono.set(channels[0]);
    else
      for (let index = 0; index < count; index++) {
        let sum = 0;
        for (const channel of channels) sum += channel[index];
        mono[index] = sum / channels.length;
      }
    this.resampler.push(mono, count, this.emit);
    return true;
  }
}

registerProcessor("templ-voice-recorder", VoiceRecorder);
