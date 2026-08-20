// The bottom safe-area inset exists to clear the home indicator. While the
// on-screen keyboard is up it covers that strip entirely, so continuing to
// honour the inset pads the composer away from the keyboard by an inset-sized
// blank gap. Flag the keyboard so the shell can drop the inset for its duration.

// A keyboard occupies a large slice of the viewport. Anything smaller is the
// URL bar collapsing or an in-page widget, which must not count.
const KEYBOARD_MIN_HEIGHT = 120;

const textEntryInputTypes = new Set([
  "text",
  "search",
  "url",
  "tel",
  "email",
  "password",
  "number",
  "date",
  "datetime-local",
  "month",
  "time",
  "week",
]);

export function watchOnScreenKeyboard() {
  if (typeof window === "undefined" || typeof document === "undefined") return;

  const root = document.documentElement;
  const viewport = window.visualViewport;

  const update = () => {
    if (isKeyboardVisible(viewport)) {
      root.dataset.keyboardOpen = "true";
    } else {
      delete root.dataset.keyboardOpen;
    }
  };

  // `resizes-visual` (the default) shrinks only the visual viewport, so the
  // overlap below reports the keyboard height. Under `resizes-content` the
  // layout viewport shrinks too and the overlap collapses to zero, which is why
  // focus is checked as well.
  viewport?.addEventListener("resize", update);
  viewport?.addEventListener("scroll", update);
  document.addEventListener("focusin", update);
  document.addEventListener("focusout", update);
  update();
}

function isKeyboardVisible(viewport: VisualViewport | null) {
  const overlap = viewport ? window.innerHeight - viewport.height - viewport.offsetTop : 0;
  if (overlap >= KEYBOARD_MIN_HEIGHT) return true;
  return isTextEntryElement(document.activeElement) && hasCoarsePointer();
}

function isTextEntryElement(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  if (element instanceof HTMLTextAreaElement) return true;
  if (element instanceof HTMLInputElement) return textEntryInputTypes.has(element.type);
  return element.isContentEditable;
}

function hasCoarsePointer() {
  return Boolean(window.matchMedia?.("(pointer: coarse)").matches);
}
