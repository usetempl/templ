import type { TailHost } from "./support-widget";

export type VoiceNoteFailure =
  | "aborted" | "session" | "connection" | "busy" | "unavailable" | "too-long" | "failed"
  | "secret" | "silent" | "short" | "limited" | "spent";
type VoiceAnswer = { status: number; body: string };
type VoiceRequest = {
  url: string;
  headers: Readonly<Record<string, string>>;
  body: Blob;
  signal: AbortSignal;
  /** The service holds the whole file; what remains is its work. */
  uploaded(): void;
};
export type VoiceSend = (request: VoiceRequest) => Promise<VoiceAnswer>;

/** A long note on a large model can take longer than the widget's 20-second requests. */
const ANSWER_MS = 150_000;
const failure = (voice: VoiceNoteFailure, cause?: unknown) =>
  Object.assign(new Error(`voice-${voice}`), { voice, cause });

const browserSend: VoiceSend = ({ url, headers, body, signal, uploaded }) =>
  new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", url);
    request.responseType = "text";
    request.timeout = ANSWER_MS;
    for (const [name, value] of Object.entries(headers)) request.setRequestHeader(name, value);
    request.upload.addEventListener("load", uploaded);
    request.addEventListener("load", () => resolve({ status: request.status, body: request.responseText }));
    request.addEventListener("error", () => reject(failure("connection")));
    request.addEventListener("timeout", () => reject(failure("failed")));
    request.addEventListener("abort", () => reject(failure("aborted")));
    signal.addEventListener("abort", () => request.abort(), { once: true });
    request.send(body);
  });

type Adopted = readonly [
  { token: string } | undefined,
  (path: string, body?: object) => Promise<unknown>,
  unknown,
  string,
];

export async function transcribeVoiceNote(
  host: Pick<TailHost, "client">,
  wav: Blob,
  id: string,
  { build, signal, uploaded, send = browserSend }: {
    build?: string;
    signal: AbortSignal;
    uploaded(): void;
    send?: VoiceSend;
  },
) {
  const adopt = () => (host.client as unknown as { adopt(): Adopted }).adopt();
  for (let attempt = 0; ; attempt++) {
    try {
      if (host.client.session) await adopt()[1]("/conversations/status");
      else await host.client.guest?.();
    } catch (reason) {
      throw failure(signal.aborted ? "aborted" : "session", reason);
    }
    const [session, , , base] = adopt();
    if (signal.aborted) throw failure("aborted");
    if (!session) throw failure("session");
    const answer = await send({
      url: `${base}/voice/transcribe?clientId=${id}`,
      headers: {
        Authorization: `Bearer ${session.token}`,
        "Content-Type": "audio/wav",
        ...(build ? { "X-Templ-Widget": build } : {}),
      },
      body: wav,
      signal,
      uploaded,
    });
    const { status } = answer;
    // A guest session that ended early renews once and sends the same note again.
    if (status === 401 && !attempt) continue;
    let body: { text?: unknown; reason?: unknown } | undefined;
    try {
      body = JSON.parse(answer.body);
    } catch {
      if (status >= 200 && status < 300) throw failure("failed");
    }
    if (status >= 200 && status < 300) {
      if (typeof body?.text !== "string") throw failure("failed");
      return body.text.trim();
    }
    switch (body?.reason) {
      case "secret-refused": throw failure("secret");
      case "voice-note-silent": throw failure("silent");
      case "voice-note-too-short": throw failure("short");
      case "voice-note-too-long":
      case "voice-note-too-large": throw failure("too-long");
      case "voice-note-used": throw failure("spent");
      case "voice-note-limit":
      case "voice-note-daily-limit":
      case "voice-note-network-limit": throw failure("limited");
      case "voice-note-in-progress": throw failure("busy");
    }
    throw failure(
      status === 401 ? "session"
        : status === 413 ? "too-long"
          : status === 429 || status === 503 ? "busy"
            : status === 403 || status === 404 || status === 405 || status === 501 ? "unavailable"
              : "failed",
    );
  }
}
