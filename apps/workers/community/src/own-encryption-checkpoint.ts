/** A private service-binding capability for the isolated Own endpoint.
 * Only aggregate current authority revisions cross it, never history or keys. */
import { WorkerEntrypoint } from "cloudflare:workers";
import { OWN_SUPPORT_ENDPOINT } from "@templ/e2ee/protocol";
import { nativeRecord } from "./native-rooms";
import type { Env } from "./common";

export class OwnEncryptionCheckpoint extends WorkerEntrypoint<Env> {
  override async fetch() {
    return new Response(null, { status: 404 });
  }
  async #request(
    action: "checkpoint" | "advance" | "revoke-device",
    value?: object,
  ): Promise<unknown> {
    const props = this.ctx.props as Record<string, unknown>;
    if (
      !["checkpoint", "advance", "revoke-device"].includes(action) ||
      this.env.APP_ORIGIN !== "https://usetempl.com" ||
      !this.env.OWN_SUPPORT_ENCRYPTION_ROOT ||
      !props ||
      Object.keys(props).sort().join(",") !== "origin,workspace" ||
      props.origin !== OWN_SUPPORT_ENDPOINT.serviceOrigin ||
      props.workspace !== OWN_SUPPORT_ENDPOINT.workspace
    )
      throw new Error("Encryption authority is unavailable.");
    const current = await nativeRecord(
      this.env,
      OWN_SUPPORT_ENDPOINT.workspace,
    );
    const response = await current.room.fetch(
      new Request(`https://internal/private/support/encryption-${action}`, {
        method: value ? "POST" : "GET",
        headers: {
          "X-Native-Room-Id": OWN_SUPPORT_ENDPOINT.workspace,
          ...(value ? { "Content-Type": "application/json" } : {}),
        },
        ...(value ? { body: JSON.stringify(value) } : {}),
        signal: AbortSignal.timeout(10_000),
      }),
    );
    if (!response.ok) throw new Error("Encryption authority is unavailable.");
    return response.json();
  }
  read() {
    return this.#request("checkpoint") as Promise<{
      permissionRevision: number;
      deletionRevision: number;
      at: number;
      authority: { revision: number; digest: string } | null;
    }>;
  }
  advance(value: { revision: number; digest: string; signature: string }) {
    return this.#request("advance", value);
  }
  revokeDevice(value: { device: string; at: number; signature: string }) {
    return this.#request("revoke-device", value);
  }
}
