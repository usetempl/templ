import {
  checkedWidgetAppearance,
  type WidgetAppearance,
} from "@templ/chat/widget-appearance";
import { HttpError } from "./common";

export const WIDGET_APPEARANCE_KEY = "widget-appearance-v1";
export type WidgetAppearanceState = {
  appearance: WidgetAppearance | null;
  appearanceRevision: number;
  appearanceUnavailable: boolean;
};
type Storage = Pick<DurableObjectTransaction, "get">;

/** A separate record survives a rollback that saves the older widget settings. */
export async function readWidgetAppearance(
  storage: Storage,
): Promise<WidgetAppearanceState> {
  const row = await storage.get<{ revision: number; value: unknown }>(
    WIDGET_APPEARANCE_KEY,
  );
  if (row === undefined)
    return {
      appearance: null,
      appearanceRevision: 0,
      appearanceUnavailable: false,
    };
  try {
    if (!row || !Number.isSafeInteger(row.revision) || row.revision < 1)
      throw new Error("Invalid appearance record");
    return {
      appearance: checkedWidgetAppearance(row.value),
      appearanceRevision: row.revision,
      appearanceUnavailable: false,
    };
  } catch {
    // Cosmetic data cannot stop an existing support case from opening.
    return {
      appearance: null,
      appearanceRevision: 0,
      appearanceUnavailable: true,
    };
  }
}

export function prepareWidgetAppearance(
  state: WidgetAppearanceState,
  input: unknown,
  expectedRevision: unknown,
) {
  if (state.appearanceUnavailable)
    throw new HttpError(503, "Widget appearance could not load. Try again.");
  if (expectedRevision !== state.appearanceRevision)
    throw new HttpError(
      409,
      "Widget appearance changed. Reload before saving.",
    );
  let appearance: WidgetAppearance | null;
  try {
    appearance = checkedWidgetAppearance(input);
  } catch (error) {
    throw new HttpError(
      400,
      error instanceof Error ? error.message : "Check the widget settings.",
    );
  }
  const changed =
    JSON.stringify(appearance) !== JSON.stringify(state.appearance);
  if (changed && state.appearanceRevision >= Number.MAX_SAFE_INTEGER)
    throw new HttpError(
      503,
      "Widget appearance could not save. Contact support.",
    );
  return {
    appearance,
    appearanceRevision: state.appearanceRevision + Number(changed),
    appearanceUnavailable: false,
    changed,
  };
}
