"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { immutableRelease } from "./release-immutable";
import { BUILD_RELEASE } from "./release-public";
import { type ReleaseConfiguration } from "./release-configuration";
import { refreshedReleaseConfiguration } from "./release-refresh";

const ReleaseContext = createContext<ReleaseConfiguration | null>(null);

export function ReleaseProvider({
  configuration,
  children,
}: {
  configuration: ReleaseConfiguration;
  children: ReactNode;
}) {
  const [current, setCurrent] = useState(configuration);
  useEffect(() => {
    setCurrent((previous) =>
      configuration.unavailable &&
      previous.activationDigest !== null &&
      refreshedReleaseConfiguration(previous, configuration.web)
        ? previous
        : configuration,
    );
  }, [configuration]);
  useEffect(() => {
    if (!configuration.web) return;
    let active = true;
    let request: AbortController | undefined;
    const refresh = async () => {
      if (request || document.visibilityState === "hidden") return;
      request = new AbortController();
      const timer = setTimeout(() => request?.abort(), 10_000);
      try {
        const response = await fetch("/api/release-configuration", {
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          signal: request.signal,
        });
        if (!response.ok) return;
        const body = await response.text();
        if (new TextEncoder().encode(body).length > 65_536) return;
        const next = refreshedReleaseConfiguration(
          JSON.parse(body),
          configuration.web,
        );
        if (active && next)
          setCurrent((previous) =>
            previous.activationDigest === next.activationDigest
              ? previous
              : next,
          );
      } catch {
        // A failed read grants nothing. The worker validates each support request.
      } finally {
        clearTimeout(timer);
        request = undefined;
      }
    };
    const recover = () => void refresh();
    if (!current.release.templSupport?.verified) recover();
    const timer = !current.release.templSupport?.verified
      ? setInterval(recover, 30_000)
      : undefined;
    window.addEventListener("focus", recover);
    document.addEventListener("visibilitychange", recover);
    return () => {
      active = false;
      clearInterval(timer);
      request?.abort();
      window.removeEventListener("focus", recover);
      document.removeEventListener("visibilitychange", recover);
    };
  }, [configuration.web, current.release.templSupport?.verified]);
  const value = useMemo(
    () => immutableRelease(structuredClone(current)),
    [current],
  );
  return (
    <ReleaseContext.Provider value={value}>{children}</ReleaseContext.Provider>
  );
}

/** A missing provider closes production features. It never guesses activation. */
export function useRelease() {
  return useContext(ReleaseContext)?.release ?? BUILD_RELEASE;
}
