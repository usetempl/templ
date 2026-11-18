import { communityFetch } from "./community-client";
import { isNativeRoomId } from "./native-room";
import type { ChatPrincipalId } from "@templ/chat/principal";

export type ConnectRequest = {
  code: string;
  appName?: string;
  origins: string[];
  expiresAt: number;
  status: "pending" | "approved" | "denied" | "expired";
  createAllowed: boolean;
};
export type ConnectWorkspace = { id: string; name: string };
export type ConnectWorkspacePage = {
  workspaces: ConnectWorkspace[];
  cursor: string | null;
};
export const isConnectCode = (code: string) =>
  /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(code);

function connectPath(code: string) {
  if (!isConnectCode(code))
    throw new Error(
      "This connect code is invalid. Ask your AI tool for a new link.",
    );
  return `/connect/${code}`;
}

function validOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      url.origin === value &&
      url.protocol === "https:"
    );
  } catch {
    return false;
  }
}

export async function readConnectRequest(
  code: string,
  signal?: AbortSignal,
): Promise<ConnectRequest> {
  const value = await communityFetch<Partial<ConnectRequest>>(
    connectPath(code),
    undefined,
    signal,
  );
  if (
    value.code !== code ||
    !Array.isArray(value.origins) ||
    value.origins.length === 0 ||
    value.origins.length > 10 ||
    !value.origins.every(validOrigin) ||
    (value.appName !== undefined &&
      (typeof value.appName !== "string" ||
        !value.appName.trim() ||
        value.appName.length > 80)) ||
    !Number.isSafeInteger(value.expiresAt) ||
    !["pending", "approved", "denied", "expired"].includes(
      value.status ?? "",
    ) ||
    typeof value.createAllowed !== "boolean"
  )
    throw new Error(
      "This app request could not be checked. Ask your AI tool for a new link.",
    );
  return {
    code,
    origins: value.origins,
    expiresAt: value.expiresAt!,
    status: value.status!,
    createAllowed: value.createAllowed,
    ...(value.appName ? { appName: value.appName } : {}),
  };
}

export async function readConnectWorkspaces(
  code: string,
  cursor?: string,
): Promise<ConnectWorkspacePage> {
  const value = await communityFetch<Partial<ConnectWorkspacePage>>(
    `${connectPath(code)}/workspaces${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
  );
  if (
    !Array.isArray(value.workspaces) ||
    value.workspaces.some(
      (workspace) =>
        !workspace ||
        !isNativeRoomId(workspace.id) ||
        typeof workspace.name !== "string" ||
        !workspace.name.trim() ||
        workspace.name.length > 80,
    ) ||
    (value.cursor !== null &&
      (typeof value.cursor !== "string" ||
        value.cursor.length === 0 ||
        value.cursor.length > 200))
  )
    throw new Error("Your workspaces could not be checked. Try again.");
  return {
    workspaces: value.workspaces.map(({ id, name }) => ({ id, name })),
    cursor: value.cursor,
  };
}

export async function approveConnectRequest(
  code: string,
  principalId: ChatPrincipalId,
  target: { workspaceId: string } | { name: string },
): Promise<void> {
  const value = await communityFetch<{ workspaceId?: string }>(
    `${connectPath(code)}/approve`,
    { expectedPrincipalId: principalId, confirmed: true, ...target },
  );
  if (!value || !isNativeRoomId(value.workspaceId ?? ""))
    throw new Error(
      "The app confirmation could not be checked. Ask your AI tool to check its status.",
    );
}

export async function denyConnectRequest(
  code: string,
  principalId: ChatPrincipalId,
): Promise<void> {
  await communityFetch(`${connectPath(code)}/deny`, {
    expectedPrincipalId: principalId,
    confirmed: true,
  });
}
