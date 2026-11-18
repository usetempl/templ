/** Freeze a projection before consumers read its shared facts. */
export function immutableRelease<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) immutableRelease(child);
    Object.freeze(value);
  }
  return value;
}
