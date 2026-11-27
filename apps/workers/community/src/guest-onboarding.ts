import { DEFAULT_WALLET_IDENTIFICATION } from "@templ/chat/widget-wallet";
import { PRODUCT_LIMITS } from "@templ/chat/plans";
import { validAccent } from "@templ/chat/appearance";
import { ANSWER_REPORT_LIMITS } from "@templ/chat/support-quality";
import {
  HttpError,
  json,
  randomToken,
  readCookie,
  readJson,
  sha256Hex,
  type Env,
} from "./common";
import { nativeName, nativeRoomStub } from "./native-rooms";
import {
  knowledgeCall,
  knowledgeStub,
  type KnowledgeEnv,
} from "./support-knowledge-client";
import {
  TRIAL_RECEIPT_TYPE,
  managedKnowledgeCall,
  managedKnowledgeReceipt,
} from "./managed-agent/knowledge-client";
import { refusePhrase, SECRET_REFUSED } from "./secret-guard";
import { uuidv7 } from "./uuidv7";
import {
  websiteUrl,
  defaultBrand,
  publicIcon,
  previewIcon,
  type WebsiteBrand,
} from "./website-brand";
import { activatedReleaseFlag } from "./release-activation";

const KEY = "private-website-preview";
const COOKIE = "__Host-templ-preview";
const DAY = 86_400_000;
/** The request ID each practice question carries (trial-practice.ts). */
const REQUEST_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Answer reports, while `previewReportsOn` holds.
 *
 * - The row keeps the request ID of each AI answer its visitor was shown: the
 *   random ID their browser made for that question, which the preview's
 *   practice count already holds. Handoffs and failures keep nothing.
 * - A report adds its time and the visitor's optional reason, trimmed, at most
 *   `reasonChars` and screened like their questions. A repeat changes nothing.
 *   No question or answer text, account, wallet or IP is kept.
 * - Only the preview's own cookie reaches this row, so a visitor reports only
 *   answers their preview gave. No route reads a report back; responses say
 *   only `reported`. Nothing alerts, opens a case, reaches a model or the
 *   workspace a claim creates. Reports leave with the row when it expires. */
type PreviewReport = { at: number; reason: string | null };
type Answers = Partial<Record<string, PreviewReport | null>>;
type StoredTrial = {
  previewId: string;
  room: string;
  site: string;
  expires: number;
  brand: WebsiteBrand;
  imported?: boolean;
  scanVersion?: number;
  suggestion?: string;
  icon?: string;
  confirmed?: boolean;
  owner?: string;
  visitorWallets?: boolean;
  finished?: boolean;
  /** Each AI answer shown, null until its visitor reports it. */
  answers?: Answers;
};
type PreviewContent = Omit<StoredTrial, "confirmed" | "owner" | "finished">;
type Trial = PreviewContent & (
  | { confirmed?: false; owner?: never; finished?: false }
  | { confirmed: true; owner?: never; finished?: false }
  | { confirmed: true; owner: string; finished?: boolean }
);

function validTrial(row: StoredTrial): row is Trial {
  if (row.confirmed !== undefined && typeof row.confirmed !== "boolean") return false;
  if (row.visitorWallets !== undefined && typeof row.visitorWallets !== "boolean") return false;
  if (row.finished !== undefined && typeof row.finished !== "boolean") return false;
  if (row.owner === undefined) return row.finished !== true;
  return typeof row.owner === "string" && row.owner.length > 0 && row.confirmed === true;
}

function stage(row: Trial) {
  if (row.owner === undefined) return row.confirmed ? "confirmed" : "draft";
  return row.finished ? "saved" : "claiming";
}
type TrialEnv = Partial<Env> & KnowledgeEnv;
type Claim = { id: string; brand: WebsiteBrand; expires: number; visitorWallets: boolean };
type Forward = (
  path: string,
  body: Record<string, unknown>,
  deadline: number,
) => Promise<Response>;
const expired = () =>
  new HttpError(
    410,
    "Your preview expired. Enter your website to start again.",
  );

function checkedBrand(
  body: Record<string, unknown>,
  site: string,
): WebsiteBrand {
  const name = nativeName(body.name);
  const accent = body.accent;
  if (typeof accent !== "string" || !/^#[0-9a-f]{6}$/i.test(accent))
    throw new HttpError(400, "Choose a color.");
  if (typeof body.logo !== "string")
    throw new HttpError(400, "Enter an HTTPS icon URL or leave it blank.");
  const logo = body.logo ? publicIcon(body.logo, site) : "";
  if (body.logo && !logo)
    throw new HttpError(400, "Enter a public HTTPS icon URL.");
  return { name, accent, logo };
}

/** A row's answers, without entries this release would not write. */
function storedAnswers(row: StoredTrial): Answers {
  const answers: Answers = {};
  for (const [id, report] of Object.entries(row.answers ?? {}).slice(
    0,
    PRODUCT_LIMITS.freeAiPracticeQuestions,
  ))
    if (
      REQUEST_ID.test(id) &&
      (report === null ||
        (Number.isSafeInteger(report?.at) &&
          (report?.reason === null ||
            (typeof report?.reason === "string" &&
              report.reason.length <= ANSWER_REPORT_LIMITS.reasonChars))))
    )
      answers[id] = report ? { at: report.at, reason: report.reason } : null;
  return answers;
}

/** Keeps the request ID of an AI answer the visitor was shown. A handoff, a
 * failure or a row that now holds another preview keeps nothing. */
async function keepAnswer(
  storage: DurableObjectStorage,
  previewId: string,
  requestId: unknown,
  result: unknown,
) {
  const answer = (result as { answer?: unknown } | null)?.answer;
  if (
    typeof requestId !== "string" ||
    !REQUEST_ID.test(requestId) ||
    typeof answer !== "string" ||
    !answer
  )
    return;
  const row = await storage.get<StoredTrial>(KEY);
  if (
    !row ||
    row.previewId !== previewId ||
    !(Date.now() < row.expires) ||
    !validTrial(row)
  )
    return;
  const answers = storedAnswers(row);
  if (
    answers[requestId] !== undefined ||
    Object.keys(answers).length >= PRODUCT_LIMITS.freeAiPracticeQuestions
  )
    return;
  await storage.put(KEY, {
    ...row,
    answers: { ...answers, [requestId]: null },
  } satisfies StoredTrial);
}

/** The optional reason: trimmed plain text of at most `reasonChars`, screened
 * like the visitor's questions. Null when empty. */
async function reportReason(value: unknown): Promise<string | null> {
  if (value === undefined || value === null) return null;
  const reason = typeof value === "string" ? value.trim() : null;
  if (
    reason === null ||
    reason.length > ANSWER_REPORT_LIMITS.reasonChars ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u0008\u000b-\u001f\u007f]/.test(reason)
  )
    throw new HttpError(
      400,
      `Use up to ${ANSWER_REPORT_LIMITS.reasonChars} characters of plain text.`,
      undefined,
      "report-reason",
    );
  if (!reason) return null;
  await refusePhrase(reason, "sent");
  return reason;
}

/** `report {requestId, reason?}` on one AI answer this preview showed. Its
 * refusals keep their reason for the report dialog. */
async function reportAnswer(
  storage: DurableObjectStorage,
  row: Trial,
  body: Record<string, unknown>,
  now: number,
) {
  try {
    if (body.reports !== true) throw new HttpError(404, "Preview not found.");
    const requestId = body.requestId;
    if (typeof requestId !== "string" || !REQUEST_ID.test(requestId))
      throw new HttpError(
        400,
        "Choose an answer to report.",
        undefined,
        "invalid-answer",
      );
    const reason = await reportReason(body.reason);
    const answers = storedAnswers(row);
    const held = answers[requestId];
    if (held === undefined)
      throw new HttpError(
        404,
        "This answer can't be reported.",
        undefined,
        "report-unavailable",
      );
    if (held === null)
      await storage.put(KEY, {
        ...row,
        answers: { ...answers, [requestId]: { at: now, reason } },
      } satisfies StoredTrial);
    return json({ reported: true });
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    return json(
      {
        error: error.message,
        ...(error.reason ? { reason: error.reason } : {}),
      },
      error.status,
    );
  }
}

const BUDGET_KEY = "preview-admission";
type Admissions = { day: number; total: number; ips: Record<string, number> };
/** Bound anonymous fetches and free practice costs across browsers and regions. */
export async function previewAdmission(
  storage: DurableObjectStorage,
  ip: unknown,
) {
  if (typeof ip !== "string" || !/^[a-f0-9]{64}$/.test(ip))
    throw new HttpError(400, "Invalid request.");
  const day = Math.floor(Date.now() / DAY);
  await storage.transaction(async (tx) => {
    const previous = await tx.get<Admissions>(BUDGET_KEY);
    const counts: Admissions =
      previous?.day === day ? previous : { day, total: 0, ips: {} };
    const count = counts.ips[ip] ?? 0;
    if (count >= 5 || counts.total >= 200)
      throw new HttpError(
        429,
        "The preview limit has been reached. Try again tomorrow.",
      );
    counts.ips[ip] = count + 1;
    counts.total++;
    await tx.put(BUDGET_KEY, counts);
    await tx.setAlarm((day + 1) * DAY);
  });
  return json({ ok: true });
}

export async function expirePreviewAdmissions(storage: DurableObjectStorage) {
  return storage.transaction(async (tx) => {
    const current = await tx.get<Admissions>(BUDGET_KEY);
    if (!current) return false;
    if (current.day < Math.floor(Date.now() / DAY)) await tx.delete(BUDGET_KEY);
    return true;
  });
}

/** Runs in an AuthRecord dedicated to one random cookie. Its room id is server-generated
 * and stays private until an account claims the preview. `hold` keeps the record's
 * next step waiting for work that outlasts the response. */
export async function previewRecord(
  storage: DurableObjectStorage,
  env: TrialEnv,
  body: Record<string, unknown>,
  hold: (pending: Promise<unknown>) => void = () => {},
) {
  let row = await storage.get<StoredTrial>(KEY);
  const now = Date.now();
  if (!row && body.op === "start") {
    const site = websiteUrl(body.site);
    await refusePhrase(site, "saved");
    const initial: Trial = {
      site,
      previewId: crypto.randomUUID(),
      room: uuidv7(now),
      expires: now + DAY,
      brand: defaultBrand(site),
    };
    row = initial;
    await storage.transaction(async (tx) => {
      await tx.put(KEY, initial);
      await tx.setAlarm(initial.expires);
    });
  }
  // A row without a valid expiry or flag combination is never served or changed.
  if (!row || !(now < row.expires) || !validTrial(row)) throw expired();
  const state = stage(row);
  const room = "room:" + row.room;
  if (
    !["start", "read"].includes(String(body.op)) &&
    body.previewId !== row.previewId
  )
    throw new HttpError(409, "A different preview is open. Reload this page.");
  // A report changes nothing a save reads, so it also works during a claim.
  if (body.op === "report") return reportAnswer(storage, row, body, now);
  if (row.owner && body.op === "read")
    return json({ claiming: true, previewId: row.previewId });
  if (
    row.owner &&
    ((body.op !== "claim" && body.op !== "finish") || row.owner !== body.owner)
  )
    throw new HttpError(409, "This preview has already been saved.");
  if ((body.op === "confirm" || body.op === "claim") &&
      body.visitorWallets !== undefined && typeof body.visitorWallets !== "boolean")
    throw new HttpError(400, "Choose whether visitors can verify a wallet.");
  if (body.op === "start" || body.op === "read") {
    if (body.op === "start" && websiteUrl(body.site) !== row.site)
      throw new HttpError(409, "Start a new preview to change websites.");
    if (row.scanVersion !== 2) {
      const source = await knowledgeCall<{
        ready: boolean;
        brand?: WebsiteBrand;
        suggestion?: string;
      }>(
        env,
        room,
        "knowledge.previewSite",
        { role: "manager", principal: "website-preview" },
        { url: row.site },
      );
      if (!row.confirmed) {
        row.brand = source.brand ?? defaultBrand(row.site);
        row.icon = await previewIcon(row.brand.logo);
        if (!row.icon) row.brand.logo = "";
      }
      row.scanVersion = 2;
      row.imported = source.ready;
      row.suggestion = source.suggestion;
      await storage.put(KEY, row);
    }
  } else if (body.op === "confirm") {
    const previousIcon = row.brand.logo;
    row.brand = checkedBrand(body, row.site);
    await refusePhrase(row.brand.name, "saved");
    await refusePhrase(row.brand.logo, "saved");
    if (row.brand.logo !== previousIcon) {
      row.icon = await previewIcon(row.brand.logo);
      if (!row.icon && row.brand.logo)
        throw new HttpError(
          400,
          "That icon could not load. Try another image or leave it blank.",
        );
    }
    row = { ...row, confirmed: true, ...(typeof body.visitorWallets === "boolean" ? { visitorWallets: body.visitorWallets } : {}) } satisfies Trial;
    await storage.put(KEY, row);
  } else if (body.op === "ask") {
    if (!row.confirmed || !row.imported)
      throw new HttpError(
        409,
        "Add a public page and confirm your chat first.",
      );
    if (
      typeof body.question !== "string" ||
      !body.question.trim() ||
      body.question.length > 800
    )
      throw new HttpError(400, "Enter a question of up to 800 characters.");
    try {
      await refusePhrase(body.question, "sent");
    } catch (error) {
      // The visitor widget uses this reason to clear the refused draft.
      if (body.receipt === true && error instanceof HttpError && error.reason === SECRET_REFUSED)
        return json({ error: error.message, reason: SECRET_REFUSED }, error.status);
      throw error;
    }
    const args = { question: body.question, requestId: body.requestId };
    const { previewId } = row;
    // While reports are on, the row keeps which answers its visitor saw.
    const keep = async (result: unknown) => {
      if (body.reports === true)
        await keepAnswer(storage, previewId, body.requestId, result);
      return result;
    };
    if (body.receipt !== true)
      return json(
        await keep(await managedKnowledgeCall(env, room, "trial.practice", args)),
      );
    const receipt = await managedKnowledgeReceipt(env, room, args);
    if (receipt.headers.get("Content-Type") !== TRIAL_RECEIPT_TYPE || !receipt.body)
      return body.reports === true ? json(await keep(await receipt.json())) : receipt;
    // The record's next step waits for the answer, as it does without a
    // receipt, even after this caller leaves.
    const [delivered, answered] = receipt.body.tee();
    const decoder = new TextDecoder();
    let text = "", size = 0;
    const sink = body.reports === true ? new WritableStream<Uint8Array>({
      write(chunk) {
        size += chunk.byteLength;
        if (size <= 32_768) text += decoder.decode(chunk, { stream: true });
        else text = "";
      },
      async close() {
        if (text && size <= 32_768) await keep(JSON.parse(text + decoder.decode()));
      },
    }) : new WritableStream();
    hold(answered.pipeTo(sink).catch(() => {}));
    return new Response(delivered, receipt);
  } else if (body.op === "claim" || body.op === "finish") {
    // Only a claim binds the preview to an account, and only that account's claim
    // can finish. Repeating either step leaves a claimed or saved row as it is.
    if (
      state === "draft" ||
      typeof body.owner !== "string" ||
      !body.owner ||
      (state === "confirmed" && body.op === "finish")
    )
      throw new HttpError(403, "Confirm your chat and sign in to save it.");
    const visitorWallets = row.owner === undefined
      ? (body.visitorWallets ?? row.visitorWallets) !== false
      : row.visitorWallets === true;
    if (row.owner === undefined) {
      await storage.put(KEY, { ...row, confirmed: true, owner: body.owner, visitorWallets } satisfies Trial);
    } else if (body.op === "finish" && !row.finished) {
      await storage.put(KEY, { ...row, finished: true } satisfies Trial);
    }
    return json({
      id: row.room,
      brand: row.brand,
      expires: row.expires,
      visitorWallets,
    } satisfies Claim);
  } else if (body.op !== "read") throw new HttpError(404, "Preview not found.");
  const { remaining } =
    row.confirmed && row.imported
      ? await managedKnowledgeCall(env, room, "trial.practice")
      : { remaining: PRODUCT_LIMITS.freeAiPracticeQuestions };
  return json({
    previewId: row.previewId,
    site: row.site,
    brand: row.brand,
    icon: row.icon || "",
    ready: row.imported === true,
    suggestion: row.suggestion,
    confirmed: !!row.confirmed,
    ...(row.visitorWallets === undefined ? {} : { visitorWallets: row.visitorWallets }),
    remaining,
    ...(body.reports === true ? { answerReports: true } : {}),
  });
}

export async function expirePreview(
  storage: DurableObjectStorage,
  env: TrialEnv,
) {
  const row = await storage.get<StoredTrial>(KEY);
  if (!row) return false;
  const state = validTrial(row) ? stage(row) : null;
  // A claim may be retrying the widget initialization after the room was created.
  // An invalid row gets the same room check: its flags alone never decide cleanup.
  const unsettled = state === "claiming" || state === null;
  const cleanupAt = row.expires + (unsettled ? 60_000 : 0);
  if (Date.now() < cleanupAt) {
    await storage.setAlarm(cleanupAt);
    return true;
  }
  let saved = state === "saved";
  if (unsettled) {
    if (!env.ROOMS) throw new Error("Workspace storage unavailable.");
    const read = await nativeRoomStub({ ROOMS: env.ROOMS }, row.room).fetch(
      "https://internal/private/native/read",
      { method: "POST" },
    );
    if (!read.ok && read.status !== 404)
      throw new Error("Workspace status unavailable.");
    saved = read.ok;
  }
  if (!saved) {
    const clean = await knowledgeStub(env, "room:" + row.room).fetch(
      "https://knowledge.internal/purge-workspace",
      {
        method: "POST",
        body: JSON.stringify({ workspace: row.room }),
      },
    );
    if (!clean.ok || !(await clean.json<{ done?: boolean }>()).done)
      throw new Error("Preview cleanup pending.");
  }
  await storage.delete(KEY);
  return true;
}

/** A preview belongs to a temporary browser session. Its dedicated switch
 * never enables reports in a customer workspace. The public preview route
 * separately verifies its signed practice release on every operation. */
export function previewReportsOn(env: Env) {
  return env.SUPPORT_QUALITY_ENABLED === "true" &&
    env.SUPPORT_PREVIEW_ANSWER_REPORTS_ENABLED === "true";
}

export async function guestOnboardingRoute(
  request: Request,
  env: Env,
  authenticate: () => Promise<string>,
  forward: Forward,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  const op = path.slice("/onboarding/".length);
  const reports = previewReportsOn(env);
  if (
    ![
      "read",
      "start",
      "confirm",
      "ask",
      "claim",
      ...(reports ? ["report"] : []),
    ].includes(op) ||
    request.method !== "POST"
  )
    throw new HttpError(404, "Preview not found.");
  if (
    request.headers.get("Origin") !== env.APP_ORIGIN ||
    !request.headers.get("Content-Type")?.startsWith("application/json")
  )
    throw new HttpError(403, "Open this preview in Templ.");
  const released =
    env.APP_ORIGIN === "https://usetempl.com"
      ? activatedReleaseFlag(env, "trialAiPracticeVerified") &&
        activatedReleaseFlag(env, "supportWorkflowVerified")
      : env.SUPPORT_SELF_SERVE_SETUP_ENABLED === "true";
  if (
    !released ||
    env.SUPPORT_TRIAL_AI_PRACTICE_ENABLED !== "true" ||
    env.MANAGED_AGENT_ENABLED !== "true"
  )
    throw new HttpError(
      503,
      "Website previews are unavailable. Try again later.",
    );
  const body = await readJson(request, 4096);
  const old = readCookie(request, COOKIE);
  let token = old && /^[0-9a-f]{64}$/.test(old) ? old : null;
  if (op === "start") {
    websiteUrl(body.site);
    if (!token || body.restart === true) token = randomToken();
  }
  if (!token) {
    if (op === "read") return json(null);
    throw expired();
  }
  for (const key of [
    "ip:" + (request.headers.get("CF-Connecting-IP") ?? "unknown"),
    "global",
  ]) {
    if (
      !(
        await env.AUTH_RATE_LIMITER.limit({
          key: "guest-onboarding:" + op + ":" + key,
        })
      ).success
    )
      throw new HttpError(429, "Too many requests. Try again in a minute.", 60);
  }
  if (op === "start" && token !== old) {
    const ledger = env.AUTH_RECORDS.get(
      env.AUTH_RECORDS.idFromName("website-preview-budget"),
    );
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const allowed = await ledger.fetch(
      "https://internal/website-preview-budget",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ip: await sha256Hex(
            "website-preview:" + Math.floor(Date.now() / DAY) + ":" + ip,
          ),
        }),
      },
    );
    if (!allowed.ok) return allowed;
  }
  const stub = env.AUTH_RECORDS.get(
    env.AUTH_RECORDS.idFromName("website-preview:" + (await sha256Hex(token))),
  );
  const call = (args: Record<string, unknown>) =>
    stub.fetch("https://internal/website-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
  if (op === "claim") {
    const owner = await authenticate();
    if (body.expectedPrincipalId !== owner)
      throw new HttpError(409, "Your account changed. Sign in again.");
    const claim = await call({ op, owner, previewId: body.previewId, visitorWallets: body.visitorWallets });
    if (!claim.ok) return claim;
    const { id, brand, expires, visitorWallets } = await claim.json<Claim>();
    const walletIdentification = { ...DEFAULT_WALLET_IDENTIFICATION, enabled: visitorWallets === true };
    const created = await forward(
      "/rooms",
      {
        expectedPrincipalId: owner,
        id,
        walletIdentification,
        name: brand.name,
        visibility: "public",
        setup: { roles: [] },
        ...(validAccent(brand.accent) ? { accentColor: brand.accent } : {}),
      },
      expires,
    );
    if (!created.ok) return created;
    const widget = await forward(
      "/rooms/" + id + "/widget",
      {
        expectedPrincipalId: owner,
        initializeOnly: true,
        hostedPage: true,
        confirmed: true,
        appearanceRevision: 0,
        appearance: { accent: brand.accent, logo: brand.logo },
        walletIdentification,
      },
      expires,
    );
    if (!widget.ok) return widget;
    const finish = await call({
      op: "finish",
      owner,
      previewId: body.previewId,
    });
    if (!finish.ok) return finish;
    return json({ id }, 200, {
      "Set-Cookie":
        COOKIE + "=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0",
    });
  }
  let args: Record<string, unknown> = { op };
  if (op === "start") args = { op, site: body.site };
  if (op === "confirm")
    args = { op, name: body.name, accent: body.accent, logo: body.logo, visitorWallets: body.visitorWallets };
  if (op === "ask")
    args = {
      op,
      question: body.question,
      requestId: body.requestId,
      ...(body.receipt === true ? { receipt: true } : {}),
    };
  if (op === "report")
    args = { op, requestId: body.requestId, reason: body.reason };
  const result = await call({
    ...args,
    previewId: body.previewId,
    ...(reports ? { reports: true } : {}),
  });
  if (op !== "start") return result;
  const response = new Response(result.body, result);
  response.headers.append(
    "Set-Cookie",
    COOKIE +
      "=" +
      token +
      "; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400",
  );
  return response;
}
