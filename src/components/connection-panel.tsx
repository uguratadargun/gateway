"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, ExternalLink, LogOut, Plug } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Status {
  connected: boolean;
  email?: string | null;
  organization?: string | null;
  tier?: string | null;
  expiresAt?: number;
  connectedAt?: number;
}

export function ConnectionPanel() {
  const [status, setStatus] = useState<Status | null>(null);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    const res = await fetch("/api/auth/status");
    setStatus(await res.json());
  }

  useEffect(() => {
    refresh();
  }, []);

  async function startLogin() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/start", { method: "POST" });
      const data = await res.json();
      setAuthUrl(data.authUrl);
      window.open(data.authUrl, "_blank", "noopener");
    } finally {
      setBusy(false);
    }
  }

  async function completeLogin() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/callback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Login failed");
        return;
      }
      setAuthUrl(null);
      setCode("");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    await fetch("/api/auth/status", { method: "DELETE" });
    await refresh();
  }

  if (status?.connected) {
    return (
      <Card>
        <CardHeader className="flex-row items-start justify-between space-y-0">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2">
              <CheckCircle2 className="text-emerald-500" /> Account connected
            </CardTitle>
            <CardDescription>
              {status.email ?? "Signed in"}
              {status.organization ? ` · ${status.organization}` : ""}
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={logout}>
            <LogOut /> Disconnect
          </Button>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2 text-sm">
          {status.tier && <Badge variant="success">tier: {status.tier}</Badge>}
          {status.connectedAt && (
            <Badge variant="secondary">
              since {new Date(status.connectedAt).toLocaleDateString()}
            </Badge>
          )}
          <Badge variant="outline">token auto-refreshes</Badge>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Plug /> Connect your Claude account
        </CardTitle>
        <CardDescription>
          Uses the same Claude Code OAuth login (PKCE). Open the page, approve, then paste the code
          Anthropic shows you.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!authUrl ? (
          <Button onClick={startLogin} disabled={busy}>
            <ExternalLink /> Start Claude login
          </Button>
        ) : (
          <div className="space-y-3">
            <a
              href={authUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-primary underline underline-offset-4"
            >
              <ExternalLink className="size-3.5" /> Re-open authorization page
            </a>
            <div className="space-y-2">
              <Label htmlFor="code">Paste authorization code</Label>
              <div className="flex gap-2">
                <Input
                  id="code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="code#state"
                  autoComplete="off"
                />
                <Button onClick={completeLogin} disabled={busy || !code.trim()}>
                  Connect
                </Button>
              </div>
            </div>
          </div>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
