export const DEMO_WORKSPACE_ID = "01a0fce4-c0c2-75fc-a23b-4169e7398e94";
export const DEMO_FLAG_KEYS = Object.freeze(["rememberSignIn", "emailNotices"]);
export const DEMO_FIXTURE_KEYS = Object.freeze({
  "widget-base": "rememberSignIn",
  "remember-staff": "rememberSignIn",
  "guest-follow-up": "emailNotices",
  notifications: "emailNotices",
});
export const DEMO_FLAG_SOURCE_PATHS = Object.freeze([
  "apps/scripts/src/release/demo-workspace-flag-plan.mjs",
  "apps/scripts/src/release/verify-staging-support-notifications.mjs",
  "apps/scripts/src/release/verify-staging-support-widget.mjs",
  "apps/scripts/src/release/widget-stages/guest-follow-up.mjs",
  "apps/scripts/src/release/widget-stages/remember.mjs",
  "packages/chat/src/demo-workspace-flag-scope.mjs",
]);
export const DEMO_FLAG_APPROVAL = Object.freeze({
  approvedAt: "2026-10-03",
  approvedBy: "founder",
  approval: "Yes, scoped and audited",
});
const ID = /^[a-z0-9][a-z0-9-]{2,39}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PRINCIPAL =
  /^(?:0x[0-9a-f]{40}|account:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const SHA = /^[0-9a-f]{64}$/;
const MAX_MS = 90 * 86_400_000;
const fields = [
  "id",
  "demoWorkspace",
  "demoCreator",
  "demoManager",
  "operator",
  "startsAt",
  "until",
  "reason",
  "approvedAt",
  "approvedBy",
  "approval",
  "keys",
  "fixtures",
  "collectorSourceSha256",
  "planSha256",
];
const exact = (value, names) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join() === [...names].sort().join();
const principal = (value) =>
  typeof value === "string" &&
  PRINCIPAL.test(value) &&
  value !== `0x${"0".repeat(40)}`;
const iso = (value) =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

/** The approval permits this scope category. It approves no prospective plan hash. */
export function parseDemoFlagScopes(value) {
  if (!Array.isArray(value) || value.length > 1) return null;
  const result = [];
  for (const scope of value) {
    if (
      !exact(scope, fields) ||
      typeof scope.id !== "string" ||
      !ID.test(scope.id) ||
      scope.demoWorkspace !== DEMO_WORKSPACE_ID ||
      !principal(scope.demoCreator) ||
      !principal(scope.demoManager) ||
      !principal(scope.operator) ||
      !iso(scope.startsAt) ||
      !iso(scope.until) ||
      Date.parse(scope.startsAt) < Date.parse("2026-10-03T04:30:00.000Z") ||
      Date.parse(scope.until) <= Date.parse(scope.startsAt) ||
      Date.parse(scope.until) - Date.parse(scope.startsAt) > MAX_MS ||
      typeof scope.reason !== "string" ||
      scope.reason !== scope.reason.trim() ||
      scope.reason.length < 3 ||
      scope.reason.length > 280 ||
      Object.entries(DEMO_FLAG_APPROVAL).some(
        ([key, text]) => scope[key] !== text,
      ) ||
      !Array.isArray(scope.keys) ||
      scope.keys.length !== DEMO_FLAG_KEYS.length ||
      scope.keys.some((key, index) => key !== DEMO_FLAG_KEYS[index]) ||
      !Array.isArray(scope.fixtures) ||
      scope.fixtures.length !== 4 ||
      !exact(scope.collectorSourceSha256, DEMO_FLAG_SOURCE_PATHS) ||
      Object.values(scope.collectorSourceSha256).some(
        (hash) => typeof hash !== "string" || !SHA.test(hash),
      ) ||
      typeof scope.planSha256 !== "string" ||
      !SHA.test(scope.planSha256)
    )
      return null;
    const names = Object.keys(DEMO_FIXTURE_KEYS);
    const ids = new Set([scope.demoWorkspace]);
    const fixtures = [];
    for (const [index, row] of scope.fixtures.entries()) {
      if (
        !exact(row, ["name", "id", "creator", "manager"]) ||
        row.name !== names[index] ||
        typeof row.id !== "string" ||
        !UUID.test(row.id) ||
        ids.has(row.id) ||
        !principal(row.creator) ||
        !principal(row.manager) ||
        row.creator !== row.manager
      )
        return null;
      ids.add(row.id);
      fixtures.push({
        name: row.name,
        id: row.id,
        creator: row.creator,
        manager: row.manager,
      });
    }
    result.push({
      id: scope.id,
      demoWorkspace: scope.demoWorkspace,
      demoCreator: scope.demoCreator,
      demoManager: scope.demoManager,
      operator: scope.operator,
      startsAt: scope.startsAt,
      until: scope.until,
      reason: scope.reason,
      ...DEMO_FLAG_APPROVAL,
      keys: [...DEMO_FLAG_KEYS],
      fixtures,
      collectorSourceSha256: Object.fromEntries(
        DEMO_FLAG_SOURCE_PATHS.map((path) => [
          path,
          scope.collectorSourceSha256[path],
        ]),
      ),
      planSha256: scope.planSha256,
    });
  }
  return result;
}

export function canonicalDemoFlagPlan(scope) {
  const parsed = parseDemoFlagScopes([scope]);
  if (!parsed) throw new Error("Invalid Demo flag scope.");
  const { planSha256: _hash, ...plan } = parsed[0];
  return JSON.stringify(plan);
}

export async function demoFlagPlanSha256(scope) {
  const bytes = new globalThis.TextEncoder().encode(
    canonicalDemoFlagPlan(scope),
  );
  return [
    ...new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes)),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function verifiedDemoFlagScopes(value) {
  const scopes = parseDemoFlagScopes(value);
  if (!scopes) return null;
  for (const scope of scopes)
    if ((await demoFlagPlanSha256(scope)) !== scope.planSha256) return null;
  return scopes;
}

export function demoFlagFixture(scope, workspace) {
  if (workspace === scope.demoWorkspace)
    return {
      name: "demo",
      id: workspace,
      creator: scope.demoCreator,
      manager: scope.demoManager,
      keys: [...DEMO_FLAG_KEYS],
    };
  const row = scope.fixtures.find((fixture) => fixture.id === workspace);
  return row ? { ...row, keys: [DEMO_FIXTURE_KEYS[row.name]] } : null;
}
