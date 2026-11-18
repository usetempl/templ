// Build-time hashes of the downloadable agent modules.
// next.config.ts inlines them as env values, so /api/status can publish the
// exact bytes a hosted release serves without reading files at request time.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const agentClientPath = fileURLToPath(
  new URL("../public/agent-client.mjs", import.meta.url),
);
const SOURCE_HEADER = /^\/\/ Source SHA-256: ([0-9a-f]{64})$/m;

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Hash of the served file plus the generator's source hash from its header. */
export function agentClientHashes(bytes = readFileSync(agentClientPath)) {
  const header = SOURCE_HEADER.exec(bytes.toString("utf8"));
  if (!header)
    throw new Error("agent-client.mjs is missing its Source SHA-256 header.");
  return { sha256: sha256(bytes), sourceSha256: header[1] };
}

export function assetHashes() {
  const client = agentClientHashes();
  return {
    TEMPL_AGENT_CLIENT_SHA256: client.sha256,
    TEMPL_AGENT_CLIENT_SOURCE_SHA256: client.sourceSha256,
  };
}
