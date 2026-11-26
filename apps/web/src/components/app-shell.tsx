"use client";

import { useEffect, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  IconKey,
  IconLayoutGrid,
  IconMessageCircle,
  IconPlus,
} from "@tabler/icons-react";
import { ChatAuthProvider, useChatAuth } from "@/lib/chat-auth";
import { chatHref, normalizeChatRoomId } from "@/lib/chat-room-id";
import { CommunityDirectoryProvider, useCommunityDirectory } from "@/lib/community-directory";
import { WalletProvider } from "@/lib/wallet";
import { nativeRoomHref } from "@/lib/native-room";
import { SiteFrame } from "./site-frame";
import { TemplSupport } from "./templ-support";
import {
  AppFrame,
  RailNavGroup,
  RailNavItem,
  WorkspaceMark,
} from "./workspace/app-frame";

/** Top-level routes. Any other single segment is a workspace vanity path. */
const ROUTES = new Set([
  "admin",
  "agents",
  "alerts",
  "analytics",
  "api",
  "availability",
  "billing",
  "chat",
  "chief",
  "community",
  "connect",
  "create",
  "dpa",
  "explore",
  "feedback",
  "example",
  "help",
  "support-entry",
  "inbox",
  "llms.txt",
  "og",
  "preview",
  "privacy",
  "robots.txt",
  "rooms",
  "safety",
  "settings",
  "sitemap.xml",
  "status",
  "terms",
  "trust",
]);
const PUBLIC_PAGES = new Set([
  "/chief",
  "/privacy",
  "/terms",
  "/dpa",
  "/safety",
  "/trust",
  "/availability",
  "/agents",
  "/status",
  "/alerts",
]);

function appTitle(pathname: string) {
  if (pathname.startsWith("/create")) return "New workspace";
  if (pathname.startsWith("/settings")) return "Account";
  if (pathname.startsWith("/billing")) return "Billing";
  if (pathname.startsWith("/admin")) return "Operator";
  return "Workspaces";
}

export function DashboardProviders({ children }: { children: ReactNode }) {
  return (
    <WalletProvider>
      <ChatAuthProvider>
        <CommunityDirectoryProvider><AppShell>{children}</AppShell></CommunityDirectoryProvider>
      </ChatAuthProvider>
    </WalletProvider>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  useEffect(() => {
    const openChat = (event: Event) => {
      const detail = (event as CustomEvent<{ room: string; channel: string }>)
        .detail;
      try {
        if (!detail || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(detail.channel))
          return;
        router.push(
          `${chatHref(normalizeChatRoomId(detail.room))}?channel=${encodeURIComponent(detail.channel)}`,
        );
      } catch {
        /* Ignore invalid notification targets. */
      }
    };
    window.addEventListener("templ:navigate-chat", openChat);
    return () => window.removeEventListener("templ:navigate-chat", openChat);
  }, [router]);
  const segments = pathname.split("/").filter(Boolean);
  const publicPage = PUBLIC_PAGES.has(pathname);
  // Workspaces render their own frame: the team's rail or a member's thread.
  const workspace =
    pathname.startsWith("/inbox/") ||
    pathname.startsWith("/rooms/") ||
    pathname.startsWith("/chat/") ||
    (segments.length === 1 && !ROUTES.has(segments[0]));
  const supportPage =
    pathname.startsWith("/example/");
  if (supportPage)
    return (
      <main id="main-content" tabIndex={-1}>
        {children}
      </main>
    );
  return (
    <>
      <TemplSupport showLauncher={pathname === "/create"} />
      {pathname.startsWith("/connect/") ? (
        <main id="main-content" tabIndex={-1}>
          {children}
        </main>
      ) : publicPage ? (
        <SiteFrame>{children}</SiteFrame>
      ) : workspace ? (
        children
      ) : (
        <AppFrame title={appTitle(pathname)} rail={<DefaultRail />}>
          {children}
        </AppFrame>
      )}
    </>
  );
}

function DefaultRail() {
  const pathname = usePathname();
  const auth = useChatAuth();
  const directory = useCommunityDirectory();
  const workspaces = directory.joined.filter((item) => item.nativeRoom);
  return (
    <>
      <RailNavGroup>
        <RailNavItem
          icon={IconLayoutGrid}
          label="Workspaces"
          href="/inbox"
          active={pathname === "/inbox"}
        />
        <RailNavItem
          icon={IconPlus}
          label="New workspace"
          href="/create"
          active={pathname === "/create"}
        />
      </RailNavGroup>
      {workspaces.length > 0 && (
        <RailNavGroup label="Your workspaces">
          {workspaces.slice(0, 8).map((item) => (
            <RailNavItem
              key={item.nativeRoom.id}
              icon={IconMessageCircle}
              leading={
                <WorkspaceMark
                  name={item.nativeRoom.name}
                  image={item.nativeRoom.image}
                />
              }
              label={item.nativeRoom.name}
              href={nativeRoomHref(item.nativeRoom)}
            />
          ))}
        </RailNavGroup>
      )}
      {auth.session && (
        <RailNavGroup label="Account">
          <RailNavItem
            icon={IconKey}
            label="Wallets and email"
            href="/settings/account"
            active={pathname.startsWith("/settings")}
          />
        </RailNavGroup>
      )}
    </>
  );
}
