"use client";

import { useEffect, useState } from "react";
import { Copy, Check } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function GatewayInfo() {
  const [origin, setOrigin] = useState("http://localhost:4141");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const baseUrl = `${origin}/api/gateway`;

  function copy() {
    navigator.clipboard.writeText(baseUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Gateway endpoint</CardTitle>
        <CardDescription>
          Point any Anthropic-compatible client at this base URL.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2">
          <code className="flex-1 truncate rounded-md border bg-muted px-3 py-2 text-xs">
            {baseUrl}
          </code>
          <Button variant="outline" size="icon" onClick={copy} aria-label="Copy">
            {copied ? <Check className="text-emerald-500" /> : <Copy />}
          </Button>
        </div>
        <div className="space-y-1 text-xs text-muted-foreground">
          <p className="font-medium text-foreground">Claude Code:</p>
          <code className="block rounded bg-muted px-2 py-1">
            ANTHROPIC_BASE_URL={baseUrl} claude
          </code>
          <p className="mt-2 font-medium text-foreground">Anthropic SDK:</p>
          <code className="block rounded bg-muted px-2 py-1">baseURL: &quot;{baseUrl}&quot;</code>
        </div>
      </CardContent>
    </Card>
  );
}
