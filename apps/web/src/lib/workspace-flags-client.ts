import {
  WORKSPACE_FEATURES,
  WORKSPACE_FLAG_KEYS,
  type WorkspaceFlagKey,
} from "@templ/chat/workspace-flags";
import { communityFetch } from "./community-client";

export type WorkspaceFlagRow = {
  key: WorkspaceFlagKey;
  until: string;
  operator: string;
  reason: string;
};
export type WorkspaceFlagsIndex = {
  workspaces: { workspace: string; flags: WorkspaceFlagRow[] }[];
  next?: string | null;
};
export async function readOperatorFlags(
  signal?: AbortSignal,
): Promise<WorkspaceFlagsIndex> {
  const workspaces: WorkspaceFlagsIndex["workspaces"] = [];
  let next: string | null = null;
  do {
    const path: string = next
      ? `/operator/flags?after=${encodeURIComponent(next)}`
      : "/operator/flags";
    const page: WorkspaceFlagsIndex = await communityFetch(
      path,
      undefined,
      signal,
    );
    workspaces.push(...page.workspaces);
    next = page.next ?? null;
  } while (next);
  return { workspaces, next: null };
}
export const setWorkspaceFlag = (input: {
  workspace: string;
  key: WorkspaceFlagKey;
  on: boolean;
  until: string;
  reason: string;
}) => communityFetch("/operator/flags", input);
export const WORKSPACE_FEATURE_NAMES = Object.fromEntries(
  WORKSPACE_FLAG_KEYS.map((key) => [key, WORKSPACE_FEATURES[key].name]),
) as Record<WorkspaceFlagKey, string>;
