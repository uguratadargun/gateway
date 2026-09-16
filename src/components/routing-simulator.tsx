"use client";

import { useState } from "react";
import { Wand2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

interface RouteResult {
  model: string;
  tier: "haiku" | "sonnet" | "opus" | "fable";
  reason: string;
}

const tierVariant: Record<string, "secondary" | "default" | "success"> = {
  haiku: "success",
  sonnet: "default",
  opus: "secondary",
  fable: "default",
};

export function RoutingSimulator() {
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("auto");
  const [result, setResult] = useState<RouteResult | null>(null);
  const [busy, setBusy] = useState(false);

  async function simulate() {
    setBusy(true);
    try {
      const res = await fetch("/api/routing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      setResult(await res.json());
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Wand2 className="size-4" /> Routing simulator
        </CardTitle>
        <CardDescription>See which model a prompt would be routed to.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="sim-model">Requested model</Label>
          <Input id="sim-model" value={model} onChange={(e) => setModel(e.target.value)} spellCheck={false} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="sim-prompt">Prompt</Label>
          <Textarea
            id="sim-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            placeholder="e.g. Generate a title for this conversation"
          />
        </div>
        <Button onClick={simulate} disabled={busy} size="sm">
          <Wand2 /> Simulate
        </Button>
        {result && (
          <div className="flex items-center gap-2 rounded-md border bg-muted/50 p-3 text-sm">
            <Badge variant={tierVariant[result.tier]}>{result.tier}</Badge>
            <span className="font-mono text-xs">{result.model}</span>
            <span className="ml-auto text-xs text-muted-foreground">{result.reason}</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
