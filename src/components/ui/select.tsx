import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * A plain `<select>` in the shape the rest of the form controls take. It exists
 * because three panels had each declared the same `selectCls` string.
 */
const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, ...props }, ref) => (
    <select
      className={cn(
        "h-8 rounded-md border border-input bg-transparent px-2 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      ref={ref}
      {...props}
    />
  ),
);
Select.displayName = "Select";

export { Select };
