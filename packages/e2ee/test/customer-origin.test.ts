import { expect, it } from "vitest";
import { customerOrigin, OWN_SUPPORT_ENDPOINT } from "../src/protocol";

it("accepts a customer-controlled HTTPS origin", () => {
  const origin = "https://support.customer.example";
  expect(customerOrigin(origin)).toBe(origin);
});

it.each(["https://usetempl.com", OWN_SUPPORT_ENDPOINT.clientOrigin])(
  "rejects %s for customer custody",
  (origin) => {
    expect(() => customerOrigin(origin)).toThrow(
      expect.objectContaining({ code: "customer-custody-required" }),
    );
  },
);
