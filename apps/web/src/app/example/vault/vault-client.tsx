"use client";

import { useRelease } from "@/lib/release-context";
import { useEffect, useRef, useState } from "react";
import { TemplMark } from "@/components/brand/templ-mark";
import { loadTemplSupportWidget } from "@/lib/templ-support";
import { supportPageWallet } from "@/lib/support-page-wallet";
import type { mountSupportWidget } from "@/lib/support-widget";
import type { SupportContextInput } from "@templ/chat/support";
import { SITE } from "@/lib/site-environment";
import { trackEvent } from "@/lib/analytics";
import { widgetSignInNetworks } from "@/lib/support-availability";
import { exampleInstallWorkspace } from "@/lib/example-install-fixture";
import type { ServingReleaseIdentity } from "@templ/chat/support-install-fixture";
import {
  EXAMPLE_VAULT_HEADER,
  EXAMPLE_VAULT_NETWORKS,
  EXAMPLE_VAULT_SCENARIOS,
  exampleFailure,
  type ExampleNetwork,
  type ExampleScenario,
} from "@/lib/example-vault";
import styles from "./vault.module.css";

type Widget = ReturnType<typeof mountSupportWidget>;
export function ExampleVault({
  workspace,
  nonce,
  pageIdentity,
}: {
  workspace: string;
  nonce?: string;
  pageIdentity?: ServingReleaseIdentity;
}) {
  const WIDGET_SIGN_IN_NETWORKS = widgetSignInNetworks(useRelease());

  const [network, setNetwork] = useState<ExampleNetwork>(
    WIDGET_SIGN_IN_NETWORKS[0],
  );
  const [scenario, setScenario] = useState<ExampleScenario>("rejected");
  const [result, setResult] = useState<SupportContextInput>();
  const [chat, setChat] = useState<"loading" | "ready" | "failed">("loading");
  const [retry, setRetry] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const widget = useRef<Widget | null>(null);
  const currentNetwork = useRef(network);
  const pending = useRef<SupportContextInput | undefined>(undefined);
  useEffect(() => {
    trackEvent("example_vault_view");
  }, []);
  useEffect(() => {
    let disposed = false;
    let mounted: Widget | undefined;
    let resolved = false;
    const fixturePreview = new URLSearchParams(location.hash.slice(1)).has(
      "templ-fixture",
    );
    const controller = new AbortController();
    void exampleInstallWorkspace({
      workspace,
      hash: location.hash,
      pageIdentity,
      signal: controller.signal,
    })
      .then(async (resolvedWorkspace) => {
        if (disposed) return;
        resolved = true;
        const widgetModule = await loadTemplSupportWidget();
        if (disposed) return;
        mounted = widgetModule.mountSupportWidget({
          workspace: resolvedWorkspace,
          apiUrl: SITE.community,
          wallet: supportPageWallet(currentNetwork.current),
          styleNonce: nonce,
          label: "Example Vault support",
          appearance: { theme: "dark", accent: "#2854c5" },
        });
        widget.current = mounted;
        if (pending.current) mounted.captureFailure(pending.current);
        setChat("ready");
      })
      .catch(() => {
        if (disposed) return;
        setChat("failed");
        if (fixturePreview && !resolved) {
          trackEvent("install_check_failed");
          console.warn("TEMPL_INSTALL_CHECK_FAILED", {
            cause: "fixture-unavailable",
          });
          return;
        }
        trackEvent("example_support_failed");
        console.warn(
          JSON.stringify({
            event: "TEMPL_SUPPORT_FAILURE",
            route: "example-vault",
            reason: "widget-load",
          }),
        );
      });
    return () => {
      disposed = true;
      controller.abort();
      mounted?.destroy();
      widget.current = null;
    };
  }, [workspace, nonce, retry, pageIdentity]);
  function chooseNetwork(next: ExampleNetwork) {
    currentNetwork.current = next;
    setNetwork(next);
    widget.current?.setWallet(supportPageWallet(next));
    trackEvent("example_network_changed");
  }
  function run(action: "deposit" | "withdraw") {
    const failure = exampleFailure(network, scenario, action);
    pending.current = failure;
    setResult(failure);
    widget.current?.captureFailure(failure);
    trackEvent(
      action === "deposit"
        ? "example_deposit_clicked"
        : "example_withdraw_clicked",
    );
  }
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <TemplMark className={styles.stamp} decorative />
        <h1>Example Vault</h1>
        <p>{EXAMPLE_VAULT_HEADER}</p>
      </header>
      <section className={styles.vault} aria-label="Try a support scenario">
        {WIDGET_SIGN_IN_NETWORKS.length > 1 && (
          <div className={styles.tabs} role="group" aria-label="Network">
            {WIDGET_SIGN_IN_NETWORKS.map((id) => (
              <button
                key={id}
                type="button"
                aria-pressed={network === id}
                onClick={() => chooseNetwork(id)}
              >
                {EXAMPLE_VAULT_NETWORKS[id]}
              </button>
            ))}
          </div>
        )}
        <label className={styles.field}>
          Scenario
          <select
            value={scenario}
            onChange={(event) => {
              setScenario(event.target.value as ExampleScenario);
              trackEvent("example_scenario_changed");
            }}
          >
            {Object.entries(EXAMPLE_VAULT_SCENARIOS).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <div className={styles.actions}>
          <button
            className="button"
            type="button"
            onClick={() => run("deposit")}
          >
            Deposit
          </button>
          <button
            className="button quiet"
            type="button"
            onClick={() => run("withdraw")}
          >
            Withdraw
          </button>
        </div>
        {result && (
          <div className={styles.result} role="status">
            <strong>Scenario result</strong>
            <p>{result.app?.error?.message}</p>
            <p>Open support to choose which details to share.</p>
          </div>
        )}
        {chat === "failed" ? (
          <div className={styles.notice} role="alert">
            <p>Support could not load. Your scenario is still here.</p>
            <button
              className="button quiet"
              type="button"
              onClick={() => {
                setChat("loading");
                setRetry(!retry);
              }}
            >
              Try loading support again
            </button>
          </div>
        ) : chat === "loading" ? (
          <p className={styles.notice} role="status">
            Loading support…
          </p>
        ) : (
          <>
            <button
              className="button quiet"
              type="button"
              onClick={() => {
                // Support failing to open never breaks the page.
                try {
                  widget.current?.open();
                  setOpenFailed(false);
                  trackEvent("example_support_opened");
                } catch {
                  setOpenFailed(true);
                }
              }}
            >
              Open support
            </button>
            {openFailed && (
              <p className={styles.notice} role="alert">
                Support couldn&apos;t open. Try again.
              </p>
            )}
          </>
        )}
      </section>
    </div>
  );
}
