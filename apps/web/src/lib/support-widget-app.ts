import type {
  SupportAppContext,
  SupportAppField,
  SupportFailureKind,
} from "@templ/chat/support-app-context";

/** The name of each typed detail from the protocol's app, in the order the
 * widget lists them. */
export const APP_LABELS: Readonly<Record<SupportAppField, string>> = {
  page: "Current screen",
  action: "Action",
  product: "Product",
  shown: "Value shown",
  error: "Error",
  connector: "Wallet app",
  appVersion: "App version",
  device: "Device",
  browser: "Browser",
  operatingSystem: "Operating system",
  viewport: "Window size",
  screen: "Screen size",
  language: "Browser language",
  timeZone: "Time zone",
  connection: "Connection",
  failure: "Failure",
  sdk: "Widget build",
};
/** What went wrong, in the member's words. */
export const FAILURE_KIND_LABELS: Readonly<Record<SupportFailureKind, string>> =
  {
    rejected: "Wallet declined",
    simulation: "Simulation failed",
    submission: "Couldn't send",
    broadcast: "Failed after sending",
    other: "Other",
  };
export const APP_FIELDS = Object.keys(APP_LABELS) as SupportAppField[];

const cap = (word: string) => word[0].toUpperCase() + word.slice(1);

/** One checked typed detail as the member reads it: plain text, never
 * markup. A failure kind reads from `kinds` when given (the snapshot card and
 * the team's views pass FAILURE_KIND_LABELS); the member's shared list, which
 * has no room for the table, shows the kind capitalized. */
export function appValue(
  field: SupportAppField,
  app: SupportAppContext,
  kinds?: Readonly<Record<SupportFailureKind, string>>,
): string {
  if (field == "failure") {
    const { kind, amount, asset } = app.failure!;
    return [
      kinds ? kinds[kind] : cap(kind),
      [amount, asset?.symbol].filter(Boolean).join(" "),
    ]
      .filter(Boolean)
      .join(", ");
  }
  if (field == "sdk") return `${app.sdk!.widget} / ${app.sdk!.api}`;
  if (field == "viewport" || field == "screen") {
    const size = app[field]!;
    return `${size.width} × ${size.height} px`;
  }
  if (field == "connection") {
    const connection = app.connection!;
    return [
      connection.online ? "Online" : "Offline",
      connection.effectiveType,
      ...(connection.saveData === undefined
        ? []
        : [connection.saveData ? "Data saver on" : "Data saver off"]),
    ]
      .filter(Boolean)
      .join(", ");
  }
  if (field == "action") return cap(app.action!);
  if (field == "product") {
    const product = app.product!;
    return product.label ?? product.address ?? product.key;
  }
  if (field == "shown") {
    const shown = app.shown!;
    return [
      [shown.value, shown.metric?.label ?? shown.metric?.key]
        .filter(Boolean)
        .join(" "),
      shown.period,
    ]
      .filter(Boolean)
      .join(", ");
  }
  if (field == "error") {
    const { code, message } = app.error!;
    return code && message ? `${code}: ${message}` : (code ?? message ?? "");
  }
  return app[field] as string;
}
