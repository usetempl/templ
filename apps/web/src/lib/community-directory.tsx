"use client";

import { createContext, useContext, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import type { Address } from "viem";
import type { ChatRoomId, NativeRoom } from "@templ/chat/index";
import type { ChatPrincipalId } from "@templ/chat/principal";
import { useChatAuth } from "./chat-auth";
import { useChatSubscriptions } from "./chat-subscriptions";

export type DirectoryCommunity = {
  address: ChatRoomId;
  tokenAddress: Address;
  creator: ChatPrincipalId;
  name: string;
  symbol: string;
  image?: string;
  isMember: boolean;
  nativeRoom: NativeRoom;
};
type Directory = {
  joined: DirectoryCommunity[];
  joinedLoading: boolean;
  joinedError?: string;
  refresh: () => Promise<void>;
  loadMoreJoined: () => Promise<void>;
  hasMoreJoined: boolean;
};
const DirectoryContext = createContext<Directory | null>(null);

/** Workspaces the signed-in account follows. */
export function CommunityDirectoryProvider({
  children,
}: {
  children: ReactNode;
}) {
  const account = useChatAuth().session?.principalId;
  const pathname = usePathname();
  const enabled = pathname !== "/";
  const subscriptions = useChatSubscriptions(account, enabled);
  return (
    <DirectoryContext.Provider
      value={{
        joined: subscriptions.items,
        joinedLoading: Boolean(account) && subscriptions.loading,
        joinedError: subscriptions.error,
        refresh: async () => {
          subscriptions.refresh();
        },
        loadMoreJoined: subscriptions.loadMore,
        hasMoreJoined: subscriptions.hasMore,
      }}
    >
      {children}
    </DirectoryContext.Provider>
  );
}

export function useCommunityDirectory() {
  const value = useContext(DirectoryContext);
  if (!value) throw new Error("CommunityDirectoryProvider is missing.");
  return value;
}
