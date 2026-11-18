import type { ChatRoomId } from "@templ/chat/index";
import { ReceiptDocument } from "@/components/product-statement-document";
import { normalizeChatRoomId } from "@/lib/chat-room-id";

export const metadata = { title: "Receipt" };

/** One top-up's receipt as a printable page, for the workspace's manager
 * and billing managers. */
export default async function ReceiptPage({
  searchParams,
}: {
  searchParams: Promise<{ room?: string; tx?: string }>;
}) {
  const query = await searchParams;
  let room: ChatRoomId | undefined;
  try {
    if (typeof query.room === "string") room = normalizeChatRoomId(query.room);
  } catch {
    /* Invalid links reveal no room information. */
  }
  const tx =
    typeof query.tx === "string" && /^[0-9A-Za-z]{32,128}$/.test(query.tx) ? query.tx : null;
  if (!room || !tx)
    return (
      <p style={{ padding: "48px 16px", textAlign: "center" }}>
        Open the receipt from your workspace’s Plan tab.
      </p>
    );
  return <ReceiptDocument room={room} tx={tx} />;
}
