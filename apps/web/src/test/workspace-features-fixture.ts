import {
  WORKSPACE_FLAG_KEYS,
  type WorkspaceFeatures,
} from "@templ/chat/workspace-flags";

/** All workspace features start off; tests turn on only the features they need. */
export function workspaceFeaturesFixture(
  patch: Partial<WorkspaceFeatures> = {},
): WorkspaceFeatures {
  return {
    ...(Object.fromEntries(
      WORKSPACE_FLAG_KEYS.map((key) => [key, false]),
    ) as WorkspaceFeatures),
    ...patch,
  };
}
