export type NativeTelegramScope = { workspaceId: string; approvalId: string };
export type NativeTelegramGrant = NativeTelegramScope & {
  relayPrincipalId: string;
  relayNonce?: string;
};
export type NativeTelegramRelayRotation = NativeTelegramGrant & {
  nextRelayNonce: string;
};
export type NativeTelegramRelayReplacement = NativeTelegramGrant & {
  previousRelayPrincipalId: string;
  previousRelayNonce?: string;
  bindingDigest: string;
};
export type NativeTelegramDisconnect = NativeTelegramGrant & {
  previousRelayPrincipalId?: string;
  previousRelayNonce?: string;
  bindingDigest?: string;
};
export type NativeTelegramPrepared = {
  relayPrincipalId: string;
  code: string;
  expiresAt: number;
  invite: string | null;
};
export type NativeTelegramBridgeView = {
  relayPrincipalId: string;
  linked: boolean;
  group: string | null;
  expiresAt: number | null;
};
export type AppAnswerRequest = {
  workspaceId: string;
  conversationId: string;
  jobId: string;
  revision: number;
  ifLatest: { messageId: string; revision: number };
  expiresAt: number;
};
export type NativeTelegramBridge = {
  queueAppAnswer?(input: AppAnswerRequest): Promise<{ queued: boolean }>;
  prepare(scope: NativeTelegramScope): Promise<NativeTelegramPrepared>;
  prepareRelayRotation(scope: NativeTelegramRelayRotation): Promise<{
    relayPrincipalId: string;
    group: string;
    bindingDigest: string;
  }>;
  rotateRelay(
    scope: NativeTelegramRelayReplacement,
  ): Promise<NativeTelegramBridgeView>;
  approve(scope: NativeTelegramGrant): Promise<NativeTelegramBridgeView>;
  status(scope: NativeTelegramGrant): Promise<NativeTelegramBridgeView>;
  disconnect(scope: NativeTelegramDisconnect): Promise<{ removed: boolean }>;
  handoff(
    scope: NativeTelegramGrant & {
      conversationId: string;
      eventId: string;
      handoffAt: string;
    },
  ): Promise<{ queued: boolean }>;
};
export type NativeTelegramView = {
  available: boolean;
  status:
    | "disconnected"
    | "preparing"
    | "pairing"
    | "approving"
    | "active"
    | "paused";
  approvalId: string | null;
  code: string | null;
  expiresAt: number | null;
  invite: string | null;
  group: string | null;
};
