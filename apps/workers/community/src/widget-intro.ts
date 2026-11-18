import { HttpError } from "./common";

export const WIDGET_INTRO_LIMITS = {
  questions: 4,
  questionBytes: 320,
  questionCharacters: 80,
  replyHours: 168,
} as const;

export function widgetIntroPrompts(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > WIDGET_INTRO_LIMITS.questions)
    throw new HttpError(400, "Add up to 4 questions.");
  const prompts = value.map((text) => {
    if (typeof text !== "string")
      throw new HttpError(400, "Write each question as text.");
    const trimmed = text.trim();
    if (
      !trimmed ||
      [...trimmed].length > WIDGET_INTRO_LIMITS.questionCharacters ||
      new TextEncoder().encode(trimmed).length >
        WIDGET_INTRO_LIMITS.questionBytes ||
      /[\u0000-\u001f\u007f]/.test(trimmed)
    )
      throw new HttpError(
        400,
        "Keep each question on 1 line, within 80 characters.",
      );
    return trimmed;
  });
  if (new Set(prompts).size !== prompts.length)
    throw new HttpError(400, "Use different questions.");
  return prompts;
}

export function widgetIntroReplyHours(value: unknown): number | null {
  if (value === null) return null;
  if (
    !Number.isInteger(value) ||
    (value as number) < 1 ||
    (value as number) > WIDGET_INTRO_LIMITS.replyHours
  )
    throw new HttpError(
      400,
      "Choose a reply time from 1 to 168 hours, or leave it blank.",
    );
  return value as number;
}

export function widgetIntroFields(
  body: Record<string, unknown>,
  available: boolean,
) {
  const prompts =
    body.prompts === undefined
      ? undefined
      : body.prompts === null
        ? null
        : widgetIntroPrompts(body.prompts);
  const replyHours =
    body.replyHours === undefined
      ? undefined
      : widgetIntroReplyHours(body.replyHours);
  if (
    !available &&
    ((prompts?.length ?? 0) > 0 ||
      (replyHours !== undefined && replyHours !== null))
  )
    throw new HttpError(
      409,
      "Widget intro settings are unavailable for this workspace.",
    );
  return {
    ...(prompts === undefined ? {} : { prompts }),
    ...(replyHours === undefined ? {} : { replyHours }),
    widgetIntroAvailable: available,
  };
}

export function widgetIntroAuditValue(
  value: unknown,
): { questions: number; replyHours: number | null } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).sort().join() !== "questions,replyHours" ||
    !Number.isInteger(row.questions) ||
    (row.questions as number) < 0 ||
    (row.questions as number) > 4
  )
    return null;
  try {
    return {
      questions: row.questions as number,
      replyHours: widgetIntroReplyHours(row.replyHours),
    };
  } catch {
    return null;
  }
}
