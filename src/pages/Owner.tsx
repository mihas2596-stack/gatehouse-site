import { useCallback, useEffect, useState } from "react";
import { Helmet } from "react-helmet-async";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { convertToJpeg } from "@/lib/imageConvert";

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
  cleaner_link_issued?: boolean;
  cleaner_link_active?: boolean;
  cleaner_link_expires?: string | null;
  cleaner_link_opened_at?: string | null;
  issue_open: boolean;
  issue_ever: boolean;
  report_bounced: boolean;
  paid_at: string | null;
  is_test: boolean;
  checklist: { rooms?: { name: string; items: { label: string; done: boolean }[]; skip_reason?: string }[]; problem_note?: string; submitted_at?: string };
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
  const [acting, setActing] = useState("");
  const [publishMsg, setPublishMsg] = useState("");
  const [cleanerMsg, setCleanerMsg] = useState("");
  const [ownerRoom, setOwnerRoom] = useState("Kitchen");
  const [ownerKind, setOwnerKind] = useState<"before" | "after">("after");

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
    setActing(label);
    setActionMsg(`${label}: working…`);
    const j = await act(payload);
    setActing("");
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

  const ownerUpload = async (files: FileList | null) => {
    if (!selected || !files || files.length === 0) return;
    setActing("Owner upload");
    setActionMsg("Owner upload: working…");
    try {
      for (const f of Array.from(files)) {
        const blob = await convertToJpeg(f);
        const sign = await act({ action: "owner_photo_sign", booking_id: selected.booking_id, room: ownerRoom, kind: ownerKind });
        if (!sign.ok || typeof sign["upload_url"] !== "string" || typeof sign["storage_path"] !== "string") {
          throw new Error("sign failed");
        }
        const put = await fetch(sign["upload_url"] as string, {
          method: "PUT",
          headers: { "Content-Type": "image/jpeg", "x-upsert": "false" },
          body: blob,
        });
        if (!put.ok) throw new Error("upload failed");
        const reg = await act({
          action: "owner_photo_register",
          booking_id: selected.booking_id,
          room: ownerRoom,
          kind: ownerKind,
          storage_path: sign["storage_path"],
        });
        if (!reg.ok) throw new Error(typeof reg.error === "string" ? reg.error : "register failed");
      }
      setActionMsg("Owner upload: done.");
      void openVisit(selected);
    } catch (err) {
      setActionMsg(`Owner upload: ${err instanceof Error ? err.message : "failed"}`);
    }
    setActing("");
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

        {!selected && visits.some((v) => v.report_status === "submitted") && (
          <div className="mb-5">
            <h2 className="font-heading text-xl font-bold mb-2">Reports awaiting review</h2>
            <div className="space-y-2">
              {visits
                .filter((v) => v.report_status === "submitted")
                .map((v) => {
                  const since = v.checklist?.submitted_at ? Date.parse(v.checklist.submitted_at) : NaN;
                  const hours = Number.isFinite(since) ? Math.max(0, Math.round((Date.now() - since) / 3600000)) : null;
                  return (
                    <button
                      key={v.id}
                      type="button"
                      className="w-full text-left rounded-xl border border-amber-500/60 bg-amber-50 p-4 hover:border-primary"
                      onClick={() => void openVisit(v)}
                    >
                      <span className="font-semibold">{v.client_name ?? "—"}</span>{" "}
                      <span className="text-sm text-muted-foreground">
                        {v.visit_date ?? ""} · {v.photo_count ?? 0} photos
                        {hours !== null ? <> · waiting {hours < 1 ? "<1" : hours}h</> : null}
                        {v.checklist?.problem_note ? <> · cleaner note attached</> : null}
                      </span>
                    </button>
                  );
                })}
            </div>
          </div>
        )}

        {!selected && (() => {
          const attention = visits.filter((v) =>
            (v.status !== "confirmed" && v.status !== "paid" && v.status !== "cancelled")
            || !v.cleaner_name || v.issue_open || v.report_bounced,
          );
          const reason = (v: typeof visits[number]): string => {
            const parts: string[] = [];
            if (v.status !== "confirmed" && v.status !== "paid" && v.status !== "cancelled") parts.push("needs date confirmation");
            if (!v.cleaner_name) parts.push("no cleaner assigned");
            if (v.issue_open) parts.push("customer issue open");
            if (v.report_bounced) parts.push("report email failed");
            return parts.join(" · ");
          };
          return attention.length > 0 ? (
            <div className="mb-6">
              <h2 className="font-heading text-lg font-bold mb-2">Needs attention</h2>
              <p className="text-sm text-muted-foreground mb-3">
                Bookings waiting on you: confirm the date, assign a cleaner, resolve an issue, or fix a failed email.
              </p>
              <div className="space-y-2">
                {attention.map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    className="w-full text-left rounded-xl border border-amber-500/60 bg-amber-50 p-4 hover:border-primary"
                    onClick={() => void openVisit(v)}
                  >
                    <span className="font-semibold">{v.client_name ?? "—"}</span>{" "}
                    <span className="text-sm text-muted-foreground">{v.visit_date ?? "no date"} · {money(v.amount_cents)}</span>
                    <span className="block text-sm text-amber-900 mt-1">{reason(v)}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null;
        })()}

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
                  {v.cleaner_name
                    ? <span className="bg-sky-100 text-sky-900 px-2 py-0.5 rounded">cleaner: {v.cleaner_name}</span>
                    : <span className="bg-amber-100 text-amber-900 px-2 py-0.5 rounded">no cleaner</span>}
                  {v.cleaner_link_active
                    ? <span className="bg-green-100 text-green-900 px-2 py-0.5 rounded">link active{v.cleaner_link_opened_at ? " · opened" : " · not opened"}</span>
                    : v.cleaner_link_issued
                      ? <span className="bg-red-100 text-red-900 px-2 py-0.5 rounded">link expired</span>
                      : v.cleaner_name
                        ? <span className="bg-amber-100 text-amber-900 px-2 py-0.5 rounded">no link yet</span>
                        : null}
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

            {(selected.checklist?.rooms ?? []).length > 0 && (
              <div className="rounded-xl border border-border bg-card p-4 mb-4">
                <p className="font-semibold mb-2">Checklist & exceptions</p>
                <ul className="space-y-1 text-sm">
                  {(selected.checklist?.rooms ?? []).map((r) => {
                    const done = r.items.filter((i) => i.done).length;
                    return (
                      <li key={r.name}>
                        <span className="font-medium">{r.name}:</span> {done}/{r.items.length} done
                        {r.skip_reason ? (
                          <> · <span className="text-amber-700">Exception: {r.skip_reason}</span></>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {Object.entries(
              photos.reduce<Record<string, Photo[]>>((acc, ph) => {
                (acc[ph.room] ??= []).push(ph);
                return acc;
              }, {}),
            ).map(([room, items]) => (
              <div key={room} className="mb-4">
                <p className="font-semibold mb-2">{room}</p>
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                  {[...items]
                    .sort((a, b) => (a.kind === "before" ? 0 : 1) - (b.kind === "before" ? 0 : 1))
                    .map((ph) => (
                      <div key={ph.id} className="relative">
                        {ph.url ? (
                          <img src={ph.url} alt={`${ph.room} ${ph.kind}`} className="rounded-lg object-cover w-full h-24" />
                        ) : (
                          <div className="rounded-lg bg-muted w-full h-24" />
                        )}
                        <span className="absolute left-1 top-1 text-[10px] bg-black/60 text-white px-1.5 py-0.5 rounded">
                          {ph.kind === "client" ? "From customer" : ph.kind === "before" ? "Before" : "After"}
                        </span>
                        <button
                          type="button"
                          aria-label="Delete photo"
                          className="absolute right-1 top-1 bg-black/60 text-white rounded px-1.5 py-0.5 text-[10px]"
                          onClick={() =>
                            void runAction("Delete photo", { action: "owner_photo_delete", booking_id: selected.booking_id, photo_id: ph.id })
                          }
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                </div>
              </div>
            ))}

            <div className="rounded-xl border border-border bg-card p-4 mb-4 space-y-4">
              <div>
                <div className="rounded-lg border border-border bg-muted/40 p-3 mb-3 text-sm space-y-1">
                  <p className="font-semibold">Cleaner & link</p>
                  <p>Cleaner: <strong>{selected.cleaner_name ?? "not assigned"}</strong></p>
                  <p>
                    Link:{" "}
                    {selected.cleaner_link_active ? (
                      <strong>active{selected.cleaner_link_expires ? ` until ${selected.cleaner_link_expires.slice(0, 10)}` : ""}</strong>
                    ) : selected.cleaner_link_issued ? (
                      <strong className="text-destructive">expired — revoke & replace it below</strong>
                    ) : (
                      <strong>not issued yet — assign a cleaner or use “Revoke & replace link”</strong>
                    )}
                  </p>
                  <p>
                    Opened by cleaner:{" "}
                    {selected.cleaner_link_opened_at ? (
                      <strong>yes — {selected.cleaner_link_opened_at.slice(0, 10)}</strong>
                    ) : (
                      <strong>not yet</strong>
                    )}
                  </p>
                  <p className="text-muted-foreground">
                    A link can&apos;t be shown again after this panel closes (only its fingerprint is stored).
                    If it&apos;s lost, “Revoke & replace link” issues a new one and kills the old.
                  </p>
                </div>
                <p className="font-semibold mb-2">Confirm visit</p>
                <p className="text-sm text-muted-foreground mb-2">
                  Pick the cleaner, set the agreed date and window, then Confirm visit. The client sees the
                  confirmed date and cleaner, the job appears in the cleaner&apos;s workspace, and the client
                  gets a confirmation email. If you agree a different date, use “Propose another time” below
                  instead — a proposal is not a confirmation.
                </p>
                <div className="flex flex-wrap gap-2">
                  <input type="date" className="border border-border rounded-lg px-3 py-2 bg-background text-sm" value={confirmDate} onChange={(e) => setConfirmDate(e.target.value)} />
                  <input type="text" className="border border-border rounded-lg px-3 py-2 bg-background text-sm" placeholder="Window, e.g. 8–10 AM" value={confirmWindow} onChange={(e) => setConfirmWindow(e.target.value)} />
                  <Button variant="outline" onClick={() => void runAction("Confirm visit", { action: "confirm", booking_id: selected.booking_id, confirmed_date: confirmDate, confirmed_window: confirmWindow }, (j) => {
                        setActionMsg(j["email_sent"] === true
                          ? "Confirm visit: done. The client confirmation email was sent."
                          : "Confirm visit: saved, but the confirmation email was NOT delivered — email the client manually or retry.");
                      })}>
                    Confirm visit
                  </Button>
                </div>
                <div className="flex flex-wrap gap-2 mt-2">
                  <input type="text" className="border border-border rounded-lg px-3 py-2 bg-background text-sm" placeholder="Cleaner name" value={cleanerName} onChange={(e) => setCleanerName(e.target.value)} />
                  <Button variant="outline" onClick={() => void runAction("Assign cleaner", { action: "set_cleaner", booking_id: selected.booking_id, cleaner_name: cleanerName }, (j) => {
                        if (typeof j["url"] === "string") {
                          setCleanerUrl(j["url"] as string);
                          setCleanerMsg("");
                        }
                      })}>
                    Assign / change cleaner
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() =>
                      void runAction("Revoke & replace link", { action: "cleaner_link", booking_id: selected.booking_id }, (j) => {
                        if (typeof j["url"] === "string") {
                          setCleanerUrl(j["url"] as string);
                          setCleanerMsg("");
                        }
                      })
                    }
                  >
                    Revoke & replace link
                  </Button>
                </div>
                {cleanerUrl && (
                  <div className="mt-2">
                    <div className="flex flex-wrap gap-2 mb-2">
                      <Button
                        variant="hero"
                        size="sm"
                        onClick={() => {
                          void navigator.clipboard?.writeText(cleanerUrl);
                          setActionMsg("Cleaner link copied.");
                        }}
                      >
                        Copy cleaner link
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => window.open(`${cleanerUrl}&pv=1`, "_blank")}
                      >
                        Preview cleaner workspace
                      </Button>
                    </div>
                    <input
                      readOnly
                      className="w-full text-xs bg-muted rounded p-2 mb-2"
                      value={cleanerUrl}
                      onFocus={(e) => e.target.select()}
                      aria-label="Cleaner link (select and copy if the button does not work)"
                    />
                    <p className="text-xs mb-1">Ready-to-send message for the cleaner — the link stays valid through the visit date + 2 days (at least 14 days). Replacing the link or changing the cleaner revokes the previous one, and a cleaner change emails the client in advance:</p>
                    <textarea
                      readOnly
                      rows={7}
                      className="w-full text-xs bg-muted rounded p-2"
                      value={cleanerMsg || `Hi! Here is your Gatehouse job link for ${selected.visit_date ?? "the visit"}${selected.address ? ` at ${selected.address}` : ""}:\n${cleanerUrl}\n\nOpen it on your phone — no app needed. For each room: take a “before” photo before you start and an “after” photo when you finish, check off the list, then submit the report. If a room can't be photographed, write the reason in the room's field. Thank you!`}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-1"
                      onClick={() => {
                        const text = cleanerMsg || `Hi! Here is your Gatehouse job link for ${selected.visit_date ?? "the visit"}${selected.address ? ` at ${selected.address}` : ""}:\n${cleanerUrl}\n\nOpen it on your phone — no app needed. For each room: take a “before” photo before you start and an “after” photo when you finish, check off the list, then submit the report. If a room can't be photographed, write the reason in the room's field. Thank you!`;
                        void navigator.clipboard?.writeText(text);
                        setCleanerMsg(text);
                        setActionMsg("Cleaner message copied.");
                      }}
                    >
                      Copy message
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-1 ml-2"
                      onClick={() => {
                        const text = cleanerMsg || `Hi! Here is your Gatehouse job link for ${selected.visit_date ?? "the visit"}${selected.address ? ` at ${selected.address}` : ""}:\n${cleanerUrl}\n\nOpen it on your phone — no app needed. For each room: take a “before” photo before you start and an “after” photo when you finish, check off the list, then submit the report. If a room can't be photographed, write the reason in the room's field. Thank you!`;
                        window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank");
                      }}
                    >
                      Send via WhatsApp
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-1 ml-2"
                      onClick={() => {
                        const text = cleanerMsg || `Hi! Here is your Gatehouse job link for ${selected.visit_date ?? "the visit"}${selected.address ? ` at ${selected.address}` : ""}:\n${cleanerUrl}\n\nOpen it on your phone — no app needed. For each room: take a “before” photo before you start and an “after” photo when you finish, check off the list, then submit the report. If a room can't be photographed, write the reason in the room's field. Thank you!`;
                        window.open(`sms:?body=${encodeURIComponent(text)}`, "_blank");
                      }}
                    >
                      Send via SMS
                    </Button>
                  </div>
                )}
              </div>

              <div>
                <p className="font-semibold mb-2">Report review</p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="hero"
                    disabled={acting !== "" || (selected.report_status !== "submitted" && selected.report_status !== "sent")}
                    onClick={() => {
                      if (selected.issue_open && !window.confirm("This booking has an OPEN customer issue. Re-sending the report will mark the issue RESOLVED and restart the 24-hour review clock. Continue?")) return;
                      void runAction("Publish & notify customer", { action: "send_report", booking_id: selected.booking_id, ...(selected.issue_open ? { resolve_issue: true } : {}) }, (j) => {
                        setPublishMsg(
                          j["email_sent"] === true
                            ? "Published. The customer email was sent — the 24-hour review period is running from the send time."
                            : "Published and saved, but the customer email was NOT delivered — the review period is paused. Check the report email status and publish again to retry.",
                        );
                      });
                    }}
                  >
                    Publish & notify customer
                  </Button>
                  <Button
                    variant="outline"
                    disabled={acting !== ""}
                    onClick={() =>
                      void runAction("Preview", { action: "preview_link", booking_id: selected.booking_id }, (j) => {
                        if (typeof j["report_url"] === "string") window.open(j["report_url"] as string, "_blank");
                      })
                    }
                  >
                    Preview customer report
                  </Button>
                </div>
                {publishMsg && <p className="text-sm mt-2" role="status">{publishMsg}</p>}
                <div className="flex flex-wrap gap-2 mt-2">
                  <input type="text" className="border border-border rounded-lg px-3 py-2 bg-background text-sm flex-1 min-w-52" placeholder="What needs to change? (the cleaner sees this note)" value={returnNote} onChange={(e) => setReturnNote(e.target.value)} />
                  <Button
                    variant="outline"
                    disabled={acting !== "" || selected.report_status !== "submitted"}
                    onClick={() => void runAction("Request changes", { action: "return_report", booking_id: selected.booking_id, note: returnNote })}
                  >
                    Request changes
                  </Button>
                </div>
                <div className="mt-3 border-t border-border pt-3">
                  <p className="text-sm font-medium mb-2">Add photos yourself (fallback — e.g. the cleaner texted them to you)</p>
                  <div className="flex flex-wrap gap-2 items-center">
                    <select className="border border-border rounded-lg px-2 py-2 bg-background text-sm" value={ownerRoom} onChange={(e) => setOwnerRoom(e.target.value)}>
                      {[...(selected.checklist?.rooms ?? []).map((r) => r.name), "Other areas"].map((r) => (
                        <option key={r} value={r}>{r}</option>
                      ))}
                    </select>
                    <select className="border border-border rounded-lg px-2 py-2 bg-background text-sm" value={ownerKind} onChange={(e) => setOwnerKind(e.target.value as "before" | "after")}>
                      <option value="after">After</option>
                      <option value="before">Before</option>
                    </select>
                    <label className="rounded-lg border border-border px-3 py-2 text-sm cursor-pointer">
                      Choose photos
                      <input
                        type="file"
                        accept="image/*"
                        multiple
                        className="hidden"
                        onChange={(e) => {
                          void ownerUpload(e.target.files);
                          e.target.value = "";
                        }}
                      />
                    </label>
                  </div>
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
