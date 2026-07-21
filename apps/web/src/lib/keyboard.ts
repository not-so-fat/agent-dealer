/** True when the event target is a field where arrow keys move the caret / options. */
export function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;

  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;

  const type = (target as HTMLInputElement).type;
  // Buttons and checkboxes don't use Left/Right for editing; allow queue nav there.
  return !["button", "submit", "reset", "checkbox", "radio", "file", "hidden", "image", "range", "color"].includes(
    type,
  );
}
