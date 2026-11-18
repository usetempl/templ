import type { ChatPrincipalId } from "./principal";
export type DemoFlagKey = "rememberSignIn" | "emailNotices";
export type DemoFixtureName =
  | "widget-base"
  | "remember-staff"
  | "guest-follow-up"
  | "notifications";
export type DemoFlagFixture = {
  name: DemoFixtureName;
  id: string;
  creator: ChatPrincipalId;
  manager: ChatPrincipalId;
};
export type DemoFlagScope = {
  id: string;
  demoWorkspace: string;
  demoCreator: ChatPrincipalId;
  demoManager: ChatPrincipalId;
  operator: ChatPrincipalId;
  startsAt: string;
  until: string;
  reason: string;
  approvedAt: "2026-10-03";
  approvedBy: "founder";
  approval: "Yes, scoped and audited";
  keys: DemoFlagKey[];
  fixtures: DemoFlagFixture[];
  collectorSourceSha256: Record<string, string>;
  planSha256: string;
};
export const DEMO_WORKSPACE_ID: string;
export const DEMO_FLAG_KEYS: readonly DemoFlagKey[];
export const DEMO_FIXTURE_KEYS: Readonly<Record<DemoFixtureName, DemoFlagKey>>;
export const DEMO_FLAG_SOURCE_PATHS: readonly string[];
export const DEMO_FLAG_APPROVAL: Pick<
  DemoFlagScope,
  "approvedAt" | "approvedBy" | "approval"
>;
export function parseDemoFlagScopes(value: unknown): DemoFlagScope[] | null;
export function canonicalDemoFlagPlan(scope: DemoFlagScope): string;
export function demoFlagPlanSha256(scope: DemoFlagScope): Promise<string>;
export function verifiedDemoFlagScopes(
  value: unknown,
): Promise<DemoFlagScope[] | null>;
export function demoFlagFixture(
  scope: DemoFlagScope,
  workspace: unknown,
):
  | (Omit<DemoFlagFixture, "name"> & {
      name: DemoFixtureName | "demo";
      keys: DemoFlagKey[];
    })
  | null;
