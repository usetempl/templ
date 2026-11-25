"use client";

import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

// The visitor widget owns its own scoped session. Only team pages need the
// dashboard wallets, account session, and workspace directory.
const DashboardProviders = dynamic(() => import("./app-shell").then(module => module.DashboardProviders));

export function AppRouteShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (pathname.startsWith("/help/") || pathname.startsWith("/support-entry/"))
    return children;
  return <DashboardProviders>{children}</DashboardProviders>;
}
