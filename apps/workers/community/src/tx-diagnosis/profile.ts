import type {
  EvmNetwork,
  Hex,
  ProtocolProfileFacts,
} from "@templ/chat/diagnosis/types";

/** The manager's protocol profile as the read layer sees it. The edge passes
 * a real source once the profile ships; until then NO_PROFILE. Any error from
 * the source is treated as "no profile" and logged without addresses. */
export type DiagnosisProfileSource = {
  expectedNetworks(): Promise<EvmNetwork[] | null>;
  slice(
    network: EvmNetwork,
    addresses: Hex[],
  ): Promise<ProtocolProfileFacts | null>;
  /** "profile:<network>:<address>", at most 20. */
  refs(network: EvmNetwork, addresses: Hex[]): Promise<string[]>;
};

export const NO_PROFILE: DiagnosisProfileSource = Object.freeze({
  expectedNetworks: async () => null,
  slice: async () => null,
  refs: async () => [],
});

/** Wraps a source so a failure becomes null and one log line. */
export function safeProfileSource(
  source: DiagnosisProfileSource,
): DiagnosisProfileSource {
  const logged =
    <T>(fallback: T) =>
    (error: unknown): T => {
      console.warn(
        "TEMPL_DIAGNOSIS_PROFILE",
        JSON.stringify({
          problem: error instanceof Error ? error.name : "unreadable",
        }),
      );
      return fallback;
    };
  return {
    expectedNetworks: () =>
      source.expectedNetworks().catch(logged<EvmNetwork[] | null>(null)),
    slice: (network, addresses) =>
      source
        .slice(network, addresses)
        .catch(logged<ProtocolProfileFacts | null>(null)),
    refs: (network, addresses) =>
      source
        .refs(network, addresses)
        .then((refs) => refs.slice(0, 20))
        .catch(logged<string[]>([])),
  };
}
