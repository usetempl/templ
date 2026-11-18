"use client";
/** One way to leave every modal `<dialog>`.
 *
 * A modal opened with `showModal()` closes on a click outside it (the click
 * lands on the dialog element itself because the backdrop is part of it) and
 * on Escape, which browsers report as a `cancel` event. Both paths call the
 * dialog's own close handler so React keeps ownership of the open state; the
 * native close is always prevented. While `disabled` is set (a submit in
 * flight, a nested picker open) neither path closes the dialog. */
import {
  useRef,
  type MouseEvent,
  type PointerEvent,
  type SyntheticEvent,
} from "react";

export type DismissDialogProps = {
  onPointerDown: (event: PointerEvent<HTMLDialogElement>) => void;
  onClick: (event: MouseEvent<HTMLDialogElement>) => void;
  onCancel: (event: SyntheticEvent<HTMLDialogElement>) => void;
};

/** True when the pointer sits outside the dialog's box: the backdrop, not the
 * dialog's own padding or border. A zero-size box (a test renderer) counts as
 * outside. */
function onBackdrop(
  event: MouseEvent<HTMLDialogElement> | PointerEvent<HTMLDialogElement>,
) {
  if (event.target !== event.currentTarget) return false;
  const rect = event.currentTarget.getBoundingClientRect();
  return (
    event.clientX < rect.left ||
    event.clientX >= rect.right ||
    event.clientY < rect.top ||
    event.clientY >= rect.bottom
  );
}

export function useDismissDialog(
  onDismiss: () => void,
  { disabled = false }: { disabled?: boolean } = {},
): DismissDialogProps {
  // A drag that starts inside the dialog and ends on the backdrop (selecting
  // text in a form) also fires a click on the dialog; the press decides.
  const pressedOnBackdrop = useRef<boolean | undefined>(undefined);
  return {
    onPointerDown: (event) => {
      pressedOnBackdrop.current = onBackdrop(event);
    },
    onClick: (event) => {
      const pressed = pressedOnBackdrop.current;
      pressedOnBackdrop.current = undefined;
      if (pressed === false || !onBackdrop(event)) return;
      if (!disabled) onDismiss();
    },
    onCancel: (event) => {
      event.preventDefault();
      if (!disabled) onDismiss();
    },
  };
}
