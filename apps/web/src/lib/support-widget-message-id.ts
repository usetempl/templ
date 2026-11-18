/** Message retries use the current timestamp and fresh UUID entropy. */
export function widgetMessageId() {
  const random = crypto.randomUUID(),
    time = Date.now().toString(16).padStart(12, "0");
  return `${time.slice(0, 8)}-${time.slice(8)}-7${random.slice(15)}`;
}
