import "server-only";
import { cache } from "react";
import { connection } from "next/server";
import { headers as requestHeaders } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { RELEASE_AVAILABILITY_PATH } from "@templ/chat/release-activation";
import { immutableRelease } from "./release-immutable";
import { BUILD_RELEASE, APP_ENVIRONMENT, SITE } from "./release-public";
import {
  releaseConfiguration,
  type ReleaseConfiguration,
} from "./release-configuration";
import { webReleaseIdentity } from "./web-release-identity";
export * from "./release-public";

const MAX_AVAILABILITY_BYTES = 65_536;
async function readAvailability(
  response: Response,
  unavailable: () => void,
): Promise<unknown> {
  const length = response.headers.get("Content-Length");
  if (
    length !== null &&
    (!/^\d+$/.test(length) || Number(length) > MAX_AVAILABILITY_BYTES)
  ) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Unavailable release.");
  }
  if (!response.body) throw new Error("Unavailable release.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      let part: ReadableStreamReadResult<Uint8Array>;
      try {
        part = await reader.read();
      } catch (error) {
        unavailable();
        throw error;
      }
      const { value, done } = part;
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_AVAILABILITY_BYTES)
        throw new Error("Unavailable release.");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
}

/** Reads only this request's platform identity and uncached public activation. */
export async function readReleaseConfiguration(): Promise<ReleaseConfiguration> {
  if (APP_ENVIRONMENT !== "production")
    return immutableRelease({
      release: structuredClone(BUILD_RELEASE),
      web: null,
      activationDigest: null,
    });
  await connection();
  let web;
  let unavailable = false;
  try {
    const { env } = await getCloudflareContext({ async: true });
    web = webReleaseIdentity(env);
    const incoming = (await requestHeaders()).get(
      "Cloudflare-Workers-Version-Overrides",
    );
    const outbound = new Headers({ "X-Templ-Web-Version": web.versionId });
    // Candidate checks may select only a deployed Templ API version. The
    // response still needs the complete signed proof for this actual web build.
    if (incoming) {
      const parts = incoming.split(",").map((part) => part.trim());
      const seen = new Set<string>();
      for (const part of parts) {
        const parsed =
          /^(templ-community-v4-production|templ-web-production)="([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})"$/.exec(
            part,
          );
        if (!parsed || seen.has(parsed[1]))
          throw new Error("Unavailable release.");
        seen.add(parsed[1]);
      }
      if (parts.length > 2) throw new Error("Unavailable release.");
      outbound.set("Cloudflare-Workers-Version-Overrides", incoming);
    }
    const availabilityUrl = `${SITE.community}${RELEASE_AVAILABILITY_PATH}`;
    let response: Response;
    try {
      response = await fetch(availabilityUrl, {
        cache: "no-store",
        credentials: "omit",
        redirect: "manual",
        headers: outbound,
        signal: AbortSignal.timeout(5000),
      });
    } catch (error) {
      unavailable = true;
      throw error;
    }
    unavailable = response.status === 429 || response.status >= 500;
    if (
      response.status !== 200 ||
      response.redirected ||
      response.url !== availabilityUrl
    )
      throw new Error("Unavailable release.");
    const value = await readAvailability(response, () => { unavailable = true; });
    return releaseConfiguration(value, web);
  } catch {
    const closed = releaseConfiguration(null, web ?? null);
    return unavailable
      ? immutableRelease({ ...closed, unavailable: true })
      : closed;
  }
}

// React cache deduplicates a render's reads. It stores no cross-request projection.
export const getReleaseConfiguration = cache(readReleaseConfiguration);
export async function getRelease() {
  return (await getReleaseConfiguration()).release;
}
