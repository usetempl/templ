export const supportStorageKey = (kind: string, workspace: string) => `templ:support-${kind}:v1:${workspace}`;

/** Cached tabs and remembered wallets have their own restoration
 * rules. Unreadable storage also keeps the usual restoration order. */
export function ordinaryGuestReturn(workspace: string) {
  try {
    if (localStorage.getItem(supportStorageKey("member", workspace))) return false;
    const tab = sessionStorage.getItem(supportStorageKey("tab", workspace));
    if (!tab) return true;
    const saved = JSON.parse(tab);
    return (saved?.l === "anonymous" || saved?.l === "connected") &&
      typeof saved.e === "number" && saved.e > 0 && saved.e <= Date.now();
  } catch {
    return false;
  }
}
