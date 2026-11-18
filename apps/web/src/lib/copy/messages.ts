import { landing } from "./landing";
import { shell } from "./shell";
import { room } from "./room";
import { phone } from "./phone";

/** Shared English copy, grouped by the surface that uses it. */
export const messages = { ...landing, ...shell, ...room, ...phone } as const;
export type MessageKey = keyof typeof messages;
