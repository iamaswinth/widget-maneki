const HIGHLIGHT_DURATION_MS = 2500;
const FADE_MS = 400;

/** A temporary outline over `el`'s bounding rect, appended to the light DOM
 * (`doc.body`, not the widget's own Shadow DOM) since it has to align with
 * real page coordinates — a Shadow-DOM-internal element can't visually
 * overlay content outside that shadow root. */
export function highlightElement(el: Element, doc: Document = document): void {
  const rect = el.getBoundingClientRect();
  const view = doc.defaultView ?? window;

  const overlay = doc.createElement("div");
  overlay.setAttribute("data-maneki-highlight", "");
  overlay.style.position = "absolute";
  overlay.style.top = `${rect.top + view.scrollY}px`;
  overlay.style.left = `${rect.left + view.scrollX}px`;
  overlay.style.width = `${rect.width}px`;
  overlay.style.height = `${rect.height}px`;
  overlay.style.border = "3px solid #3b82f6";
  overlay.style.borderRadius = "6px";
  overlay.style.boxShadow = "0 0 0 4px rgba(59, 130, 246, 0.25)";
  overlay.style.pointerEvents = "none";
  overlay.style.zIndex = "2147483646";
  overlay.style.transition = `opacity ${FADE_MS}ms ease`;
  doc.body.appendChild(overlay);

  setTimeout(() => {
    overlay.style.opacity = "0";
    setTimeout(() => overlay.remove(), FADE_MS);
  }, HIGHLIGHT_DURATION_MS);
}
