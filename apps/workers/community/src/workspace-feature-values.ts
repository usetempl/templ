import {
  WORKSPACE_FLAG_KEYS,
  type WorkspaceFeatures,
} from "@templ/chat/workspace-flags";
import { HttpError } from "./common";

/** An absent feature grants nothing when edge and object schemas differ. */
export function workspaceFeatureSnapshot(value: unknown): WorkspaceFeatures {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.values(value).some((enabled) => typeof enabled !== "boolean")
  )
    throw new HttpError(503, "The feature list could not be read.");
  const values = value as Record<string, boolean>;
  return Object.fromEntries(
    WORKSPACE_FLAG_KEYS.map((key) => [
      key,
      Object.hasOwn(values, key) ? values[key] : false,
    ]),
  ) as WorkspaceFeatures;
}
