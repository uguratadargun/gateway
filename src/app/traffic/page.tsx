"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Download, RefreshCw, Trash2 } from "lucide-react";

import { LiveActivity } from "@/components/live-activity";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

interface TrafficEntry {
  /** The table's own autoincrement id: the React key and the identity of the
   *  expanded row, so a prepend cannot make `open` point at the wrong row. */
  id: number;
  ts: number;
  endpoint: string;
  requested: string;
  routed: string;
  tier: string;
  status: number;
  stream: boolean;
  fromCache: boolean;
  requestPreview: string;
  responsePreview: string;
  accountId: string | null;
  providerId: string | null;
  keyId: string | null;
  /** The person behind the key, and the account or provider that answered. */
  caller: string;
  servedBy: string;
  team: string;
}

function Detail({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-2">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className={`truncate ${mono ? "font-mono" : ""}`} title={value}>
        {value}
      </dd>
    </div>
  );
}

export default function TrafficPage() {
  const [entries, setEntries] = useState<TrafficEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  /** The expanded row's id, not an index: an index would point at a
   *  different row the moment new rows are prepended. */
  const [open, setOpen] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [retentionDays, setRetentionDays] = useState<number | null>(null);

  // Mirrors of the state above that a poll or loadMore in flight can read
  // synchronously, so a scroll correction can be computed before the state
  // update it corrects for, rather than from a stale closure.
  const entriesRef = useRef<TrafficEntry[]>([]);
  const nextCursorRef = useRef<string | null>(null);
  const loadingMoreRef = useRef(false);
  /** Distance from the bottom to restore after a prepend moves the page
   *  under the reader; null when nothing needs correcting. */
  const keepFromBottom = useRef<number | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);
  useEffect(() => {
    nextCursorRef.current = nextCursor;
  }, [nextCursor]);

  async function load() {
    const r = await fetch("/api/traffic?limit=100");
    const data = await r.json();
    setEntries(data.entries);
    setNextCursor(data.nextCursor);
    setOpen(null);
  }

  /** The 6s poll: merges new rows at the top and never touches `nextCursor`
   *  — overwriting it would throw away every page already paged in. */
  const poll = useCallback(async () => {
    const r = await fetch("/api/traffic?limit=100");
    const data = await r.json();
    const held = entriesRef.current;
    const heldIds = new Set(held.map((e) => e.id));
    const fetchedIds = new Set(data.entries.map((e: TrafficEntry) => e.id));
    const overlaps = held.some((e) => fetchedIds.has(e.id));

    if (held.length > 0 && !overlaps) {
      // The fetched page and the held list share no id at all: the list has
      // fallen behind by more than a page, or the log was cleared. Merging
      // here would leave a silent hole in the middle, so start over.
      setEntries(data.entries);
      setNextCursor(data.nextCursor);
      return;
    }

    const fresh = data.entries.filter((e: TrafficEntry) => !heldIds.has(e.id));
    if (fresh.length === 0) return;

    if (window.scrollY > 0) {
      keepFromBottom.current = document.documentElement.scrollHeight - window.scrollY;
    }
    setEntries([...fresh, ...held]);
  }, []);

  /** Loads the next older page when the sentinel comes into view. */
  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current || !nextCursorRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const r = await fetch(`/api/traffic?limit=100&before=${nextCursorRef.current}`);
      const data = await r.json();
      const heldIds = new Set(entriesRef.current.map((e) => e.id));
      const fresh = data.entries.filter((e: TrafficEntry) => !heldIds.has(e.id));
      setEntries([...entriesRef.current, ...fresh]);
      setNextCursor(data.nextCursor);
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, []);

  async function clear() {
    await fetch("/api/traffic", { method: "DELETE" });
    setEntries([]);
    setNextCursor(null);
    setOpen(null);
    await load();
  }

  useEffect(() => {
    load();
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => setRetentionDays(d?.traffic?.retentionDays ?? null))
      .catch(() => {});
    const t = setInterval(poll, 6000);
    return () => clearInterval(t);
  }, [poll]);

  // The window is the scroller (no overflow container in the layout), and a
  // prepend above the viewport shifts everything else down by its height.
  // Scroll anchoring cannot be relied on — Safari has none — so a prepend is
  // compensated explicitly: keep the distance from the bottom constant.
  // Appending older pages at the bottom needs no correction, and a reader at
  // the top (scrollY === 0) is left there so new rows simply appear.
  useLayoutEffect(() => {
    if (keepFromBottom.current == null) return;
    window.scrollTo({ top: document.documentElement.scrollHeight - keepFromBottom.current });
    keepFromBottom.current = null;
  }, [entries]);

  // No button: a sentinel after the last row loads the next page as it nears
  // the viewport. Nothing observes once the log has no more pages.
  useEffect(() => {
    if (!nextCursor) return;
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (observed) => {
        if (observed[0]?.isIntersecting) loadMore();
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [nextCursor, loadMore]);

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-6 py-8">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Traffic</h1>
          <p className="text-sm text-muted-foreground">Live feed and local request/response log (truncated).</p>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => (window.location.href = "/api/export?what=traffic&format=json")}>
            <Download /> Export
          </Button>
          <Button variant="ghost" size="icon" onClick={load} aria-label="Refresh">
            <RefreshCw />
          </Button>
          <Button variant="ghost" size="icon" onClick={clear} aria-label="Clear">
            <Trash2 />
          </Button>
        </div>
      </header>

      <LiveActivity />

      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">No traffic yet.</p>
      ) : (
        <div className="space-y-2">
          {entries.map((e) => (
            <Card key={e.id} className="overflow-hidden">
              <button className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-muted/40" onClick={() => setOpen(open === e.id ? null : e.id)}>
                <span className="text-xs tabular-nums text-muted-foreground">{new Date(e.ts).toLocaleTimeString()}</span>
                <Badge variant="outline" className="max-w-[9rem] truncate" title={e.caller}>
                  {e.caller}
                </Badge>
                <Badge variant="secondary">{e.tier}</Badge>
                {e.fromCache && <Badge variant="success">cache</Badge>}
                <span className="font-mono text-xs text-muted-foreground">{e.routed}</span>
                <span className="text-xs text-muted-foreground">→</span>
                <span className="max-w-[9rem] truncate text-xs text-muted-foreground" title={e.servedBy}>
                  {e.servedBy}
                </span>
                <span className={`ml-auto text-xs ${e.status < 300 ? "text-emerald-500" : "text-destructive"}`}>{e.status}</span>
              </button>
              {open === e.id && (
                <CardContent className="space-y-3 border-t bg-muted/20 pt-3 text-xs">
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
                    <Detail label="Caller" value={e.caller} />
                    <Detail label="Team" value={e.team || "—"} />
                    <Detail label="Key" value={e.keyId ?? "—"} mono />
                    <Detail label="Endpoint" value={e.endpoint} />
                    <Detail label="Requested" value={e.requested} mono />
                    <Detail label="Served by" value={e.servedBy} />
                    <Detail label="Routed" value={e.routed} mono />
                    <Detail label="Account / provider" value={e.accountId ?? e.providerId ?? "—"} mono />
                  </dl>
                  <div>
                    <div className="mb-1 font-medium text-muted-foreground">Request</div>
                    <pre className="overflow-x-auto rounded bg-background p-2">{e.requestPreview}</pre>
                  </div>
                  <div>
                    <div className="mb-1 font-medium text-muted-foreground">Response</div>
                    <pre className="overflow-x-auto rounded bg-background p-2">{e.responsePreview}</pre>
                  </div>
                </CardContent>
              )}
            </Card>
          ))}
          <div ref={sentinelRef} />
          {loadingMore && <p className="py-2 text-center text-xs text-muted-foreground">loading older entries…</p>}
          {!nextCursor && (
            <p className="py-2 text-center text-xs text-muted-foreground">
              That is the whole log kept — {retentionDays ?? "…"} days. Cache hits and refused requests are never logged.
            </p>
          )}
        </div>
      )}
    </main>
  );
}
