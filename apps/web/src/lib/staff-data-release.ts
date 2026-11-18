import type { PublicRelease } from "./release-public";

/** Public release flags control the staff surfaces, without granting access. */
export function staffDataFlags(release: PublicRelease) {
  const flag = (name: string) =>
    (release as unknown as Record<string, unknown>)[name] === true;
  return {
    incidentNotices: flag("incidentNoticesVerified"),
    workspaceDeletion: flag("workspaceDeletionVerified"),
    readLog: flag("supportWorkflowVerified"),
  };
}
