/**
 * Tiny focus-trap hook for modal dialogs.
 *
 * - Focuses the first focusable element inside `containerRef` when `active`
 *   transitions to true (with a fallback to the container itself).
 * - While `active`, intercepts Tab / Shift+Tab so focus cycles within the
 *   container instead of escaping to background app chrome.
 * - When `active` transitions to false, restores focus to whatever owned it
 *   when the trap was activated.
 *
 * The hook is intentionally a few dozen lines of dependency-free code rather
 * than a full library import — accessibility for three modals does not
 * justify the bundle weight of `react-focus-lock`.
 */
import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function getFocusable(container: HTMLElement): HTMLElement[] {
  const nodes = Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  );
  return nodes.filter(
    (el) =>
      // Filter out elements that exist but aren't actually visible/focusable
      // (e.g. hidden via CSS). offsetParent is null for display:none.
      el.offsetParent !== null || el === document.activeElement,
  );
}

export function useFocusTrap<T extends HTMLElement>(
  containerRef: RefObject<T | null>,
  active: boolean,
): void {
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    previouslyFocusedRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    // Defer to a microtask so the modal's autofocus inputs (e.g. the first
    // text field in ParamPromptDialog) win over the container fallback.
    queueMicrotask(() => {
      const focusable = getFocusable(container);
      if (focusable.length > 0) {
        if (!container.contains(document.activeElement)) {
          focusable[0].focus();
        }
      } else {
        container.focus();
      }
    });

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const focusable = getFocusable(container);
      if (focusable.length === 0) {
        e.preventDefault();
        container.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (active === first || !container.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      const previouslyFocused = previouslyFocusedRef.current;
      previouslyFocusedRef.current = null;
      // Restore focus on close so the user lands back where they were
      // (typically the editor) instead of on document.body.
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }, [active, containerRef]);
}
