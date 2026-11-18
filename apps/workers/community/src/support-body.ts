import { E2EE_LIMITS, object, parseEncryptedRecord, parseValidationReceipt } from "@templ/e2ee/protocol";
import { readJson } from "./common";
import { supportImportBodyBytes } from "./support-import-parser";

/** Ciphertext includes key wraps, a receipt and native principal binding.
 * Only an exact encrypted envelope gets this budget. Actual input bytes,
 * including whitespace, still enforce the old limit for plaintext bodies. */
export const ENCRYPTED_REQUEST_BYTES = E2EE_LIMITS.wireBytes + 4_096;
export function readSupportJson(request: Request, path: string, ordinaryBytes = supportImportBodyBytes(path)) {
  if (!/^\/conversations\/(?:ask|encryption\/settle-ai|tc-[a-f0-9]{32}\/messages)$/.test(path))
    return readJson(request, ordinaryBytes);
  return readJson(request, Math.max(ordinaryBytes, ENCRYPTED_REQUEST_BYTES), body => {
    try {
      object(body, ["encryptedRecord", "validationReceipt"], ["reservation", "confirmed", "expectedPrincipalId"]);
      parseEncryptedRecord(body.encryptedRecord);
      parseValidationReceipt(body.validationReceipt);
      if (body.expectedPrincipalId !== undefined && (typeof body.expectedPrincipalId !== "string" || !/^[\w:-]{1,128}$/.test(body.expectedPrincipalId))) return ordinaryBytes;
      return ENCRYPTED_REQUEST_BYTES;
    } catch { return ordinaryBytes; }
  });
}
