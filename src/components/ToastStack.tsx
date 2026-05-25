/** Lightweight toast notifications (paste summary, copy confirmations). */

import React, { useEffect, useState } from "react";

export interface ToastItem {
  id: number;
  message: string;
}

const TOAST_MS = 6000;

let nextToastId = 1;
let pushToastHandler: ((message: string) => void) | null = null;

/** Queue a toast from anywhere (registered by App on mount). */
export function showAppToast(message: string): void {
  pushToastHandler?.(message);
}

export function ToastStack() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  useEffect(() => {
    pushToastHandler = (message: string) => {
      const id = nextToastId++;
      setToasts((prev) => [...prev, { id, message }]);
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, TOAST_MS);
    };
    return () => {
      pushToastHandler = null;
    };
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed z-[60] flex flex-col gap-2 pointer-events-none"
      style={{
        right: "16px",
        bottom: "48px",
        maxWidth: "min(420px, 92vw)",
        fontFamily: "var(--ui-font-family)",
        fontSize: "var(--ui-font-size-sm)",
      }}
      data-testid="toast-stack"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          data-testid="toast-item"
          className="rounded-lg px-3 py-2 shadow-lg pointer-events-auto"
          style={{
            backgroundColor: "var(--bg-secondary)",
            border: "1px solid var(--border-primary)",
            color: "var(--text-primary)",
          }}
        >
          {toast.message}
        </div>
      ))}
    </div>
  );
}
