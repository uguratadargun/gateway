import type React from "react";
import { BarChart3, Plug, Route, SlidersHorizontal, Users } from "lucide-react";

import { AccountsPanel } from "@/components/accounts-panel";
import { ClientsPanel } from "@/components/clients-panel";
import { GatewayInfo } from "@/components/gateway-info";
import { KeysPanel } from "@/components/keys-panel";
import { ProvidersPanel } from "@/components/providers-panel";
import { OverviewPanel } from "@/components/overview-panel";
import { RoutingRulesPanel } from "@/components/routing-rules-panel";
import { SettingsPanel } from "@/components/settings-panel";
import { UsagePanel } from "@/components/usage-panel";

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
          Pooled Claude logins and whatever else you point it at. Context-aware routing across
          Haiku, Sonnet, Opus, Fable — and any provider you add, hosted or on your own machine.
        </p>
      </header>

      <div className="grid gap-10">
        <Section
          icon={Users}
          title="Accounts"
          description="The logins gate serves from, and what they are doing right now."
        >
          <AccountsPanel />
          <OverviewPanel />
        </Section>

        <Section
          icon={Plug}
          title="Connect"
          description="Where your tools point, and what they need to get in."
        >
          <div className="grid gap-6 md:grid-cols-2">
            <GatewayInfo />
            <ClientsPanel />
          </div>
          <KeysPanel />
        </Section>

        <Section
          icon={Route}
          title="Models"
          description="What each model name resolves to. Every card here saves on its own."
        >
          <ProvidersPanel />
          <RoutingRulesPanel />
        </Section>

        <Section
          icon={SlidersHorizontal}
          title="Gateway settings"
          description="Caching, quota protection, reliability, memory and the plugin source."
        >
          <SettingsPanel />
        </Section>

        <Section
          icon={BarChart3}
          title="Usage"
          description="What has been routed, what it cost, and what the routing saved."
        >
          <UsagePanel />
        </Section>
      </div>
    </main>
  );
}
