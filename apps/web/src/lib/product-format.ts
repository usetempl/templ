/** 1500 -> "$15"; 2950 -> "$29.50". The one USD formatter, shared with the
 * blog and Templ's own support agent. */
export { formatUsdCents as formatUsd } from "@templ/chat/resolution-copy";
const dayFormat = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
});
/** A calendar date with its year: statements, grant ends and price changes. */
export function formatDay(
  value: string | number | null | undefined,
): string | null {
  if (value === null || value === undefined || value === "") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? dayFormat.format(date) : null;
}
