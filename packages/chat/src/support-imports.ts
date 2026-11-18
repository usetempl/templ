/** File-import outcomes contain safe titles and fixed refusal reasons only. */
export const IMPORT_REASON = {
  "secret-refused": "Contains a recovery phrase or a private key.",
  "unsafe-ask": "Asks the user for a secret, signature, approval or payment.",
  "invalid-row": "Check the title, body and optional fields.",
  duplicate: "A reply with this title already exists.",
  capacity: "Remove a saved reply before adding another.",
} as const;
export type ImportPreviewRow = {
  row: number;
  title: string;
  status: "add" | "skip" | "refuse";
  reason?: keyof typeof IMPORT_REASON;
};
export type SupportImportPreview = {
  rows: ImportPreviewRow[];
  counts: { added: number; skipped: number; refused: number };
  digest: string;
};
