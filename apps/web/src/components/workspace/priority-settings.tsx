"use client";

import { canManageWorkspace } from "@templ/chat/moderation-permissions";

import { useEffect, useState, type FormEvent } from "react";
import {
  PRIORITY_COPY,
  PRIORITY_CONTRACT_LIMIT,
  type PrioritySettings,
} from "@templ/chat/support-priority";
import type { ProfileContract } from "@templ/chat/protocol-profile";
import {
  readPrioritySettings,
  savePrioritySettings,
} from "@/lib/support-priority-client";
import { Card, Field, Spinner, ui } from "@/components/ui/ui";
import { inboxNetworkName } from "@/lib/inbox-facts";
import { releasedPriorityAdapter } from "@/lib/priority-scope";
import type { WorkspaceContext } from "./support-workspace";
import styles from "./workspace.module.css";
import { UnsavedChanges } from "./unsaved-changes";

export function WorkspacePrioritySettings({
  context,
}: {
  context: WorkspaceContext;
}) {
  if (
    !canManageWorkspace({
      isManager: context.manager,
      permissions: context.state?.viewer?.permissions,
    }) ||
    context.state?.features?.priorityFeed !== true
  )
    return null;
  return (
    <PrioritySettingsLoader
      key={`${context.room}:${context.account}`}
      context={context}
    />
  );
}

function PrioritySettingsLoader({ context }: { context: WorkspaceContext }) {
  const [loaded, setLoaded] = useState<{
    settings: PrioritySettings;
    contracts: ProfileContract[];
  }>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void readPrioritySettings(context.room, controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) {
          setLoaded(value);
          setError("");
        }
      },
      () => {
        if (!controller.signal.aborted)
          setError("We could not load priority settings. Try again.");
      },
    );
    return () => controller.abort();
  }, [context.room, attempt]);
  if (loaded)
    return (
      <PrioritySettingsForm
        context={context}
        initial={loaded.settings}
        contracts={loaded.contracts}
      />
    );
  return (
    <Card title={PRIORITY_COPY.settings}>
      {error ? (
        <>
          <p role="alert">{error}</p>
          <button
            type="button"
            className="button small secondary"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Try again
          </button>
        </>
      ) : (
        <p role="status">
          <Spinner /> Loading priorities…
        </p>
      )}
    </Card>
  );
}

function PrioritySettingsForm({
  context,
  initial,
  contracts,
}: {
  context: WorkspaceContext;
  initial: PrioritySettings;
  contracts: ProfileContract[];
}) {
  const [settings, setSettings] = useState(initial);
  const [savedSettings, setSavedSettings] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const dirty = JSON.stringify(settings) !== JSON.stringify(savedSettings);
  const available = contracts.filter(releasedPriorityAdapter);
  const qualified = (ref: PrioritySettings["contracts"][number]) =>
    available.some(
      (row) => row.network === ref.network && row.address === ref.address,
    );
  const unverified = settings.contracts.some((ref) => !qualified(ref));
  const edit = (next: PrioritySettings) => {
    setSettings(next);
    setNotice("");
    setError("");
  };
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || !dirty) return;
    if (unverified) {
      setError("Remove unverified contracts before saving.");
      return;
    }
    if (
      !Number.isFinite(settings.topHolderUsd) ||
      !Number.isFinite(settings.largeHolderUsd) ||
      settings.largeHolderUsd <= 0 ||
      settings.topHolderUsd > 1e12 ||
      settings.topHolderUsd <= settings.largeHolderUsd ||
      !Number.isInteger(settings.replyTargetMinutes) ||
      settings.replyTargetMinutes < 1 ||
      settings.replyTargetMinutes > 1440
    ) {
      setError("Use valid amounts. Top deposits must be above Large deposits.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await savePrioritySettings(
        context.room,
        context.account,
        settings,
      );
      setSettings(result.settings);
      setSavedSettings(result.settings);
      setNotice("Priority settings saved.");
    } catch {
      setError("We could not save priority settings. Try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={(event) => void save(event)}>
      <UnsavedChanges dirty={dirty} />
      <Card
        id="priority-settings"
        title={PRIORITY_COPY.settings}
        description="Your team sees app deposits only inside cases."
      >
        <fieldset
          disabled={busy}
          className={styles.formGrid}
          style={{ border: 0, margin: 0, padding: 0 }}
        >
          <div className={styles.formGrid2}>
            <Field label={PRIORITY_COPY.topThreshold}>
              <input
                className={ui.input}
                type="number"
                min={0}
                max={1e12}
                step="any"
                required
                value={settings.topHolderUsd}
                onChange={(event) =>
                  edit({
                    ...settings,
                    topHolderUsd: event.target.valueAsNumber,
                  })
                }
              />
            </Field>
            <Field label={PRIORITY_COPY.largeThreshold}>
              <input
                className={ui.input}
                type="number"
                min={0}
                max={1e12}
                step="any"
                required
                value={settings.largeHolderUsd}
                onChange={(event) =>
                  edit({
                    ...settings,
                    largeHolderUsd: event.target.valueAsNumber,
                  })
                }
              />
            </Field>
          </div>
          <Field label={PRIORITY_COPY.replyTarget}>
            <input
              className={ui.input}
              type="number"
              min={1}
              max={1440}
              step={1}
              required
              value={settings.replyTargetMinutes}
              onChange={(event) =>
                edit({
                  ...settings,
                  replyTargetMinutes: event.target.valueAsNumber,
                })
              }
            />
          </Field>
          <fieldset
            className={styles.stack}
            style={{ border: 0, margin: 0, padding: 0 }}
          >
            <legend>{PRIORITY_COPY.contracts}</legend>
            <p className={styles.muted}>
              Choose your app’s deposit contracts. Wallet token balances do not
              count.
            </p>
            <p className={styles.muted}>
              Priorities supports Ethereum and Base ERC-4626 vaults backed by
              native USDC.
            </p>
            {unverified && (
              <>
                <p role="alert">Some selected contracts are unverified.</p>
                <button
                  type="button"
                  className="button small secondary"
                  onClick={() =>
                    edit({
                      ...settings,
                      contracts: settings.contracts.filter(qualified),
                    })
                  }
                >
                  Remove unverified contracts
                </button>
              </>
            )}
            {available.length === 0 && (
              <p>
                Add a supported vault and its native USDC asset to your app
                profile.
              </p>
            )}
            {available.map((contract) => {
              const selected = settings.contracts.some(
                (item) =>
                  item.network === contract.network &&
                  item.address === contract.address,
              );
              return (
                <label
                  key={`${contract.network}:${contract.address}`}
                  className={ui.check}
                >
                  <input
                    type="checkbox"
                    checked={selected}
                    disabled={
                      !selected &&
                      settings.contracts.length >= PRIORITY_CONTRACT_LIMIT
                    }
                    onChange={(event) =>
                      edit({
                        ...settings,
                        contracts: event.target.checked
                          ? [
                              ...settings.contracts,
                              {
                                network: contract.network,
                                address: contract.address,
                              },
                            ]
                          : settings.contracts.filter(
                              (item) =>
                                item.network !== contract.network ||
                                item.address !== contract.address,
                            ),
                      })
                    }
                  />
                  <span>
                    {contract.label} on {inboxNetworkName(contract.network)}
                  </span>
                </label>
              );
            })}
          </fieldset>
          <div>
            <button
              type="submit"
              className="button secondary"
              disabled={busy || !dirty}
            >
              {busy && <Spinner />}Save priorities
            </button>
          </div>
          {notice && <p role="status">{notice}</p>}
          {error && <p role="alert">{error}</p>}
        </fieldset>
      </Card>
    </form>
  );
}
