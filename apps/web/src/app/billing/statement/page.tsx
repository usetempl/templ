import type { ChatRoomId } from "@templ/chat/index";
import { StatementDocument } from "@/components/product-statement-document";
import { normalizeChatRoomId } from "@/lib/chat-room-id";

export const metadata = { title: "Statement" };

/** A month's billing statement as a printable page, for the workspace's
 * manager and billing managers. */
export default async function StatementPage({
  searchParams,
}: {
  searchParams: Promise<{ room?: string; month?: string }>;
}) {
  const query = await searchParams;
  let room: ChatRoomId | undefined;
  try {
    if (typeof query.room === "string") room = normalizeChatRoomId(query.room);
  } catch {
    /* Invalid links reveal no room information. */
  }
  const month =
    typeof query.month === "string" && /^\d{6}$/.test(query.month) ? query.month : null;
  if (!room || !month)
    return (
      <p style={{ padding: "48px 16px", textAlign: "center" }}>
        Open the statement from your workspace’s Plan tab.
      </p>
    );
  return <StatementDocument room={room} month={month} />;
}
