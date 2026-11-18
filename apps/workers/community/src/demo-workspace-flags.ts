import {
  demoFlagFixture,
  verifiedDemoFlagScopes,
  type DemoFlagScope,
} from "@templ/chat/demo-workspace-flag-scope";
import type {
  WorkspaceFlag,
  WorkspaceFlagKey,
} from "@templ/chat/workspace-flags";
import { HttpError } from "./common";
import type { NativeRoomRecord } from "./native-rooms";
import { PRODUCT_STATE_KEY, type ProductState } from "./product-entitlements";

export type DemoWorkspaceFlagEnv = {
  APP_ORIGIN?: string;
  SUPPORT_DEMO_FLAGS_ENABLED?: string;
  DEMO_WORKSPACE_FLAG_SCOPES?: string;
};
export const DEMO_FLAG_ISSUERS_KEY = "workspace-demo-flag-issuers-v1";
export const DEMO_FLAG_REVOCATIONS_KEY = "workspace-demo-flag-revocations-v1";
export type DemoFlagIssuer = {
  scopeId: string;
  planSha256: string;
  creator: string;
  manager: string;
  flag: WorkspaceFlag;
};
export type DemoFlagIssuers = Partial<Record<WorkspaceFlagKey, DemoFlagIssuer>>;
type Reader = { get<T>(key: string): Promise<T | undefined> };
const fields = [
  "key",
  "on",
  "operator",
  "until",
  "reason",
  "authenticatedAt",
] as const;
export function sameDemoFlag(
  a: WorkspaceFlag | undefined,
  b: WorkspaceFlag | undefined,
): boolean {
  return Boolean(
    a &&
    b &&
    Object.keys(a).sort().join() === [...fields].sort().join() &&
    Object.keys(b).sort().join() === [...fields].sort().join() &&
    fields.every((key) => a[key] === b[key]),
  );
}

export async function configuredDemoFlagScopes(
  env: DemoWorkspaceFlagEnv,
): Promise<DemoFlagScope[]> {
  try {
    return (
      (await verifiedDemoFlagScopes(
        JSON.parse(env.DEMO_WORKSPACE_FLAG_SCOPES ?? "[]"),
      )) ?? []
    );
  } catch {
    return [];
  }
}

export async function isDemoFlagOperator(
  env: DemoWorkspaceFlagEnv,
  operator: string,
  now = Date.now(),
): Promise<boolean> {
  if (
    env.APP_ORIGIN !== "https://usetempl.com" ||
    env.SUPPORT_DEMO_FLAGS_ENABLED !== "true"
  )
    return false;
  return (await configuredDemoFlagScopes(env)).some(
    (scope) =>
      scope.operator === operator &&
      Date.parse(scope.startsAt) <= now &&
      now < Date.parse(scope.until),
  );
}

/** A configured plan grants flag writes only for its current native owners. */
export async function requireDemoFlagScope(
  storage: Reader,
  env: DemoWorkspaceFlagEnv,
  input: {
    id: unknown;
    planSha256: unknown;
    operator: string;
    workspace: string;
  },
  now = Date.now(),
) {
  const refuse = () => {
    throw new HttpError(404, "Not found.");
  };
  if (
    env.APP_ORIGIN !== "https://usetempl.com" ||
    env.SUPPORT_DEMO_FLAGS_ENABLED !== "true"
  )
    return refuse();
  const scope = (await configuredDemoFlagScopes(env)).find(
    (row) =>
      row.id === input.id &&
      row.planSha256 === input.planSha256 &&
      row.operator === input.operator &&
      Date.parse(row.startsAt) <= now &&
      now < Date.parse(row.until),
  );
  if (!scope) return refuse();
  const row = demoFlagFixture(scope, input.workspace);
  const native = await storage.get<NativeRoomRecord>("native-room");
  const product = await storage.get<ProductState>(PRODUCT_STATE_KEY);
  const revoked = await storage.get<Record<string, unknown>>(
    DEMO_FLAG_REVOCATIONS_KEY,
  );
  const created = Date.parse(native?.room.createdAt ?? "");
  if (
    !row ||
    !native ||
    native.room.id !== input.workspace ||
    native.room.creator !== row.creator ||
    native.room.manager !== row.manager ||
    native.room.pendingManager != null ||
    !product ||
    product.creator !== row.creator ||
    (await storage.get("workspace-deletion-v1")) !== undefined ||
    revoked?.[scope.id] !== undefined ||
    !Number.isFinite(created) ||
    created > now ||
    (row.name !== "demo" && created < Date.parse(scope.startsAt))
  )
    return refuse();
  return { scope, row, native };
}

/** Scope removal and revocation disable only the flags carrying these issuer markers. */
export async function currentDemoFlags(
  storage: Reader,
  env: DemoWorkspaceFlagEnv,
  flags: Partial<Record<WorkspaceFlagKey, WorkspaceFlag>>,
  native: NativeRoomRecord | undefined,
  now = Date.now(),
) {
  const markers = await storage.get<DemoFlagIssuers>(DEMO_FLAG_ISSUERS_KEY);
  if (!markers) return flags;
  const result = { ...flags };
  for (const [key, marker] of Object.entries(markers)) {
    const flag = result[key as WorkspaceFlagKey];
    try {
      if (
        !native ||
        !marker ||
        Object.keys(marker).sort().join() !==
          "creator,flag,manager,planSha256,scopeId" ||
        !flag ||
        !sameDemoFlag(marker.flag, flag) ||
        marker.creator !== native.room.creator ||
        marker.manager !== native.room.manager
      )
        throw new Error();
      const { scope, row } = await requireDemoFlagScope(
        storage,
        env,
        {
          id: marker.scopeId,
          planSha256: marker.planSha256,
          operator: flag.operator,
          workspace: native.room.id,
        },
        now,
      );
      if (
        !row.keys.includes(key as "rememberSignIn" | "emailNotices") ||
        !Number.isFinite(Date.parse(flag.until)) ||
        !Number.isFinite(Date.parse(flag.authenticatedAt)) ||
        Date.parse(flag.until) > Date.parse(scope.until) ||
        Date.parse(flag.authenticatedAt) < Date.parse(scope.startsAt) ||
        Date.parse(flag.authenticatedAt) > now
      )
        throw new Error();
    } catch {
      delete result[key as WorkspaceFlagKey];
    }
  }
  return result;
}
