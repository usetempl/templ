"use client";

import { useEffect, useState } from "react";
import { browserBlocksStatistics, statisticsPreference } from "@/lib/analytics";

export function SiteStatisticsPreference() {
  const [allowed, setAllowed] = useState(false);
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    function refresh() {
      try {
        const available =
          !browserBlocksStatistics() &&
          localStorage.getItem("plausible_ignore") !== "true";
        setAvailable(available);
        setAllowed(
          available && localStorage.getItem(statisticsPreference) === "yes",
        );
      } catch {
        setAvailable(false);
        setAllowed(false);
      }
    }
    refresh();
    window.addEventListener("storage", refresh);
    return () => window.removeEventListener("storage", refresh);
  }, []);
  return (
    <label>
      <input
        type="checkbox"
        checked={allowed}
        disabled={!available}
        onChange={(event) => {
          const checked = event.currentTarget.checked;
          try {
            if (checked) localStorage.setItem(statisticsPreference, "yes");
            else localStorage.removeItem(statisticsPreference);
            setAllowed(checked);
          } catch {
            setAvailable(false);
            setAllowed(false);
          }
        }}
      />{" "}
      Allow site statistics on this browser
    </label>
  );
}
