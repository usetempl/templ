import {
  DEFAULT_CHAT_AUTH_CHAIN_ID,
  isChatChainId,
  type ChatChainId,
} from "@templ/chat/chains";
import { HttpError } from "./common";

/** The selected signing chain is part of the exact server-issued SIWE message. */
export function walletAuthChain(
  value: unknown = DEFAULT_CHAT_AUTH_CHAIN_ID,
): ChatChainId {
  if (!isChatChainId(value))
    throw new HttpError(400, "Choose a supported wallet network.");
  return value;
}
