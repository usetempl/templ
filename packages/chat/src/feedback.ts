import type { ChatPrincipalId } from "./principal";

/** Private support data; never part of a community directory or public channel. */
export type FeedbackMessage = {
  id: string;
  text: string;
  author: "member" | "team";
  createdAt: number;
};
export type FeedbackTicketSummary = {
  id: string;
  subject: string;
  status: "open" | "resolved";
  createdAt: number;
  updatedAt: number;
};
/** Delivery state of one team-reply notification; present only for Templ operators. */
export type FeedbackNotification = {
  messageId: string;
  state: "queued" | "sending" | "sent" | "failed";
  /** Opaque provider message id; never a recipient, subject or body. */
  providerMessageId: string | null;
  attempts: number;
};
export type FeedbackTicket = FeedbackTicketSummary & {
  messages: FeedbackMessage[];
  before: string | null;
  notifications?: FeedbackNotification[];
};
export type FeedbackTicketList = {
  principalId: ChatPrincipalId;
  tickets: FeedbackTicketSummary[];
  cursor: string | null;
};
export type FeedbackTicketResponse = {
  principalId: ChatPrincipalId;
  ticket: FeedbackTicket;
};
export type FeedbackStatus = {
  available: boolean;
  emailRequired: true;
  isAdmin: boolean;
  /** Present only for authorized Templ operators. */
  failedNotifications?: number;
};
export type FeedbackAccount = {
  principalId: ChatPrincipalId;
  emailVerified: boolean;
  emailMasked: string | null;
  wallet: `0x${string}` | null;
};
