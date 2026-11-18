import { COMMUNITY_API } from "./community-client";
import { profileMediaHash } from "@templ/chat/profiles";

export async function uploadTokenImage(blob: Blob): Promise<string> {
  const response = await fetch(`${COMMUNITY_API}/media`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": blob.type },
    body: blob,
  });
  const data = (await response.json()) as { url?: string; error?: string };
  if (!response.ok || !data.url)
    throw new Error(data.error ?? "Could not upload the token image.");
  if (!profileMediaHash(data.url, COMMUNITY_API))
    throw new Error("The image URL could not be verified.");
  return data.url;
}
