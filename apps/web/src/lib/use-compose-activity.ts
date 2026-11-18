"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { SUPPORT_LIMITS } from "@templ/chat/support";

/** Human compose presence expires after input stops, and ends on blur. */
export function useComposeActivity(thread?: string) {
  const scope = useMemo(() => ({ thread }), [thread]);
  const [current, setCurrent] = useState<typeof scope>();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), [thread]);
  return {
    active: Boolean(thread && current === scope),
    input() {
      clearTimeout(timer.current);
      setCurrent(scope);
      timer.current = setTimeout(
        () => setCurrent(undefined),
        SUPPORT_LIMITS.composeIdleMs,
      );
    },
    blur() {
      clearTimeout(timer.current);
      setCurrent(undefined);
    },
  };
}
