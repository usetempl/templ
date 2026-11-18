import {
  AGENT_API_FEATURES,
  type AgentApiVersion,
} from "@templ/chat/agent-api";
import { DEFAULT_CHAT_AUTH_CHAIN_ID } from "@templ/chat/chains";
import { AGENT_PYTHON } from "./agent-python-asset";

/** The release fields the Agent API status reads. */
type AgentRelease = {
  agentSdkVerified?: unknown;
  agentPythonVerified?: unknown;
  agentApi?: { version?: unknown } | null;
};

/** The Agent API version this release serves, computed and never hand-set:
 * none until the SDK trial record is adopted, then 1.0, or 1.1 once the
 * manifest states it (the SDK gate requires a 1.1 record for that). */
export function agentApiVersion(release: AgentRelease): AgentApiVersion | null {
  if (release.agentSdkVerified !== true) return null;
  return release.agentApi?.version === "1.1" ? "1.1" : "1.0";
}
/** The features of the live version, or none. */
export function agentApiFeatures(release: AgentRelease): readonly string[] {
  const version = agentApiVersion(release);
  return version === null ? [] : AGENT_API_FEATURES[version];
}
/** `/api/status` `agents.api` and `agents.python`. */
export function agentApiStatus(release: AgentRelease, docsOrigin: string) {
  const version = agentApiVersion(release);
  return {
    api: {
      version,
      features: agentApiFeatures(release),
      reference: `${docsOrigin}/developers/agent-api`,
      signInChainId: DEFAULT_CHAT_AUTH_CHAIN_ID,
    },
    python: {
      path: AGENT_PYTHON.path,
      sha256: AGENT_PYTHON.sha256,
      /** The hosted Python trial passed against a live Agent API. */
      verified: release.agentPythonVerified === true && version !== null,
    },
  };
}
