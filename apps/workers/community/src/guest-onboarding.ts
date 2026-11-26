import { PRODUCT_LIMITS } from "@templ/chat/plans";
import { validAccent } from "@templ/chat/appearance";
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
import { managedKnowledgeCall } from "./managed-agent/knowledge-client";
import { refusePhrase } from "./secret-guard";
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
type Trial = {
  previewId: string;
  room: string;
  site: string;
  expires: number;
  brand: WebsiteBrand;
  imported?: boolean;
  icon?: string;
  confirmed?: boolean;
  owner?: string;
  finished?: boolean;
};
type TrialEnv = Partial<Env> & KnowledgeEnv;
type Claim = { id: string; brand: WebsiteBrand; expires: number };
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
 * and stays private until an account claims the preview. */
export async function previewRecord(
  storage: DurableObjectStorage,
  env: TrialEnv,
  body: Record<string, unknown>,
) {
  let row = await storage.get<Trial>(KEY);
  const now = Date.now();
  if (!row && body.op === "start") {
    const site = websiteUrl(body.site);
    await refusePhrase(site, "saved");
    row = {
      site,
      previewId: crypto.randomUUID(),
      room: uuidv7(now),
      expires: now + DAY,
      brand: defaultBrand(site),
    };
    const initial = row;
    await storage.transaction(async (tx) => {
      await tx.put(KEY, initial);
      await tx.setAlarm(initial.expires);
    });
  }
  if (!row || now >= row.expires) throw expired();
  const room = "room:" + row.room;
  if (
    !["start", "read"].includes(String(body.op)) &&
    body.previewId !== row.previewId
  )
    throw new HttpError(409, "A different preview is open. Reload this page.");
  if (row.owner && body.op === "read")
    return json({ claiming: true, previewId: row.previewId });
  if (
    row.owner &&
    ((body.op !== "claim" && body.op !== "finish") || row.owner !== body.owner)
  )
    throw new HttpError(409, "This preview has already been saved.");
  if (body.op === "start") {
    if (websiteUrl(body.site) !== row.site)
      throw new HttpError(409, "Start a new preview to change websites.");
    if (row.imported === undefined) {
      const source = await knowledgeCall<{
        ready: boolean;
        brand?: WebsiteBrand;
      }>(
        env,
        room,
        "knowledge.previewSite",
        { role: "manager", principal: "website-preview" },
        { url: row.site },
      );
      row.brand = source.brand ?? defaultBrand(row.site);
      row.icon = await previewIcon(row.brand.logo);
      if (!row.icon) row.brand.logo = "";
      row.imported = source.ready;
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
    row.confirmed = true;
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
    await refusePhrase(body.question, "sent");
    return json(
      await managedKnowledgeCall(env, room, "trial.practice", {
        question: body.question,
        requestId: body.requestId,
      }),
    );
  } else if (body.op === "claim" || body.op === "finish") {
    if (!row.confirmed || typeof body.owner !== "string" || !body.owner)
      throw new HttpError(403, "Confirm your chat and sign in to save it.");
    row.owner = body.owner;
    if (body.op === "finish") row.finished = true;
    await storage.put(KEY, row);
    return json({
      id: row.room,
      brand: row.brand,
      expires: row.expires,
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
    confirmed: !!row.confirmed,
    remaining,
  });
}

export async function expirePreview(
  storage: DurableObjectStorage,
  env: TrialEnv,
) {
  const row = await storage.get<Trial>(KEY);
  if (!row) return false;
  // A claim may be retrying the widget initialization after the room was created.
  const cleanupAt = row.expires + (row.owner && !row.finished ? 60_000 : 0);
  if (Date.now() < cleanupAt) {
    await storage.setAlarm(cleanupAt);
    return true;
  }
  let saved = row.finished;
  if (row.owner && !saved) {
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

export async function guestOnboardingRoute(
  request: Request,
  env: Env,
  authenticate: () => Promise<string>,
  forward: Forward,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  const op = path.slice("/onboarding/".length);
  if (
    !["read", "start", "confirm", "ask", "claim"].includes(op) ||
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
    const claim = await call({ op, owner, previewId: body.previewId });
    if (!claim.ok) return claim;
    const { id, brand, expires } = await claim.json<Claim>();
    const created = await forward(
      "/rooms",
      {
        expectedPrincipalId: owner,
        id,
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
        walletIdentification: { enabled: false, evm: true, solana: true },
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
    args = { op, name: body.name, accent: body.accent, logo: body.logo };
  if (op === "ask")
    args = { op, question: body.question, requestId: body.requestId };
  const result = await call({ ...args, previewId: body.previewId });
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
