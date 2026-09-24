import type React from "react";
import { Cpu, SlidersHorizontal } from "lucide-react";

import { ProvidersPanel } from "@/components/providers-panel";
import { SettingsPanel } from "@/components/settings-panel";

/**
 * One band of the page: a heading and the cards that answer it. The headings
 * live here rather than inside the panels so every one of them is the same
 * shape, and so a panel is only ever a card.
 */
function Section({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4">
      <div>
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <Icon className="size-4" /> {title}
        </h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="grid gap-6">{children}</div>
    </section>
  );
}

export default function Home() {
  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Your team&apos;s pipelines, runs and memory. Every model call a run makes is the person&apos;s own Claude Code
          login, on their own machine; this server holds no Claude account and serves no models.
        </p>
      </header>

      <div className="grid gap-10">
        <Section
          icon={Cpu}
          title="The server's own model"
          description="The one thing this server still asks a model: the recorder that writes what a finished run decided, and memory's embeddings. A provider on your network, or a hosted one."
        >
          <ProvidersPanel />
        </Section>

        <Section icon={SlidersHorizontal} title="Settings" description="Memory and the plugin source. Every card here saves on its own.">
          <SettingsPanel />
        </Section>
      </div>
    </main>
  );
}
