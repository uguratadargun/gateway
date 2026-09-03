import { ConnectionPanel } from "@/components/connection-panel";
import { GatewayInfo } from "@/components/gateway-info";
import { KeysPanel } from "@/components/keys-panel";
import { OverviewPanel } from "@/components/overview-panel";
import { RoutingRulesPanel } from "@/components/routing-rules-panel";
import { RoutingSimulator } from "@/components/routing-simulator";
import { SettingsPanel } from "@/components/settings-panel";
import { UsagePanel } from "@/components/usage-panel";

export default function Home() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          One Claude login. Context-aware routing across Haiku, Sonnet, and Opus.
        </p>
      </header>

      <div className="grid gap-6">
        <ConnectionPanel />
        <OverviewPanel />
        <GatewayInfo />
        <div className="grid gap-6 md:grid-cols-2">
          <RoutingRulesPanel />
          <RoutingSimulator />
        </div>
        <div className="grid gap-6 md:grid-cols-2">
          <SettingsPanel />
          <KeysPanel />
        </div>
        <UsagePanel />
      </div>
    </main>
  );
}
