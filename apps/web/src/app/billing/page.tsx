import Link from "next/link";
import { IconReceipt } from "@tabler/icons-react";
import type { ChatRoomId } from "@templ/chat/index";
import { ProductBillingPage } from "@/components/product-billing-page";
import { normalizeChatRoomId } from "@/lib/chat-room-id";
import styles from "@/components/billing-portal.module.css";

export const metadata = { title: "Billing" };

/** Balance and receipts for workspace billing contacts. */
export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ room?: string }>;
}) {
  const query = await searchParams;
  let room: ChatRoomId | undefined;
  try {
    if (typeof query.room === "string") room = normalizeChatRoomId(query.room);
  } catch {
    /* Invalid links reveal no room information. */
  }
  return (
    <div className={styles.page}>
      <section className={styles.panel} aria-labelledby="billing-title">
        <span className={styles.icon}>
          <IconReceipt size={32} aria-hidden="true" />
        </span>
        <h1 id="billing-title">Support billing</h1>
        {room ? (
          <>
            <p>
              View your balance and verified payments. Sign in as the manager or
              someone with billing access.
            </p>
            <ProductBillingPage room={room} />
          </>
        ) : (
          <>
            <p>
              Open billing from your workspace’s plan settings or from a payment
              confirmation.
            </p>
            <Link className={styles.primary} href="/inbox">
              Your workspaces
            </Link>
          </>
        )}
      </section>
    </div>
  );
}
