/** Failure rows stay frozen in this lazy chunk until the member shares them. */
import type {
  SupportContextInput,
  SupportFailureCapture,
  SupportFailureSnapshot,
  SupportTransaction,
} from "@templ/chat/support";
import type { SupportAppContext } from "@templ/chat/support-app-context";
import { SUPPORT_CONTEXT_LIMITS } from "@templ/chat/support-context";
import { SUPPORT_IDENTITY_LABELS } from "@templ/chat/support-identity";
import type { CardHost, ContextCard } from "./support-widget";

declare const __TEMPL_WIDGET_CONTEXT__: string | undefined;
const loadContext = (): Promise<typeof import("./support-widget-context")> =>
  typeof __TEMPL_WIDGET_CONTEXT__ === "string"
    ? import(
        /* webpackIgnore: true */ /* turbopackIgnore: true */ new globalThis.URL(
          __TEMPL_WIDGET_CONTEXT__,
          import.meta.url,
        ).href
      )
    : import("./support-widget-context");
type CaptureState = Pick<SupportFailureSnapshot, "wallet" | "network">;
export type WalletState =
  | { address: string; level?: string; chainId?: number; network?: string }
  | undefined;
const stateOf = (state: WalletState): CaptureState => ({
  wallet: {
    level:
      state?.level === "signed"
        ? "verified"
        : state?.address
          ? "attached"
          : "guest",
    ...(state?.address ? { address: state.address } : {}),
  },
  ...(state?.chainId
    ? { network: `eip155:${state.chainId}` as const }
    : state?.address
      ? { network: "solana" as const }
      : {}),
});
export type Capture = {
  input: SupportContextInput;
  state: Promise<WalletState>;
  capturedAt: string;
  sdk: NonNullable<SupportFailureSnapshot["sdk"]>;
  reported?: SupportFailureCapture;
  diagnostics?: () => Promise<{ diagnostics?: boolean }>;
};
export type FailureRow = {
  label: string;
  value: string;
  preview?: string;
  pick: (into: SupportFailureSnapshot) => void;
  checked?: boolean;
  unticked?: boolean;
  shared?: boolean;
  pending?: boolean;
};
type Held = {
  snapshot: SupportFailureSnapshot;
  state: CaptureState;
  rows: FailureRow[];
};
const freeze = <T>(value: T): T => {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const item of Object.values(value)) freeze(item);
  }
  return value;
};
export async function card(widget: CardHost): Promise<ContextCard> {
  const loaded = await loadContext();
  const [inner, tools] = await Promise.all([
    loaded.card(widget),
    loaded.details(),
  ]);
  const { el } = widget;
  const section = el("div", undefined, "card failure-card");
  section.setAttribute("aria-label", "Failure snapshots");
  section.hidden = true;
  const now = el("b", "Now");
  now.hidden = true;
  widget.card.before(section, now);
  let held: Held[] = [];
  let captureRevision = 0;
  let live: CaptureState | undefined;
  let available = true;
  const controls = loaded.failureControls(widget, section, now, inner);
  function render() {
    const offered = available
      ? held.filter(
          (entry) =>
            entry.rows.some((row) => !row.shared) &&
            !entry.rows.some((row) => row.pending),
        )
      : [];
    section.hidden = !offered.length;
    controls.render(
      [...offered].reverse().map(({ snapshot, state, rows }) => ({
        id: snapshot.id,
        capturedAt: tools.utcTime(snapshot.capturedAt),
        failureAt: tools.utcTime(snapshot.failure?.at ?? snapshot.capturedAt),
        rows,
        changed:
          !!live &&
          (state.wallet.address !== live.wallet.address ||
            state.network !== live.network),
      })),
    );
  }
  return {
    ...inner,
    ...controls.card,
    available(next) {
      inner.available?.(next);
      if (available === next) return;
      available = next;
      for (const entry of held)
        for (const row of entry.rows)
          row.checked = next && !row.unticked && !row.shared && !row.pending;
      render();
    },
    /** Freezes one failure. Only `failure.kind` is required; any other
     * detail Templ can't read is left out with a console warning, and the
     * rest are kept. */
    async capture(capture: Capture) {
      const revision = captureRevision;
      const { input, capturedAt, sdk } = capture;
      let state = stateOf(await capture.state);
      if (revision !== captureRevision) return;
      if (capture.reported) {
        const { wallet } = capture.reported;
        if (
          typeof capturedAt !== "string" ||
          capturedAt.length > 40 ||
          !/^\d{4}-\d{2}-\d{2}T/.test(capturedAt) ||
          !Number.isFinite(Date.parse(capturedAt)) ||
          (wallet !== null &&
            (!wallet ||
              (wallet.network === "evm"
                ? !/^0x[0-9a-f]{40}$/.test(wallet.address) ||
                  wallet.address === `0x${"0".repeat(40)}` ||
                  typeof wallet.chainId !== "number" ||
                  !tools.rules.parseSupportNetwork(`eip155:${wallet.chainId}`)
                : wallet.network !== "solana" ||
                  ("chainId" in wallet && wallet.chainId !== undefined) ||
                  !tools.rules.isSolanaAddress(wallet.address))))
        )
          throw new Error(
            "Share a valid failure time and app-reported wallet.",
          );
        state = stateOf(wallet ? { ...wallet, level: "connected" } : undefined);
      }
      const warn = (field: string) =>
        console.warn(
          `Templ support: left out an invalid failure detail, ${field}.`,
        );
      const parse = (field: string, value: unknown) => {
        try {
          return tools.parseAppContext({ [field]: value }, tools.rules);
        } catch {
          return undefined;
        }
      };
      const allowed = await tools.allowDiagnostics(
        capture.diagnostics,
        widget.policy,
      );
      const given: Record<string, unknown> = {
        ...(allowed ? tools.diagnostics() : {}),
        ...input.app,
      };
      if (revision !== captureRevision) return;
      if (!allowed)
        for (const field of tools.diagnosticFields) delete given[field];
      const reported = given.failure as Record<string, unknown> | undefined;
      delete given.failure;
      delete given.sdk;
      const app: SupportAppContext = {};
      for (const [field, value] of Object.entries(given))
        if (value !== undefined && value !== null && value !== "") {
          const checked = parse(field, value);
          if (checked) Object.assign(app, checked);
          else warn(field);
        }
      const failure = parse("failure", { kind: reported?.kind })?.failure;
      if (!failure) throw new Error("Share a failure kind from the app.");
      for (const [key, value] of Object.entries(reported!))
        if (key !== "kind" && value !== undefined) {
          const checked = parse("failure", {
            kind: failure.kind,
            [key]: value,
          })?.failure;
          if (checked) Object.assign(failure, checked);
          else warn(`failure.${key}`);
        }
      failure.at ??= capturedAt;
      const network =
        tools.rules.parseSupportNetwork(
          input.network ??
            (input.chainId ? `eip155:${input.chainId}` : state.network),
        ) ?? undefined;
      const transactions: SupportTransaction[] = [];
      for (const value of [
        ...(input.transactionHash ? [{ hash: input.transactionHash }] : []),
        ...(input.transactions ?? []),
      ]) {
        const tx = tools.rules.parseTransactionReference(
          value.hash,
          ("network" in value
            ? tools.rules.parseSupportNetwork(value.network)
            : undefined) ?? network,
        );
        if (transactions.some((held) => held.hash === tx?.hash)) continue;
        if (tx && transactions.length < SUPPORT_CONTEXT_LIMITS.transactions)
          transactions.push(tx);
        else warn("transaction");
      }
      const snapshot = freeze({
        ...(transactions.length ? { transactions } : {}),
        id: crypto.randomUUID(),
        capturedAt,
        wallet: state.wallet,
        ...(network ? { network } : {}),
        ...(Object.keys(app).length ? { app } : {}),
        failure,
        sdk,
      });
      const rows: FailureRow[] = [];
      const add = (
        label: string,
        value: string,
        pick: FailureRow["pick"],
        preview?: string,
      ) =>
        rows.push({
          label,
          value,
          pick,
          ...(preview ? { preview } : {}),
          checked: true,
        });
      if (state.wallet.address)
        add(
          "Wallet",
          `${SUPPORT_IDENTITY_LABELS[state.wallet.level]} ${state.wallet.address}${state.wallet.level === "verified" && state.network ? ` on ${tools.rules.supportNetworkName(state.network)}` : ""}`,
          (into) => {
            into.wallet = snapshot.wallet;
          },
        );
      if (network)
        add("Network", tools.rules.supportNetworkName(network), (into) => {
          into.network = network;
        });
      for (const field of tools.APP_FIELDS) {
        if (app[field] === undefined) continue;
        add(
          tools.APP_LABELS[field],
          tools.appValue(field, app, tools.FAILURE_KIND_LABELS),
          (into) => {
            into.app = { ...into.app, [field]: app[field] };
          },
          field === "error"
            ? app.error?.message
            : field === "product"
              ? app.product?.label
              : undefined,
        );
      }
      for (const tx of transactions)
        add(
          "Transaction",
          tx.network
            ? `${tx.hash} on ${tools.rules.supportNetworkName(tx.network)}`
            : tx.hash,
          (into) => {
            into.transactions = [...(into.transactions ?? []), tx];
          },
        );
      const { amount, asset, ...kind } = failure;
      const failureTime = tools.utcTime(failure.at);
      add(
        "Failure",
        `${tools.FAILURE_KIND_LABELS[failure.kind]} ${failureTime.includes(",") ? "on" : "at"} ${failureTime}`,
        (into) => {
          into.failure = { ...into.failure, ...kind };
        },
      );
      if (asset && amount === undefined)
        add(
          "Asset",
          asset.symbol ?? asset.address ?? "",
          (into) => {
            into.failure = { ...into.failure, ...kind, asset };
          },
          asset.symbol,
        );
      if (amount !== undefined)
        add(
          "Amount",
          [amount, asset?.symbol ?? asset?.address].filter(Boolean).join(" "),
          (into) => {
            into.failure = {
              ...into.failure,
              ...kind,
              amount,
              ...(asset ? { asset } : {}),
            };
          },
          [amount, asset?.symbol].filter(Boolean).join(" "),
        );
      add("Widget build", `${sdk.widget} / ${sdk.api}`, (into) => {
        into.sdk = sdk;
      });
      held = [...held, { snapshot, state, rows }].slice(
        -SUPPORT_CONTEXT_LIMITS.snapshots,
      );
      live = state;
      render();
    },
    state(state: Promise<WalletState>) {
      void state.then((next) => {
        live = stateOf(next);
        render();
      });
    },
    clearCapturedFailures() {
      captureRevision++;
      held = held
        .map((entry) => ({
          ...entry,
          rows: entry.rows.filter((row) => row.pending || row.shared),
        }))
        .filter((entry) => entry.rows.length);
      render();
    },
    cancelled(context) {
      inner.cancelled?.(context);
      for (const entry of held)
        if (
          context?.snapshots?.some(
            (snapshot) => snapshot.id === entry.snapshot.id,
          )
        )
          for (const row of entry.rows)
            if (row.pending) {
              row.pending = false;
              row.checked = true;
            }
      render();
    },
    confirmed(context) {
      inner.confirmed?.(context);
      for (const entry of held)
        if (
          context?.snapshots?.some(
            (snapshot) => snapshot.id === entry.snapshot.id,
          )
        )
          for (const row of entry.rows)
            if (row.pending) {
              row.pending = false;
              row.shared = true;
            }
      render();
    },
    ticked() {
      const shared = inner.ticked();
      if (!available) return shared;
      const snapshots: SupportFailureSnapshot[] = [];
      for (const { snapshot, rows } of held) {
        const picked = rows.filter(
          (row) => row.checked && !row.shared && !row.pending,
        );
        if (!picked.length) continue;
        const out: SupportFailureSnapshot = {
          id: snapshot.id,
          capturedAt: snapshot.capturedAt,
          wallet: { level: snapshot.wallet.level },
        };
        for (const row of picked) {
          row.pick(out);
          row.pending = true;
          row.checked = false;
        }
        snapshots.push(out);
      }
      render();
      return snapshots.length ? { ...shared, snapshots } : shared;
    },
  };
}
