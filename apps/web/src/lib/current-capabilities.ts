import {
  capabilities as verifiedCapabilities,
  type Capability,
  type ReleaseFlags,
} from "@templ/chat/availability";
import type { ProductPaymentRecipients } from "@templ/chat/product-payment";

/** Current public capabilities retain their original evidence gates. */
export function capabilities(
  release: ReleaseFlags,
  recipients: ProductPaymentRecipients = {},
): Capability[] {
  return (
    verifiedCapabilities(release, recipients)
      .filter((row) =>
        ["accounts", "plans", "conversations", "agents"].includes(
          row.id.split(".")[0],
        ),
      )
      // The availability page lists each payment network and token.
      .map((row) =>
        row.id === "plans.purchase" ? { ...row, chains: undefined } : row,
      )
  );
}
