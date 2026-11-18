import { modelDiagnosisFacts } from "./model-facts";
import type { Diagnosis, DiagnosisClaims } from "./types";

/** The validated facts an AI reply may restate. */
export function claimSet(diagnosis: Diagnosis): DiagnosisClaims {
  return modelDiagnosisFacts(diagnosis).claims;
}
