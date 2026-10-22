import { useCallback, useEffect, useState } from "react";
import { Helmet } from "react-helmet-async";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

type Visit = {
  id: string;
  booking_id: string;
  client_name: string | null;
  client_email: string | null;
  service: string | null;
  visit_date: string | null;
  window: string | null;
  address: string | null;
  access_notes: string | null;
  amount_cents: number | null;
  status: string;
  report_status: string;
  cleaner_name: string | null;
  issue_open: boolean;
  issue_ever: boolean;
  report_bounced: boolean;
  paid_at: string | null;
  is_test: boolean;
  checklist: { rooms?: { name: string; items: { label: string; done: boolean }[]; skip_reason?: string }[]; problem_note?: string };
  photo_count?: number;
};

type Photo = { id: string; room: string; kind: string; note: string | null; url: string | null };
type GhEvent = { id: number; actor: string; event: string; detail: Record<string, unknown> | null; created_at: string };

const money = (cents: number | null): string =>
  cents ? `$${(cents / 100).toFixed(2).replace(/\.00$/, "")}` : "—";

const Owner = () => {
  const [token, setToken] = useState(() => sessionStorage.getItem("gh_admin_token") ?? "");
  const [tokenInput, setTokenInput] = useState("");
  const [visits, setVisits] = useState<Visit[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Visit | null>(null);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [events, setEvents] = useState<GhEvent[]>([]);
  const [stripeState, setStripeState] = useState("");
  const [actionMsg, setActionMsg] = useState("");
  const [cleanerUrl, setCleanerUrl] = useState("");
  const [returnNote, setReturnNote] = useState("");
  const [confirmDate, setConfirmDate] = useState("");
  const [confirmWindow, setConfirmWindow] = useState("");
  const [cleanerName, setCleanerName] = useState("");

  const headers = useCallback(
    () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" }),
    [token],
  );

  const loadList = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError("");
    try {
      const r = await fetch("/api/owner?view=list", { headers: headers() });
      const j = (await r.json()) as { ok: boolean; visits?: Visit[]; error?: string };
      if (!j.ok) {
        setError(j.error === "unauthorized" ? "Token rejected — check the admin token." : j.error === "db_not_configured" ? "Database isn't connected yet (SUPABASE env vars missing)." : "Couldn't load visits.");
        setVisits([]);
      } else {
        setVisits(j.visits ?? []);
      }
    } catch {
      setError("Network error while loading visits.");
    }
    setLoading(false);
  }, [token, headers]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const openVisit = async (v: Visit) => {
    setSelected(v);
    setPhotos([]);
    setEvents([]);
    setStripeState("");
    setActionMsg("");
    setCleanerUrl("");
    setConfirmDate(v.visit_date ?? "");
    setConfirmWindow(v.window ?? "");
    setCleanerName(v.cleaner_name ?? "");
    try {
      const r = await fetch(`/api/owner?view=detail&visit_id=${v.id}`, { headers: headers() });
      const j = (await r.json()) as { ok: boolean; visit?: Visit; photos?: Photo[]; events?: GhEvent[] };
      if (j.ok && j.visit) {
        setSelected(j.visit);
        setPhotos(j.photos ?? []);
        setEvents(j.events ?? []);
      }
      const sr = await fetch("/api/booking-action", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ action: "status", booking_id: v.booking_id }),
      });
      const sj = (await sr.json()) as { ok: boolean; ops?: { state?: string } };
      if (sj.ok && sj.ops?.state) setStripeState(sj.ops.state);
    } catch {
      setActionMsg("Couldn't load the visit details.");
    }
  };

  const act = async (payload: Record<string, unknown>): Promise<Record<string, unknown> & { ok: boolean; error?: string }> => {
    const r = await fetch("/api/booking-action", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(payload),
    });
    return (await r.json()) as Record<string, unknown> & { ok: boolean; error?: string };
  };

  const runAction = async (label: string, payload: Record<string, unknown>, after?: (j: Record<string, unknown>) => void) => {
    setActionMsg(`${label}: working…`);
    const j = await act(payload);
    if (j.ok) {
      setActionMsg(`${label}: done.`);
      after?.(j);
      void loadList();
      if (selected) {
        const fresh = visits.find((x) => x.id === selected.id);
        if (fresh) void openVisit(fresh);
      }
    } else {
      setActionMsg(`${label}: ${j.error ?? "failed"}${j["report_status"] ? ` (report: ${String(j["report_status"])})` : ""}`);
    }
  };

  if (!token) {
    return (
      <div className="min-h-screen bg-background px-4 py-16">
        <Helmet><meta name="robots" content="noindex,nofollow" /></Helmet>
        <div className="max-w-sm mx-auto text-center">
          <h1 className="font-heading text-3xl font-bold mb-4">Owner view</h1>
          <p className="text-sm text-muted-foreground mb-4">Enter the admin token to see visits.</p>
          <input
            type="password"
            className="w-full border border-border rounded-lg px-3 py-2 mb-3 bg-background"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder="ADMIN_TOKEN"
          />
          <Button
            variant="hero"
            className="w-full"
            onClick={() => {
              sessionStorage.setItem("gh_admin_token", tokenInput.trim());
              setToken(tokenInput.trim());
            }}
          >
            Open
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Helmet><meta name="robots" content="noindex,nofollow" /></Helmet>
      <div className="max-w-5xl mx-auto px-4 py-6">
        <div className="flex items-center justify-between mb-4">
          <h1 className="font-heading text-3xl font-bold">Visits</h1>
          <Button variant="outline" size="sm" onClick={() => void loadList()}>
            <RefreshCw className="w-4 h-4 mr-1" /> Refresh
          </Button>
        </div>
        {error && <p className="text-sm text-destructive mb-3" role="alert">{error}</p>}
        {loading && <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />}

        {!selected && (
          <div className="space-y-2">
            {visits.map((v) => (
              <button
                key={v.id}
                type="button"
                className="w-full text-left rounded-xl border border-border bg-card p-4 hover:border-primary"
                onClick={() => void openVisit(v)}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{v.client_name ?? "—"}</span>
                  {v.is_test && <span className="text-[10px] bg-amber-100 text-amber-900 px-1.5 py-0.5 rounded">TEST</span>}
                  <span className="text-sm text-muted-foreground">{v.visit_date ?? "no date"} {v.window ?? ""}</span>
                  <span className="text-sm">{money(v.amount_cents)}</span>
                </div>
                <div className="flex flex-wrap gap-1.5 mt-2 text-[11px]">
                  <span className="bg-muted px-2 py-0.5 rounded">visit: {v.status}</span>
                  <span className="bg-muted px-2 py-0.5 rounded">report: {v.report_status}</span>
                  <span className="bg-muted px-2 py-0.5 rounded">photos: {v.photo_count ?? 0}</span>
                  {v.paid_at && <span className="bg-green-100 text-green-900 px-2 py-0.5 rounded">paid</span>}
                  {v.issue_open && <span className="bg-red-100 text-red-900 px-2 py-0.5 rounded">issue open</span>}
                  {v.report_bounced && <span className="bg-red-100 text-red-900 px-2 py-0.5 rounded">report email issue</span>}
                </div>
              </button>
            ))}
            {visits.length === 0 && !loading && !error && (
              <p className="text-muted-foreground text-sm">No visits in the database yet.</p>
            )}
          </div>
        )}

        {selected && (
          <div>
            <button type="button" className="text-sm underline text-muted-foreground mb-3" onClick={() => setSelected(null)}>
              ← All visits
            </button>
            <h2 className="font-heading text-2xl font-bold">{selected.client_name ?? "—"}</h2>
            <p className="text-sm text-muted-foreground mb-1">
              {selected.service ?? ""} · {selected.visit_date ?? "no date"} {selected.window ?? ""} · {money(selected.amount_cents)}
            </p>
            <p className="text-sm mb-1">{selected.address ?? ""}</p>
            {selected.access_notes && <p className="text-sm mb-1">Access: {selected.access_notes}</p>}
            <p className="text-sm mb-3">
              Visit: <strong>{selected.status}</strong> · Report: <strong>{selected.report_status}</strong>
              {stripeState && <> · Stripe: <strong>{stripeState}</strong></>}
              {selected.issue_open && <> · <span className="text-destructive font-semibold">Issue open</span></>}
            </p>
            {selected.checklist?.problem_note && (
              <div className="rounded-xl border border-amber-500/50 bg-amber-50 p-3 mb-3">
                <p className="text-sm font-semibold">Cleaner&apos;s note</p>
                <p className="text-sm">{selected.checklist.problem_note}</p>
              </div>
            )}

            <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 mb-4">
              {photos.map((p) => (
                <div key={p.id} className="relative">
                  {p.url ? (
                    <img src={p.url} alt={`${p.room} ${p.kind}`} className="rounded-lg object-cover w-full h-24" />
                  ) : (
                    <div className="rounded-lg bg-muted w-full h-24" />
                  )}
                  <span className="absolute left-1 top-1 text-[10px] bg-black/60 text-white px-1.5 py-0.5 rounded">
                    {p.room} · {p.kind}
                  </span>
                </div>
              ))}
            </div>

            <div className="rounded-xl border border-border bg-card p-4 mb-4 space-y-4">
              <div>
                <p className="font-semibold mb-2">Confirm date & cleaner</p>
                <div className="flex flex-wrap gap-2">
                  <input type="date" className="border border-border rounded-lg px-3 py-2 bg-background text-sm" value={confirmDate} onChange={(e) => setConfirmDate(e.target.value)} />
                  <input type="text" className="border border-border rounded-lg px-3 py-2 bg-background text-sm" placeholder="Window, e.g. 8–10 AM" value={confirmWindow} onChange={(e) => setConfirmWindow(e.target.value)} />
                  <Button variant="outline" onClick={() => void runAction("Confirm date", { action: "confirm", booking_id: selected.booking_id, confirmed_date: confirmDate, confirmed_window: confirmWindow })}>
                    Confirm date
                  </Button>
                </div>
                <div className="flex flex-wrap gap-2 mt-2">
                  <input type="text" className="border border-border rounded-lg px-3 py-2 bg-background text-sm" placeholder="Cleaner name" value={cleanerName} onChange={(e) => setCleanerName(e.target.value)} />
                  <Button variant="outline" onClick={() => void runAction("Set cleaner", { action: "set_cleaner", booking_id: selected.booking_id, cleaner_name: cleanerName })}>
                    Set cleaner
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() =>
                      void runAction("Cleaner link", { action: "cleaner_link", booking_id: selected.booking_id }, (j) => {
                        if (typeof j["url"] === "string") setCleanerUrl(j["url"] as string);
                      })
                    }
                  >
                    Get cleaner link
                  </Button>
                </div>
                {cleanerUrl && (
                  <p className="text-xs mt-2 break-all bg-muted rounded p-2">
                    Send this link to the cleaner (valid 14 days):<br />{cleanerUrl}
                  </p>
                )}
              </div>

              <div>
                <p className="font-semibold mb-2">Report</p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="hero"
                    disabled={selected.report_status !== "submitted" && selected.report_status !== "sent"}
                    onClick={() => void runAction("Send report to client", { action: "send_report", booking_id: selected.booking_id })}
                  >
                    Approve & send report to client
                  </Button>
                </div>
                <div className="flex flex-wrap gap-2 mt-2">
                  <input type="text" className="border border-border rounded-lg px-3 py-2 bg-background text-sm flex-1 min-w-52" placeholder="Note for the cleaner (why the report goes back)" value={returnNote} onChange={(e) => setReturnNote(e.target.value)} />
                  <Button
                    variant="outline"
                    disabled={selected.report_status !== "submitted"}
                    onClick={() => void runAction("Return report", { action: "return_report", booking_id: selected.booking_id, note: returnNote })}
                  >
                    Return to cleaner
                  </Button>
                </div>
              </div>

              <div>
                <p className="font-semibold mb-2">Payment</p>
                <Button
                  variant="outline"
                  onClick={() => void runAction("Charge", { action: "charge", booking_id: selected.booking_id, amount_cents: selected.amount_cents ?? undefined })}
                >
                  Charge {money(selected.amount_cents)}
                </Button>
                <p className="text-xs text-muted-foreground mt-1">
                  Works only after the client approved (or the agreed automatic rule fired). Server errors are shown as-is.
                </p>
              </div>
              {actionMsg && <p className="text-sm" role="status">{actionMsg}</p>}
            </div>

            <div className="rounded-xl border border-border bg-card p-4">
              <p className="font-semibold mb-2">History</p>
              <ul className="space-y-1 text-sm">
                {events.map((e) => (
                  <li key={e.id} className="text-muted-foreground">
                    <span className="text-foreground">{new Date(e.created_at).toLocaleString("en-US")}</span> — {e.actor} · {e.event}
                    {e.detail?.note ? <> — “{String(e.detail.note)}”</> : null}
                  </li>
                ))}
                {events.length === 0 && <li className="text-muted-foreground">No events yet.</li>}
              </ul>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default Owner;
