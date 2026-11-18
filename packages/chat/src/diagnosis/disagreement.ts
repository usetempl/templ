import { draft, type EvidenceBook, type Outcome } from "./evidence";
import type { DiagnosisDisagreement, DiagnosisInput } from "./types";

export function inputDisagreement(
  input: DiagnosisInput,
): (DiagnosisDisagreement & { fact?: string }) | null {
  if (input.disagreement) return input.disagreement;
  if (input.kind === "solana") return null;
  const replay = input.found?.revert;
  if (replay?.outcome === "disagree")
    return {
      network: input.found!.network,
      observations: replay.observations,
      fact: "/found/revert/observations",
    };
  if (input.found) return null;
  const hinted = input.probes.find(
    (probe) => probe.network === input.hint?.network,
  );
  const split =
    hinted?.outcome === "disagree"
      ? hinted
      : input.probes.find((probe) => probe.outcome === "disagree");
  return split?.outcome === "disagree"
    ? {
        network: split.network,
        observations: split.observations,
        fact: `/probes/${input.probes.indexOf(split)}/observations`,
      }
    : null;
}

export function disagreementOutcome(
  value: DiagnosisDisagreement & { fact?: string },
  book: EvidenceBook,
): Outcome {
  const evidence = value.observations.map((observation, index) =>
    book.add(
      `provider.${observation.provider}`,
      observation.provider === "primary"
        ? "Primary provider"
        : "Confirmation provider",
      observation.value,
      `${value.fact ?? "/disagreement/observations"}/${index}`,
      "observation",
      observation.provider === "primary"
        ? "Primary provider observation"
        : "Confirmation provider observation",
    ),
  );
  return {
    status: "disagree",
    finality: null,
    network: value.network,
    category: "other",
    categorySource: null,
    drafts: [
      draft(
        "dx.disagree",
        "The providers gave different answers. The transaction's outcome is not confirmed.",
        evidence,
      ),
    ],
  };
}
