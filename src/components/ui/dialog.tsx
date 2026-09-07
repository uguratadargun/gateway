"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * A modal on the native `<dialog>` element.
 *
 * No dependency for this: the platform already gives the hard parts away —
 * focus trapping, Escape, inert background, a real top layer that no z-index
 * on the page can climb over.
 */
export function Dialog({
  open,
  onClose,
  title,
  subtitle,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      // Escape and the backdrop both close it; a modal you can only leave by
      // finding the X is a modal people stop opening.
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className={cn(
        "max-h-[85vh] w-[min(1100px,92vw)] rounded-lg border bg-background p-0 text-foreground shadow-xl",
        "backdrop:bg-black/50 open:flex open:flex-col",
        className,
      )}
    >
      <header className="flex shrink-0 items-start gap-3 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium">{title}</h2>
          {subtitle && <div className="mt-0.5 text-xs text-muted-foreground">{subtitle}</div>}
        </div>
        <button
          onClick={onClose}
          aria-label="Close"
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
    </dialog>
  );
}
