/** A time as every support view shows it: "14:02 UTC" on the current UTC
 * day, and "Sep 28, 14:02 UTC" on another day or when the caller asks for
 * the date. */
export function supportUtcTime(
  at: string,
  alwaysDate = false,
  now = Date.now(),
): string {
  try {
    const value = new Date(at);
    const iso = value.toISOString();
    const time = `${iso.slice(11, 16)} UTC`;
    return alwaysDate ||
      iso.slice(0, 10) !== new Date(now).toISOString().slice(0, 10)
      ? `${value.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}, ${time}`
      : time;
  } catch {
    // An unreadable time never shows its raw input.
    return "Time unavailable";
  }
}
