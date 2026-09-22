import type { ComponentType } from "react";

import { Button } from "@/components/ui/button";

/**
 * A controlled tab switch — the same track-of-buttons look as the form/markdown
 * switch on an agent's page, generalised to any number of tabs. It owns no
 * state and no data: the caller holds `value` (usually mirrored to the URL)
 * and decides what each tab renders.
 */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: readonly { id: T; label: string; icon?: ComponentType<{ className?: string }> }[];
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="flex rounded-md border p-0.5">
      {tabs.map((t) => {
        const Icon = t.icon;
        return (
          <Button
            key={t.id}
            variant={value === t.id ? "secondary" : "ghost"}
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => onChange(t.id)}
          >
            {Icon && <Icon className="size-3.5" />}
            {t.label}
          </Button>
        );
      })}
    </div>
  );
}
