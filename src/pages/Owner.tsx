import { useCallback, useEffect, useRef, useState } from "react";
import { Helmet } from "react-helmet-async";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { convertToJpeg } from "@/lib/imageConvert";

type CleanerProfile = { phone?: string | null; photo?: string | null };

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
  cleaner_id?: string | null;
  cleaner_profile?: CleanerProfile | null;
  request_approved?: boolean;
  report_email?: string | null;
  cleaner_link_issued?: boolean;
  cleaner_link_active?: boolean;
  cleaner_link_expires?: string | null;
  cleaner_link_opened_at?: string | null;
  cleaner_link_reusable?: boolean;
  issue_open: boolean;
  issue_ever: boolean;
  report_bounced: boolean;
  payment_failed?: boolean;
  visit_confirmed?: boolean;
  confirmation_email?: string | null;
  paid_at: string | null;
  is_test: boolean;
  checklist: { rooms?: { name: string; items: { label: string; done: boolean }[]; skip_reason?: string }[]; problem_note?: string; submitted_at?: string };
  photo_count?: number;
};

type RosterCleaner = { id: string; name: string; phone: string | null; photo_url: string | null; active: boolean };

type Photo = { id: string; room: string; kind: string; note: string | null; url: string | null };
type GhEvent = { id: number; actor: string; event: string; detail: Record<string, unknown> | null; created_at: string };

const money = (cents: number | null): string =>
  cents ? `$${(cents / 100).toFixed(2).replace(/\.00$/, "")}` : "—";

// Date-only strings (YYYY-MM-DD) formatted without a timezone shift.
const fmtVisitDate = (d: string | null | undefined): string => {
  if (!d) return "no date";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) return d;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
};

const fmtDateET = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" }).format(d);
};

const fmtDateTimeET = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(d)} ET`;
};

const initials = (name: string): string => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
};

const digitsOnly = (phone: string): string => phone.replace(/\D/g, "");

const reportLabel = (s: string): string => {
  switch (s) {
    case "none": return "Waiting for cleaner’s report";
    case "draft": return "Cleaner is working on the report";
    case "returned": return "Report returned to cleaner";
    case "submitted": return "Report ready for review";
    case "sent": return "Report sent to the client";
    default: return s || "—";
  }
};

const EVENT_LABELS: Record<string, string> = {
  request_approved: "Request approved",
  cleaner_assigned: "Cleaner assigned",
  cleaner_link_opened: "Cleaner opened the job link",
  cleaner_link_issued: "Cleaner link issued",
  cleaner_link_rotated: "Cleaner link replaced",
  cleaner_changed: "Cleaner changed",
  report_submitted: "Cleaner submitted the report",
  report_sent: "Report sent to the client",
  report_returned: "Report returned to cleaner",
  issue_opened: "Customer issue opened",
  issue_resolved: "Issue resolved",
  payment_failed: "Payment failed",
  payment_succeeded: "Payment succeeded",
  client_link_issued: "Client link created",
  date_proposed: "Another date proposed",
  client_note: "Customer note",
  scope_review: "Scope review",
};

// Detail keys that must never render in Activity (defense in depth —
// events should not carry them, but the panel never displays them).
const HIDDEN_DETAIL_KEYS = /token|hash|secret|password|api[_-]?key/i;

type FocusBlock = "summary" | "cleaner" | "schedule" | "report" | "payment";

const Owner = () => {
  const [token, setToken] = useState(() => sessionStorage.getItem("gh_owner_session") ?? sessionStorage.getItem("gh_admin_token") ?? "");
  const [tokenInput, setTokenInput] = useState("");
  const [linkMsg, setLinkMsg] = useState("");
  const [visits, setVisits] = useState<Visit[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Visit | null>(null);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [events, setEvents] = useState<GhEvent[]>([]);
  const [stripeState, setStripeState] = useState("");
  const [actionMsg, setActionMsg] = useState("");
  const [returnNote, setReturnNote] = useState("");
  const [confirmDate, setConfirmDate] = useState("");
  const [confirmWindow, setConfirmWindow] = useState("");
  const [acting, setActing] = useState("");
  const [publishMsg, setPublishMsg] = useState("");
  const [ownerRoom, setOwnerRoom] = useState("Kitchen");
  const [ownerKind, setOwnerKind] = useState<"before" | "after">("after");

  // Cleaner block state.
  const [cleanerEditing, setCleanerEditing] = useState(false);
  const [formName, setFormName] = useState("");
  const [formPhone, setFormPhone] = useState("");
  const [formPhoto, setFormPhoto] = useState("");
  const [formError, setFormError] = useState("");
  const [viewLinkOpen, setViewLinkOpen] = useState(false);
  const [viewLinkUrl, setViewLinkUrl] = useState("");
  const [viewLinkError, setViewLinkError] = useState("");
  const [cleanerCopyStatus, setCleanerCopyStatus] = useState("");
  const [clientCopyStatus, setClientCopyStatus] = useState("");
  const [manualCopy, setManualCopy] = useState<{ text: string; label: string; owner: "cleaner" | "client" } | null>(null);

  // Schedule block state.
  const [scheduleEditing, setScheduleEditing] = useState(false);
  const [altDate, setAltDate] = useState("");
  const [assignCleanerId, setAssignCleanerId] = useState("");
  const [cleanerChanging, setCleanerChanging] = useState(false);
  const [changeCleanerId, setChangeCleanerId] = useState("");

  // Cleaner directory (roster) state.
  const [roster, setRoster] = useState<RosterCleaner[]>([]);
  const [rosterLoaded, setRosterLoaded] = useState(false);
  const [rosterMsg, setRosterMsg] = useState("");
  const [rosterName, setRosterName] = useState("");
  const [rosterPhone, setRosterPhone] = useState("");
  const [rosterPhoto, setRosterPhoto] = useState("");
  const [rosterCsv, setRosterCsv] = useState("");
  const [rosterCsvMsg, setRosterCsvMsg] = useState("");
  const [editRosterId, setEditRosterId] = useState<string | null>(null);
  const [editRosterName, setEditRosterName] = useState("");
  const [editRosterPhone, setEditRosterPhone] = useState("");
  const [editRosterPhoto, setEditRosterPhoto] = useState("");
  const [editRosterActive, setEditRosterActive] = useState(true);

  // Concurrency guard: mutation responses carry a sequence number, and
  // only the newest one may set the link shown for a visit — a late
  // answer must never display the previous assignment's link. The ref
  // is keyed by visit id, so switching visits can never leak a link.
  const linkSeqRef = useRef(0);
  const linkSessionRef = useRef<{ visitId: string; url: string; seq: number } | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const pendingFocusRef = useRef<FocusBlock | null>(null);

  const headers = useCallback(
    () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" }),
    [token],
  );

  // Email-link login: /owner?ol=<token> exchanges the link for a 24h
  // session, stored like the hand-typed key. The token is stripped from
  // the URL right away so it does not linger in the address bar.
  useEffect(() => {
    const ol = new URLSearchParams(window.location.search).get("ol");
    if (!ol) return;
    window.history.replaceState(null, "", window.location.pathname);
    fetch("/api/owner-auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "verify", ol }),
    })
      .then((r) => r.json())
      .then((j) => {
        if (j?.ok && typeof j.session === "string") {
          sessionStorage.setItem("gh_owner_session", j.session);
          setToken(j.session);
        } else {
          setError("This login link is invalid or expired — request a new one below.");
        }
      })
      .catch(() => setError("Couldn't verify this login link — request a new one below."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadList = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError("");
    try {
      const r = await fetch("/api/owner?view=list", { headers: headers() });
      const j = (await r.json()) as { ok: boolean; visits?: Visit[]; error?: string };
      if (!j.ok) {
        setError(j.error === "unauthorized" ? "Login expired or rejected — request a new login link or re-enter the admin token." : j.error === "db_not_configured" ? "Database isn't connected yet (SUPABASE env vars missing)." : "Couldn't load visits.");
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

  const loadRoster = useCallback(async () => {
    if (!token) return;
    try {
      const r = await fetch("/api/owner?view=roster", { headers: headers() });
      const j = (await r.json()) as { ok: boolean; cleaners?: RosterCleaner[] };
      if (j.ok) {
        setRoster(j.cleaners ?? []);
        setRosterLoaded(true);
      }
    } catch {
      /* the directory section reports the failure on use */
    }
  }, [token, headers]);

  // Needs-attention deep links: after the detail loads, scroll to the
  // block that needs the action.
  useEffect(() => {
    const focus = pendingFocusRef.current;
    if (!focus || !selected) return;
    pendingFocusRef.current = null;
    const t = window.setTimeout(() => {
      document.getElementById(`block-${focus}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 100);
    return () => window.clearTimeout(t);
  }, [selected]);

  const openVisit = async (v: Visit, focus?: FocusBlock) => {
    const sameVisit = selectedIdRef.current === v.id;
    selectedIdRef.current = v.id;
    if (focus) pendingFocusRef.current = focus;
    setSelected(v);
    if (!sameVisit) {
      setPhotos([]);
      setEvents([]);
      setStripeState("");
      setActionMsg("");
      setViewLinkOpen(false);
      setViewLinkUrl("");
      setViewLinkError("");
      setCleanerCopyStatus("");
      setClientCopyStatus("");
      setManualCopy(null);
      setPublishMsg("");
      setReturnNote("");
      setScheduleEditing(false);
      setAltDate("");
      setAssignCleanerId("");
      setCleanerChanging(false);
      setChangeCleanerId("");
      setCleanerEditing(!v.cleaner_name);
      setFormName(v.cleaner_name ?? "");
      setFormPhone(v.cleaner_profile?.phone ?? "");
      setFormPhoto(v.cleaner_profile?.photo ?? "");
      setFormError("");
    }
    setConfirmDate(v.visit_date ?? "");
    setConfirmWindow(v.window ?? "");
    if (!rosterLoaded) void loadRoster();
    try {
      const r = await fetch(`/api/owner?view=detail&visit_id=${v.id}`, { headers: headers() });
      const j = (await r.json()) as { ok: boolean; visit?: Visit; photos?: Photo[]; events?: GhEvent[] };
      if (j.ok && j.visit) {
        setSelected(j.visit);
        setPhotos(j.photos ?? []);
        setEvents(j.events ?? []);
        if (!sameVisit) {
          setCleanerEditing(!j.visit.cleaner_name);
          setFormName(j.visit.cleaner_name ?? "");
          setFormPhone(j.visit.cleaner_profile?.phone ?? "");
          setFormPhoto(j.visit.cleaner_profile?.photo ?? "");
        }
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

  // Record a freshly issued link, guarded by sequence: the sequence is
  // captured when the mutation STARTS, so a late answer (started
  // earlier, arrived later) can never overwrite a newer link.
  const noteLinkResult = (visitId: string, url: string, seq: number) => {
    const prev = linkSessionRef.current;
    if (!prev || prev.visitId !== visitId || seq > prev.seq) {
      linkSessionRef.current = { visitId, url, seq };
    }
  };

  const copyText = async (text: string): Promise<boolean> => {
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      /* manual fallback below */
    }
    return false;
  };

  const cleanerMessage = (url: string): string => {
    if (!selected) return url;
    const when = `${fmtVisitDate(selected.visit_date)}${selected.window ? `, ${selected.window}` : ""}`;
    const where = selected.address ? ` at ${selected.address}` : "";
    return `Hi! Here is your Gatehouse job link for ${when}${where}:\n${url}\n\nOpen it on your phone — no app needed. For each room: take a “before” photo before you start and an “after” photo when you finish, check off the list, then submit the report. If a room can't be photographed, write the reason in the room's field. Thank you!`;
  };

  const openShare = (kind: "wa" | "sms", text: string, phone: string | null) => {
    const digits = phone ? digitsOnly(phone) : "";
    if (kind === "wa") {
      window.open(digits ? `https://wa.me/${digits}?text=${encodeURIComponent(text)}` : `https://wa.me/?text=${encodeURIComponent(text)}`, "_blank");
    } else {
      window.open(digits ? `sms:${digits}?body=${encodeURIComponent(text)}` : `sms:?body=${encodeURIComponent(text)}`, "_blank");
    }
  };

  // Fetch the current reusable link (fresh from the server). Falls back
  // to the link issued in this panel session when the stored link is a
  // legacy one that cannot be re-fetched.
  const loadCleanerLink = async (): Promise<{ url: string } | { error: string }> => {
    if (!selected) return { error: "no_visit" };
    const j = await act({ action: "get_cleaner_link", booking_id: selected.booking_id });
    if (j.ok && typeof j["url"] === "string") return { url: j["url"] as string };
    const session = linkSessionRef.current;
    if (session && session.visitId === selected.id) return { url: session.url };
    return { error: typeof j.error === "string" ? j.error : "failed" };
  };

  const copyCleanerLink = async () => {
    setCleanerCopyStatus("");
    setManualCopy(null);
    const res = await loadCleanerLink();
    if ("url" in res) {
      if (await copyText(res.url)) {
        setCleanerCopyStatus("Cleaner link copied.");
      } else {
        setManualCopy({ text: res.url, label: "Cleaner link — copy it manually:", owner: "cleaner" });
        setCleanerCopyStatus("Copy failed — copy the link manually below.");
      }
      return;
    }
    if (res.error === "link_not_reusable") {
      setCleanerCopyStatus("This link can’t be re-fetched. Create a reusable access link below.");
    } else if (res.error === "link_expired") {
      setCleanerCopyStatus("This link has expired. Replace it below.");
    } else if (res.error === "reusable_unavailable") {
      setCleanerCopyStatus("Reusable links aren’t set up on the server yet. Create a new link below.");
    } else {
      setCleanerCopyStatus("Couldn’t load the link — try again.");
    }
  };

  const toggleViewLink = async () => {
    if (viewLinkOpen) {
      setViewLinkOpen(false);
      return;
    }
    setViewLinkError("");
    const res = await loadCleanerLink();
    if ("url" in res) {
      setViewLinkUrl(res.url);
      setViewLinkOpen(true);
    } else if (res.error === "link_not_reusable") {
      setViewLinkError("This link can’t be re-fetched. Create a reusable access link below.");
    } else if (res.error === "link_expired") {
      setViewLinkError("This link has expired. Replace it below.");
    } else {
      setViewLinkError("Couldn’t load the link — try again.");
    }
  };

  const copyClientLink = async () => {
    if (!selected) return;
    setClientCopyStatus("");
    setManualCopy(null);
    const j = await act({ action: "client_link", booking_id: selected.booking_id });
    if (j.ok && typeof j["url"] === "string") {
      const url = j["url"] as string;
      if (await copyText(url)) {
        setClientCopyStatus("Client link copied.");
      } else {
        setManualCopy({ text: url, label: "Client link — copy it manually:", owner: "client" });
        setClientCopyStatus("Copy failed — copy the link manually below.");
      }
    } else {
      setClientCopyStatus("Couldn’t load the client link — try again.");
    }
  };

  const previewClientView = async () => {
    // Opens the live client page for viewing only: no client action is
    // taken from a preview (no approve, issue, cancel, or reschedule).
    if (!selected) return;
    const j = await act({ action: "preview_link", booking_id: selected.booking_id });
    if (j.ok && typeof j["visit_url"] === "string") {
      window.open(j["visit_url"] as string, "_blank");
    } else {
      setActionMsg("Couldn't load the client preview — try again.");
    }
  };

  const replaceCleanerLink = () => {
    if (!selected) return;
    if (selected.cleaner_link_issued && !window.confirm("This will disable the previous link. Send the new link to your cleaner.")) return;
    const visitId = selected.id;
    const seq = linkSeqRef.current + 1;
    linkSeqRef.current = seq;
    void runAction("Replace access link", { action: "cleaner_link", booking_id: selected.booking_id }, (j) => {
      if (typeof j["url"] === "string") {
        noteLinkResult(visitId, j["url"] as string, seq);
        // Show the result at once, keyed by visit id, not by panel state.
        setViewLinkUrl(j["url"] as string);
        setViewLinkOpen(true);
      }
    });
  };

  const assignCleaner = () => {
    if (!selected) return;
    if (!formName.trim()) {
      setFormError("Enter the cleaner’s name.");
      return;
    }
    if (formPhoto.trim() && !formPhoto.trim().startsWith("https://")) {
      setFormError("Photo URL must start with https://.");
      return;
    }
    setFormError("");
    const visitId = selected.id;
    const seq = linkSeqRef.current + 1;
    linkSeqRef.current = seq;
    void runAction("Assign cleaner", {
      action: "set_cleaner",
      booking_id: selected.booking_id,
      cleaner_name: formName.trim(),
      cleaner_phone: formPhone.trim(),
      cleaner_photo: formPhoto.trim(),
    }, (j) => {
      if (typeof j["url"] === "string") {
        noteLinkResult(visitId, j["url"] as string, seq);
        setViewLinkUrl(j["url"] as string);
        setViewLinkOpen(true);
      }
      if (j["cleaner_profile_saved"] === false) {
        setActionMsg("Assign cleaner: done, but the phone/photo were NOT saved (the profile fields aren’t in the database yet).");
      }
      setCleanerEditing(false);
    });
  };

  const addRosterCleaner = async () => {
    if (!rosterName.trim()) {
      setRosterMsg("Enter the cleaner’s name.");
      return;
    }
    if (rosterPhoto.trim() && !rosterPhoto.trim().startsWith("https://")) {
      setRosterMsg("Photo URL must start with https://.");
      return;
    }
    const j = await act({
      action: "roster_add",
      cleaner_name: rosterName.trim(),
      cleaner_phone: rosterPhone.trim(),
      cleaner_photo: rosterPhoto.trim(),
    });
    if (j.ok) {
      setRosterMsg("Cleaner added to the directory.");
      setRosterName("");
      setRosterPhone("");
      setRosterPhoto("");
      void loadRoster();
    } else {
      setRosterMsg(`Couldn’t add the cleaner: ${j.error ?? "failed"}`);
    }
  };

  const saveRosterEdit = async () => {
    if (!editRosterId) return;
    if (!editRosterName.trim()) {
      setRosterMsg("Enter the cleaner’s name.");
      return;
    }
    if (editRosterPhoto.trim() && !editRosterPhoto.trim().startsWith("https://")) {
      setRosterMsg("Photo URL must start with https://.");
      return;
    }
    const j = await act({
      action: "roster_update",
      cleaner_id: editRosterId,
      cleaner_name: editRosterName.trim(),
      cleaner_phone: editRosterPhone.trim(),
      cleaner_photo: editRosterPhoto.trim(),
      active: editRosterActive,
    });
    if (j.ok) {
      setRosterMsg("Cleaner updated.");
      setEditRosterId(null);
      void loadRoster();
    } else {
      setRosterMsg(`Couldn’t update the cleaner: ${j.error ?? "failed"}`);
    }
  };

  const toggleRosterActive = async (c: RosterCleaner) => {
    const j = await act({ action: "roster_update", cleaner_id: c.id, active: !c.active });
    if (j.ok) {
      setRosterMsg(c.active ? `${c.name} deactivated — no longer assignable.` : `${c.name} activated.`);
      void loadRoster();
    } else {
      setRosterMsg(`Couldn’t change the cleaner: ${j.error ?? "failed"}`);
    }
  };

  const importRosterCsv = async () => {
    if (!rosterCsv.trim()) {
      setRosterCsvMsg("Paste the list first (name, phone, photo URL, active).");
      return;
    }
    const j = await act({ action: "roster_import", csv: rosterCsv });
    if (j.ok) {
      const errs = Array.isArray(j["errors"]) ? (j["errors"] as { line: number; error: string }[]) : [];
      setRosterCsvMsg(
        `Imported ${String(j["imported"] ?? 0)} cleaner(s).` +
        (errs.length > 0 ? ` Skipped ${errs.length} line(s): ${errs.map((e) => `line ${e.line || "?"} (${e.error})`).join(", ")}.` : ""),
      );
      setRosterCsv("");
      void loadRoster();
    } else {
      setRosterCsvMsg(`Import failed: ${j.error ?? "failed"}`);
    }
  };

  if (!token) {
    return (
      <div className="min-h-screen bg-background px-4 py-16">
        <Helmet><meta name="robots" content="noindex,nofollow" /></Helmet>
        <div className="max-w-sm mx-auto text-center">
          <h1 className="font-heading text-3xl font-bold mb-4">Owner view</h1>
          <p className="text-sm text-muted-foreground mb-4">Enter the admin token, or get a login link by email.</p>
          {error && <p className="text-sm text-destructive mb-3" role="alert">{error}</p>}
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
          <Button
            variant="outline"
            className="w-full mt-3"
            onClick={async () => {
              setLinkMsg("");
              try {
                const r = await fetch("/api/owner-auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "send" }) });
                const j = await r.json();
                setLinkMsg(j?.ok ? "Login link sent — check nikolajmihasenok@gmail.com (valid 30 minutes)." : "Couldn't send the link — try again in a minute.");
              } catch {
                setLinkMsg("Couldn't send the link — try again in a minute.");
              }
            }}
          >
            Send login link to my email
          </Button>
          {linkMsg && <p className="text-sm mt-3">{linkMsg}</p>}
        </div>
      </div>
    );
  }

  // Needs attention: one action per item, each opening the visit at the
  // block that needs it. (Issue/bounce flags stay as badges on the row.)
  const attentionItems = (v: Visit): { label: string; focus: FocusBlock }[] => {
    const items: { label: string; focus: FocusBlock }[] = [];
    // A submitted (or sent) report without a confirmation event is an
    // inconsistent record: work happened without an agreed visit. It
    // needs an explicit review-and-repair confirmation, not a routine
    // date confirmation.
    const needsReview = !v.visit_confirmed && (v.report_status === "submitted" || v.report_status === "sent");
    if (v.status === "requested" && !v.request_approved) items.push({ label: "Approve request", focus: "summary" });
    if (!v.cleaner_name) items.push({ label: "Assign a cleaner", focus: "schedule" });
    else if (needsReview) items.push({ label: "Needs review", focus: "schedule" });
    else if (v.status !== "confirmed" && v.status !== "paid" && v.status !== "cancelled") items.push({ label: "Confirm the date", focus: "schedule" });
    if (v.report_status === "submitted") items.push({ label: "Review the report", focus: "report" });
    if (v.payment_failed) items.push({ label: "Payment failed", focus: "payment" });
    return items;
  };

  // Next action for a list row (same order as the detail's Next line,
  // from the row alone — no event/stripe detail on the list).
  // Confirmation proof is the visit_confirmed event, not the row status:
  // after a report is published the row moves to report_sent, and deriving
  // "Confirm the date" from the status would contradict the client page.
  const rowNextAction = (v: Visit): string => {
    if (v.status === "cancelled" || v.status === "paid") return "No action needed";
    if (!v.visit_confirmed) {
      if (v.status === "requested" && !v.request_approved) return "Approve request";
      if (!v.cleaner_name) return "Assign a cleaner";
      return "Confirm the date";
    }
    if (v.report_status === "submitted") return "Review the report";
    if (v.payment_failed) return "Retry the payment";
    if (v.issue_open) return "Resolve the customer issue";
    if (v.report_status === "sent") return "Waiting for the customer’s review";
    if (v.report_status === "none" || v.report_status === "draft" || v.report_status === "returned") return "Waiting for the cleaner’s report";
    return "No action needed";
  };

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
          <details
            className="mb-5 rounded-xl border border-border bg-card p-4"
            onToggle={(e) => { if ((e.target as HTMLDetailsElement).open && !rosterLoaded) void loadRoster(); }}
          >
            <summary className="font-semibold cursor-pointer">Cleaners — directory</summary>
            <p className="text-sm text-muted-foreground mt-2">
              Only people you add here can be assigned to visits. Candidates from Indeed are added by hand
              or by pasting their exported list below — there is no automatic sync.
            </p>
            {roster.length === 0 ? (
              <p className="text-sm text-muted-foreground mt-2">No cleaners in the directory yet.</p>
            ) : (
              <ul className="space-y-2 mt-3">
                {roster.map((c) => (
                  <li key={c.id} className="rounded-lg border border-border p-3">
                    {editRosterId === c.id ? (
                      <div className="space-y-2">
                        <input type="text" className="w-full border border-border rounded-lg px-3 py-2 bg-background text-sm" value={editRosterName} onChange={(e) => setEditRosterName(e.target.value)} placeholder="Name" />
                        <input type="text" className="w-full border border-border rounded-lg px-3 py-2 bg-background text-sm" value={editRosterPhone} onChange={(e) => setEditRosterPhone(e.target.value)} placeholder="Phone — optional" />
                        <input type="text" className="w-full border border-border rounded-lg px-3 py-2 bg-background text-sm" value={editRosterPhoto} onChange={(e) => setEditRosterPhoto(e.target.value)} placeholder="Photo URL — optional (https://)" />
                        <label className="flex items-center gap-2 text-sm">
                          <input type="checkbox" checked={editRosterActive} onChange={(e) => setEditRosterActive(e.target.checked)} /> Active (assignable)
                        </label>
                        <div className="flex flex-wrap gap-2">
                          <Button variant="hero" size="sm" onClick={() => void saveRosterEdit()}>Save</Button>
                          <Button variant="outline" size="sm" onClick={() => setEditRosterId(null)}>Cancel</Button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold">{c.name}</span>
                        {c.phone && <span className="text-sm">{c.phone}</span>}
                        <span className={`text-[11px] px-2 py-0.5 rounded ${c.active ? "bg-green-100 text-green-900" : "bg-muted text-muted-foreground"}`}>{c.active ? "Active" : "Inactive"}</span>
                        <span className="ml-auto flex gap-2">
                          <Button variant="outline" size="sm" onClick={() => { setEditRosterId(c.id); setEditRosterName(c.name); setEditRosterPhone(c.phone ?? ""); setEditRosterPhoto(c.photo_url ?? ""); setEditRosterActive(c.active); }}>Edit</Button>
                          <Button variant="outline" size="sm" onClick={() => void toggleRosterActive(c)}>{c.active ? "Deactivate" : "Activate"}</Button>
                        </span>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <div className="space-y-2 mt-4">
              <p className="text-sm font-medium">Add a cleaner</p>
              <input type="text" className="w-full border border-border rounded-lg px-3 py-2 bg-background text-sm" placeholder="Name" value={rosterName} onChange={(e) => setRosterName(e.target.value)} />
              <input type="text" className="w-full border border-border rounded-lg px-3 py-2 bg-background text-sm" placeholder="Phone — optional" value={rosterPhone} onChange={(e) => setRosterPhone(e.target.value)} />
              <input type="text" className="w-full border border-border rounded-lg px-3 py-2 bg-background text-sm" placeholder="Photo URL — optional (https://)" value={rosterPhoto} onChange={(e) => setRosterPhoto(e.target.value)} />
              <Button variant="hero" size="sm" onClick={() => void addRosterCleaner()}>Add cleaner</Button>
            </div>
            <div className="space-y-2 mt-4">
              <p className="text-sm font-medium">Import a list (Indeed export or spreadsheet)</p>
              <p className="text-xs text-muted-foreground">One cleaner per line: name, phone, photo URL, active. A header row starting with “name” is skipped.</p>
              <textarea rows={4} className="w-full border border-border rounded-lg px-3 py-2 bg-background text-sm" placeholder={"Chenika Williams, 7705550100, https://…, yes\nTaylor Allen, 7705550101, , yes"} value={rosterCsv} onChange={(e) => setRosterCsv(e.target.value)} />
              <Button variant="outline" size="sm" onClick={() => void importRosterCsv()}>Import list</Button>
              {rosterCsvMsg && <p className="text-sm" role="status">{rosterCsvMsg}</p>}
            </div>
            {rosterMsg && <p className="text-sm mt-3" role="status">{rosterMsg}</p>}
          </details>
        )}

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
                      onClick={() => void openVisit(v, "report")}
                    >
                      <span className="font-semibold">{v.client_name ?? "—"}</span>{" "}
                      <span className="text-sm text-muted-foreground">
                        {fmtVisitDate(v.visit_date)} · {v.photo_count ?? 0} photos
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
          const withAttention = visits
            .map((v) => ({ v, items: attentionItems(v) }))
            .filter((x) => x.items.length > 0);
          return withAttention.length > 0 ? (
            <div className="mb-6">
              <h2 className="font-heading text-lg font-bold mb-2">Needs attention</h2>
              <div className="space-y-2">
                {withAttention.map(({ v, items }) => (
                  <div key={v.id} className="rounded-xl border border-amber-500/60 bg-amber-50 p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">{v.client_name ?? "—"}</span>
                      <span className="text-sm text-muted-foreground">{fmtVisitDate(v.visit_date)} · {money(v.amount_cents)}</span>
                    </div>
                    <div className="flex flex-wrap gap-2 mt-2">
                      {items.map((it) => (
                        <Button key={it.label} variant="outline" size="sm" onClick={() => void openVisit(v, it.focus)}>
                          {it.label}
                        </Button>
                      ))}
                    </div>
                  </div>
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
                  <span className="text-sm text-muted-foreground">{fmtVisitDate(v.visit_date)} {v.window ?? ""}</span>
                  <span className="text-sm">{money(v.amount_cents)}</span>
                </div>
                {v.address && <div className="text-sm text-muted-foreground mt-1">{v.address}</div>}
                <div className="text-sm font-medium mt-1">Next: {rowNextAction(v)}</div>
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
                  {v.payment_failed && <span className="bg-red-100 text-red-900 px-2 py-0.5 rounded">payment failed</span>}
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

        {selected && (() => {
          if (!selected) return null;
          const v = selected;
          const paymentFailed = Boolean(v.payment_failed) || events.some((e) => e.event === "payment_failed") || stripeState === "payment_failed";
          const nextAction = v.status === "cancelled" || v.status === "paid"
            ? "No action needed"
            : !v.visit_confirmed
              ? v.status === "requested" && !v.request_approved
                ? "Approve request"
                : !v.cleaner_name
                  ? "Assign a cleaner"
                  : "Confirm the date"
              : v.report_status === "submitted"
                ? "Review the report"
                : paymentFailed
                  ? "Retry the payment"
                  : v.issue_open
                    ? "Resolve the customer issue"
                    : v.report_status === "sent"
                      ? "Waiting for the customer’s review"
                      : v.report_status === "none" || v.report_status === "draft" || v.report_status === "returned"
                        ? "Waiting for the cleaner’s report"
                        : "No action needed";
          const assigned = Boolean(v.cleaner_name);
          const phone = v.cleaner_profile?.phone ?? null;
          const photo = v.cleaner_profile?.photo ?? null;
          const linkIssued = Boolean(v.cleaner_link_issued);
          const linkActive = Boolean(v.cleaner_link_active);
          const linkReusable = Boolean(v.cleaner_link_reusable);
          const rooms = v.checklist?.rooms ?? [];

          // Load the current link, then run fn with it; failures surface
          // in the cleaner status line (never a false "Copied").
          const withLink = async (fn: (url: string) => void) => {
            const res = await loadCleanerLink();
            if ("url" in res) fn(res.url);
            else if (res.error === "link_not_reusable") setCleanerCopyStatus("This link can’t be re-fetched. Create a reusable access link below.");
            else if (res.error === "link_expired") setCleanerCopyStatus("This link has expired. Replace it below.");
            else setCleanerCopyStatus("Couldn’t load the link — try again.");
          };

          const openEditDetails = () => {
            setFormName(v.cleaner_name ?? "");
            setFormPhone(phone ?? "");
            setFormPhoto(photo ?? "");
            setFormError("");
            setCleanerEditing(true);
          };

          return (
            <div>
              <button type="button" className="text-sm underline text-muted-foreground mb-3" onClick={() => setSelected(null)}>
                ← All visits
              </button>

              {/* A. Summary */}
              <section id="block-summary" className="rounded-xl border border-border bg-card p-4 mb-4 scroll-mt-28">
                <h2 className="font-heading text-2xl font-bold">{v.client_name ?? "—"}</h2>
                <p className="text-sm text-muted-foreground">
                  {v.service ?? ""} · {fmtVisitDate(v.visit_date)} {v.window ?? ""} · {money(v.amount_cents)}
                </p>
                <p className="text-sm">{v.address ?? ""}</p>
                {v.access_notes && <p className="text-sm">Access: {v.access_notes}</p>}
                <p className="text-sm">
                  Visit: <strong>{v.status}</strong> · Report: <strong>{reportLabel(v.report_status)}</strong>
                  {stripeState && <> · Stripe: <strong>{stripeState}</strong></>}
                  {v.issue_open && <> · <span className="text-destructive font-semibold">Issue open</span></>}
                </p>
                <p className="text-sm font-medium mt-1">Next: {nextAction}</p>
                <div className="flex flex-wrap items-center gap-2 mt-2">
                  <span className="text-sm text-muted-foreground">{v.client_email ?? ""}</span>
                  <Button variant="outline" size="sm" onClick={() => void copyClientLink()}>
                    Copy client link
                  </Button>
                </div>
                {clientCopyStatus && <p className="text-sm mt-1" role="status">{clientCopyStatus}</p>}
                {manualCopy?.owner === "client" && (
                  <div className="mt-1">
                    <p className="text-xs text-muted-foreground">{manualCopy.label}</p>
                    <input readOnly className="w-full text-xs bg-muted rounded p-2 mt-1" value={manualCopy.text} onFocus={(e) => e.target.select()} aria-label="Client link (select and copy if the button does not work)" />
                  </div>
                )}
                {v.status === "requested" && !v.request_approved && (
                  <div className="mt-3">
                    <Button variant="hero" disabled={acting !== ""} onClick={() => void runAction("Approve request", { action: "approve_request", booking_id: v.booking_id })}>
                      Approve request
                    </Button>
                    <p className="text-xs text-muted-foreground mt-1">Approving takes the request into your pipeline. It does not assign a cleaner or confirm the date — those come next.</p>
                  </div>
                )}
                {v.request_approved && v.status === "requested" && (
                  <p className="text-sm text-muted-foreground mt-2">Request approved — the date is not confirmed yet. Assign a cleaner and confirm the visit below.</p>
                )}
              </section>

              {/* B. Cleaner — assignment and link in one block */}
              <section id="block-cleaner" className="rounded-xl border border-border bg-card p-4 mb-4 scroll-mt-28">
                <h3 className="font-semibold mb-3">Cleaner</h3>
                {(!assigned || cleanerEditing || cleanerChanging) ? (
                  cleanerChanging ? (
                    <div className="space-y-2">
                      <select className="w-full border border-border rounded-lg px-3 py-2 bg-background text-sm" value={changeCleanerId} onChange={(e) => setChangeCleanerId(e.target.value)}>
                        <option value="">Choose a cleaner…</option>
                        {roster.filter((r) => r.active).map((r) => (
                          <option key={r.id} value={r.id}>{r.name}{r.phone ? ` · ${r.phone}` : ""}</option>
                        ))}
                      </select>
                      {formError && <p className="text-sm text-destructive" role="alert">{formError}</p>}
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="hero"
                          disabled={acting !== "" || !changeCleanerId}
                          onClick={() => void runAction("Change cleaner", { action: "set_cleaner", booking_id: v.booking_id, cleaner_id: changeCleanerId }, (j) => {
                            if (typeof j["url"] === "string") {
                              const seq = linkSeqRef.current + 1;
                              linkSeqRef.current = seq;
                              noteLinkResult(v.id, j["url"] as string, seq);
                              setViewLinkUrl(j["url"] as string);
                              setViewLinkOpen(true);
                            }
                            setCleanerChanging(false);
                          })}
                        >
                          Change cleaner
                        </Button>
                        <Button variant="outline" onClick={() => { setCleanerChanging(false); setFormError(""); }}>
                          Cancel
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground">Changing the cleaner replaces the access link — the old link stops working. The client is emailed about the change.</p>
                    </div>
                  ) : !assigned ? (
                    <div className="space-y-2">
                      <p className="text-sm text-muted-foreground">No cleaner assigned yet. Choose one in the Schedule block below, then Assign &amp; confirm the visit.</p>
                      <Button variant="outline" onClick={() => document.getElementById("block-schedule")?.scrollIntoView({ behavior: "smooth", block: "start" })}>
                        Go to Schedule
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <input type="text" className="w-full border border-border rounded-lg px-3 py-2 bg-background text-sm" placeholder="Cleaner name" value={formName} onChange={(e) => setFormName(e.target.value)} />
                      <input type="text" className="w-full border border-border rounded-lg px-3 py-2 bg-background text-sm" placeholder="Phone — optional" value={formPhone} onChange={(e) => setFormPhone(e.target.value)} />
                      <input type="text" className="w-full border border-border rounded-lg px-3 py-2 bg-background text-sm" placeholder="Photo URL — optional (https://)" value={formPhoto} onChange={(e) => setFormPhoto(e.target.value)} />
                      {formError && <p className="text-sm text-destructive" role="alert">{formError}</p>}
                      <div className="flex flex-wrap gap-2">
                        <Button variant="hero" onClick={assignCleaner}>
                          Save details
                        </Button>
                        <Button variant="outline" onClick={() => { setCleanerEditing(false); setFormError(""); }}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )
                ) : (
                  <div>
                    <div className="flex items-start gap-3 mb-2">
                      <div className="relative w-12 h-12 shrink-0">
                        <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center font-semibold">
                          {initials(v.cleaner_name ?? "")}
                        </div>
                        {photo && (
                          <img src={photo} alt="" className="absolute inset-0 w-12 h-12 rounded-full object-cover" onError={(e) => { e.currentTarget.style.display = "none"; }} />
                        )}
                      </div>
                      <div className="min-w-0">
                        <p className="font-semibold">{v.cleaner_name}</p>
                        {phone && <p className="text-sm"><a className="underline" href={`tel:${digitsOnly(phone)}`}>{phone}</a></p>}
                      </div>
                      <Button variant="outline" size="sm" className="ml-auto shrink-0" onClick={() => { setChangeCleanerId(v.cleaner_id ?? roster.find((r) => r.name === v.cleaner_name)?.id ?? ""); setFormError(""); setCleanerChanging(true); }}>
                        Change
                      </Button>
                    </div>

                    {!linkIssued ? (
                      <div>
                        <p className="text-sm text-muted-foreground mb-2">No access link yet.</p>
                        <Button variant="outline" onClick={replaceCleanerLink}>Create access link</Button>
                      </div>
                    ) : !linkActive ? (
                      <div>
                        <p className="text-sm mb-2">Access expired.</p>
                        <Button variant="outline" onClick={replaceCleanerLink}>
                          {linkReusable ? "Replace access link" : "Create a reusable access link"}
                        </Button>
                      </div>
                    ) : linkReusable ? (
                      <div>
                        <div className="flex flex-wrap gap-2 mb-2">
                          <Button variant="hero" onClick={() => void copyCleanerLink()}>
                            Copy cleaner link
                          </Button>
                          <Button variant="outline" onClick={() => void withLink((url) => openShare("wa", cleanerMessage(url), phone))}>
                            WhatsApp
                          </Button>
                          <Button variant="outline" onClick={() => void withLink((url) => openShare("sms", cleanerMessage(url), phone))}>
                            SMS
                          </Button>
                        </div>
                        <p className="text-sm">
                          {v.cleaner_link_opened_at ? <>Opened {fmtDateTimeET(v.cleaner_link_opened_at)}</> : "Not opened yet"}
                          {" · "}Access expires {fmtDateET(v.cleaner_link_expires)}
                        </p>
                        <p className="text-xs text-muted-foreground mt-1">
                          Opens WhatsApp or SMS with a ready message — you send it. Opening the link doesn’t mean the cleaner accepted the job.
                        </p>
                        <button type="button" className="text-sm underline text-muted-foreground mt-2" onClick={() => void toggleViewLink()}>
                          {viewLinkOpen ? "Hide link & message" : "View link & message"}
                        </button>
                        {viewLinkOpen && viewLinkUrl && (
                          <div className="mt-2">
                            <input readOnly className="w-full text-xs bg-muted rounded p-2 mb-2" value={viewLinkUrl} onFocus={(e) => e.target.select()} aria-label="Cleaner link (select and copy if the button does not work)" />
                            <textarea readOnly rows={7} className="w-full text-xs bg-muted rounded p-2" value={cleanerMessage(viewLinkUrl)} />
                            <div className="flex flex-wrap gap-2 mt-1">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={async () => {
                                  if (await copyText(cleanerMessage(viewLinkUrl))) setCleanerCopyStatus("Cleaner message copied.");
                                  else { setManualCopy({ text: cleanerMessage(viewLinkUrl), label: "Message — copy it manually:", owner: "cleaner" }); setCleanerCopyStatus("Copy failed — copy the message manually below."); }
                                }}
                              >
                                Copy message
                              </Button>
                              <Button variant="outline" size="sm" onClick={() => openShare("wa", cleanerMessage(viewLinkUrl), phone)}>
                                WhatsApp
                              </Button>
                              <Button variant="outline" size="sm" onClick={() => openShare("sms", cleanerMessage(viewLinkUrl), phone)}>
                                SMS
                              </Button>
                            </div>
                          </div>
                        )}
                        {viewLinkError && <p className="text-sm text-destructive mt-1" role="alert">{viewLinkError}</p>}
                      </div>
                    ) : (
                      <div>
                        <p className="text-sm mb-2">
                          This link was created before reusable links existed, so it can’t be re-fetched here. It still works until it expires.
                        </p>
                        <p className="text-sm">
                          {v.cleaner_link_opened_at ? <>Opened {fmtDateTimeET(v.cleaner_link_opened_at)}</> : "Not opened yet"}
                          {" · "}Access expires {fmtDateET(v.cleaner_link_expires)}
                        </p>
                        <Button variant="outline" className="mt-2" onClick={replaceCleanerLink}>
                          Create a reusable access link
                        </Button>
                      </div>
                    )}

                    {assigned && linkIssued && (
                      <details className="mt-3">
                        <summary className="text-sm underline text-muted-foreground cursor-pointer">More</summary>
                        <div className="flex flex-wrap gap-2 mt-2">
                          <Button variant="outline" size="sm" onClick={replaceCleanerLink}>
                            {linkReusable ? "Replace access link" : "Create a reusable access link"}
                          </Button>
                          <Button variant="outline" size="sm" onClick={openEditDetails}>
                            Edit details
                          </Button>
                        </div>
                      </details>
                    )}
                    {cleanerCopyStatus && <p className="text-sm mt-2" role="status">{cleanerCopyStatus}</p>}
                    {manualCopy?.owner === "cleaner" && (
                      <div className="mt-1">
                        <p className="text-xs text-muted-foreground">{manualCopy.label}</p>
                        <input readOnly className="w-full text-xs bg-muted rounded p-2 mt-1" value={manualCopy.text} onFocus={(e) => e.target.select()} aria-label="Link or message (select and copy if the button does not work)" />
                      </div>
                    )}
                  </div>
                )}
              </section>

              {/* C. Schedule — confirming the visit is the owner's explicit action */}
              <section id="block-schedule" className="rounded-xl border border-border bg-card p-4 mb-4 scroll-mt-28">
                <h3 className="font-semibold mb-3">Schedule</h3>
                {(v.visit_confirmed && v.status !== "cancelled" && v.status !== "paid") && !scheduleEditing ? (
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm">Confirmed: {fmtVisitDate(v.visit_date)}{v.window ? ` · ${v.window}` : ""}</p>
                      <Button variant="outline" size="sm" onClick={() => { setConfirmDate(v.visit_date ?? ""); setConfirmWindow(v.window ?? ""); setScheduleEditing(true); }}>
                        Change
                      </Button>
                    </div>
                    {v.confirmation_email === "sent" && <p className="text-sm text-muted-foreground mt-1">Confirmation email: sent.</p>}
                    {v.confirmation_email === "failed" && (
                      <div className="flex flex-wrap items-center gap-2 mt-1">
                        <p className="text-sm text-destructive">Visit confirmed. Confirmation email failed.</p>
                        <Button variant="outline" size="sm" onClick={() => void runAction("Resend confirmation", { action: "resend_confirmation", booking_id: v.booking_id }, (j) => {
                          setActionMsg(j["email_sent"] === true ? "Confirmation email sent." : "Confirmation email failed again — check the address and retry.");
                        })}>
                          Resend confirmation email
                        </Button>
                      </div>
                    )}
                    <div className="flex flex-wrap gap-2 mt-2">
                      <Button variant="outline" size="sm" onClick={() => void copyClientLink()}>Copy client link</Button>
                      <Button variant="outline" size="sm" onClick={() => void previewClientView()}>Preview client view</Button>
                    </div>
                  </div>
                ) : v.status === "cancelled" || v.status === "paid" ? (
                  <p className="text-sm text-muted-foreground">This visit is {v.status} — confirmation no longer applies.</p>
                ) : (
                  <div>
                    {(!v.visit_confirmed && (v.report_status === "submitted" || v.report_status === "sent")) && (
                      <div className="rounded-xl border border-amber-500/60 bg-amber-50 p-3 mb-3">
                        <p className="text-sm font-semibold">Needs review</p>
                        <p className="text-sm">This visit has a submitted report but was never confirmed. Confirming below keeps the report in review — use the actual date, window, and cleaner from the run.</p>
                      </div>
                    )}
                    <h4 className="font-semibold mb-2">Confirm this visit</h4>
                    <dl className="space-y-1 text-sm mb-3">
                      <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Cleaner</dt><dd className="font-semibold text-right">{v.cleaner_name ?? "No cleaner assigned yet — choose below."}</dd></div>
                      <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Service</dt><dd className="font-semibold text-right">{v.service ?? "—"}</dd></div>
                      <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Agreed amount</dt><dd className="font-semibold text-right">{money(v.amount_cents)}</dd></div>
                    </dl>
                    {!assigned && (
                      <div className="mb-3">
                        <label className="block text-sm font-medium mb-1" htmlFor="assign-cleaner">Cleaner</label>
                        <select id="assign-cleaner" className="w-full border border-border rounded-lg px-3 py-2 bg-background text-sm" value={assignCleanerId} onChange={(e) => setAssignCleanerId(e.target.value)}>
                          <option value="">Choose a cleaner…</option>
                          {roster.filter((r) => r.active).map((r) => (
                            <option key={r.id} value={r.id}>{r.name}{r.phone ? ` · ${r.phone}` : ""}</option>
                          ))}
                        </select>
                        {roster.length === 0 && <p className="text-xs text-muted-foreground mt-1">No cleaners in the directory yet — add one in the Cleaners section on the visits list.</p>}
                      </div>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <input type="date" className="border border-border rounded-lg px-3 py-2 bg-background text-sm" value={confirmDate} onChange={(e) => setConfirmDate(e.target.value)} />
                      <input type="text" className="border border-border rounded-lg px-3 py-2 bg-background text-sm" placeholder="Window, e.g. 8–10 AM" value={confirmWindow} onChange={(e) => setConfirmWindow(e.target.value)} />
                      {!assigned ? (
                        <Button variant="hero" disabled={acting !== "" || !assignCleanerId || !confirmDate || !confirmWindow} onClick={() => void runAction("Assign & confirm visit", { action: "assign_confirm", booking_id: v.booking_id, cleaner_id: assignCleanerId, confirmed_date: confirmDate, confirmed_window: confirmWindow, ...((!v.visit_confirmed && (v.report_status === "submitted" || v.report_status === "sent")) ? { repair: true } : {}) }, (j) => {
                          setScheduleEditing(false);
                          if (j["already_confirmed"] === true) setActionMsg("Already assigned and confirmed — no duplicate email sent.");
                          else if (j["email_sent"] === true) setActionMsg("Cleaner assigned and visit confirmed. Confirmation email sent.");
                          else setActionMsg("Cleaner assigned and visit confirmed. Confirmation email failed.");
                        })}>
                          Assign &amp; confirm visit
                        </Button>
                      ) : (
                        <Button variant="hero" disabled={acting !== "" || !confirmDate || !confirmWindow} onClick={() => void runAction("Confirm visit & notify customer", { action: "confirm", booking_id: v.booking_id, confirmed_date: confirmDate, confirmed_window: confirmWindow, ...((!v.visit_confirmed && (v.report_status === "submitted" || v.report_status === "sent")) ? { repair: true } : {}) }, (j) => {
                          setScheduleEditing(false);
                          if (j["already_confirmed"] === true) setActionMsg("Already confirmed — no duplicate email sent.");
                          else if (j["email_sent"] === true) setActionMsg("Visit confirmed. Confirmation email sent.");
                          else setActionMsg("Visit confirmed. Confirmation email failed.");
                        })}>
                          Confirm visit &amp; notify customer
                        </Button>
                      )}
                    </div>
                    {!assigned && <p className="text-xs text-muted-foreground mt-1">Assignment uses the cleaner’s directory entry — the client gets the date, window, and cleaner in one confirmation email.</p>}
                    <p className="text-xs text-muted-foreground mt-1">Confirming emails the client the agreed date and window.</p>
                    <details className="mt-3">
                      <summary className="text-sm underline text-muted-foreground cursor-pointer">More scheduling options</summary>
                      <div className="flex flex-wrap gap-2 mt-2">
                        <input type="date" className="border border-border rounded-lg px-3 py-2 bg-background text-sm" value={altDate} onChange={(e) => setAltDate(e.target.value)} />
                        <Button variant="outline" onClick={() => void runAction("Propose another time", { action: "decline_date", booking_id: v.booking_id, alt_dates: altDate ? [altDate] : [] }, (j) => {
                          setActionMsg(j["email_sent"] === true
                            ? "Propose another time: done. The client was emailed the alternative date."
                            : "Propose another time: saved, but the email was NOT delivered — contact the client manually.");
                        })}>
                          Propose another time
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">Proposing emails the client an alternative date — a proposal is not a confirmation.</p>
                    </details>
                  </div>
                )}
              </section>

              {/* D. Report */}
              <section id="block-report" className="rounded-xl border border-border bg-card p-4 mb-4 scroll-mt-28">
                <h3 className="font-semibold mb-3">Report</h3>
                <p className="text-sm mb-2">{reportLabel(v.report_status)}</p>
                {v.checklist?.problem_note && (
                  <div className="rounded-xl border border-amber-500/50 bg-amber-50 p-3 mb-3">
                    <p className="text-sm font-semibold">Cleaner&apos;s note</p>
                    <p className="text-sm">{v.checklist.problem_note}</p>
                  </div>
                )}
                {rooms.length > 0 && (
                  <div className="mb-3">
                    <p className="text-sm">
                      {rooms.map((r) => `${r.name} ${r.items.filter((i) => i.done).length}/${r.items.length}`).join(" · ")}
                    </p>
                    <details>
                      <summary className="text-sm underline text-muted-foreground cursor-pointer">View checklist</summary>
                      <ul className="space-y-1 text-sm mt-1">
                        {rooms.map((r) => (
                          <li key={r.name}>
                            <span className="font-medium">{r.name}:</span>{" "}
                            {r.items.map((i) => i.label).join(", ")}
                            {r.skip_reason ? <> · <span className="text-amber-700">Exception: {r.skip_reason}</span></> : null}
                          </li>
                        ))}
                      </ul>
                    </details>
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
                                void runAction("Delete photo", { action: "owner_photo_delete", booking_id: v.booking_id, photo_id: ph.id })
                              }
                            >
                              ✕
                            </button>
                          </div>
                        ))}
                    </div>
                  </div>
                ))}

                {v.report_status === "submitted" && (
                  <div className="mb-3">
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="hero"
                        disabled={acting !== ""}
                        onClick={() => {
                          if (v.issue_open && !window.confirm("This booking has an OPEN customer issue. Re-sending the report will mark the issue RESOLVED and restart the 24-hour review clock. Continue?")) return;
                          void runAction("Publish & notify customer", { action: "send_report", booking_id: v.booking_id, ...(v.issue_open ? { resolve_issue: true } : {}) }, (j) => {
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
                          void runAction("Preview", { action: "preview_link", booking_id: v.booking_id }, (j) => {
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
                        disabled={acting !== "" || v.report_status !== "submitted"}
                        onClick={() => void runAction("Request changes", { action: "return_report", booking_id: v.booking_id, note: returnNote })}
                      >
                        Request changes
                      </Button>
                    </div>
                  </div>
                )}

                {v.report_status === "sent" && (
                  <div className="mb-3">
                    <p className="text-sm">
                      Report sent to the client
                      {v.report_email === "sent" ? " · Email: sent." : (v.report_email === "failed" || v.report_bounced) ? " · Email failed." : ""}
                    </p>
                    {(v.report_email === "failed" || v.report_bounced) && (
                      <div className="flex flex-wrap gap-2 mt-2">
                        <Button
                          variant="outline"
                          disabled={acting !== ""}
                          onClick={() => void runAction("Re-send report email", { action: "send_report", booking_id: v.booking_id }, (j) => {
                            setPublishMsg(j["email_sent"] === true ? "Report email re-sent." : "Report email failed again — check the address and retry.");
                          })}
                        >
                          Re-send report email
                        </Button>
                      </div>
                    )}
                    {publishMsg && <p className="text-sm mt-2" role="status">{publishMsg}</p>}
                  </div>
                )}

                <details>
                  <summary className="text-sm underline text-muted-foreground cursor-pointer">More</summary>
                  <div className="mt-3 border-t border-border pt-3">
                    <p className="text-sm font-medium mb-2">Upload photos on behalf of cleaner</p>
                    <div className="flex flex-wrap gap-2 items-center">
                      <select className="border border-border rounded-lg px-2 py-2 bg-background text-sm" value={ownerRoom} onChange={(e) => setOwnerRoom(e.target.value)}>
                        {[...rooms.map((r) => r.name), "Other areas"].map((r) => (
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
                </details>
              </section>

              {/* E. Payment — manual Charge lives in More; server rules unchanged */}
              <section id="block-payment" className="rounded-xl border border-border bg-card p-4 mb-4 scroll-mt-28">
                <h3 className="font-semibold mb-3">Payment</h3>
                <p className="text-sm">
                  {money(v.amount_cents)}
                  {v.paid_at ? ` · Paid ${fmtDateET(v.paid_at)}` : stripeState ? ` · Stripe: ${stripeState}` : " · Not paid yet"}
                </p>
                {paymentFailed && (
                  <p className="text-sm text-destructive mt-1">
                    Payment failed — check the saved card, then retry from the customer’s report page or charge again below.
                  </p>
                )}
                <details className="mt-2">
                  <summary className="text-sm underline text-muted-foreground cursor-pointer">More actions</summary>
                  <div className="mt-2">
                    <Button
                      variant="outline"
                      onClick={() => void runAction("Charge", { action: "charge", booking_id: v.booking_id, amount_cents: v.amount_cents ?? undefined })}
                    >
                      Charge {money(v.amount_cents)}
                    </Button>
                    <p className="text-xs text-muted-foreground mt-1">
                      Works only after the client approved (or the agreed automatic rule fired). Server errors are shown as-is.
                    </p>
                  </div>
                </details>
              </section>

              {/* F. Activity — collapsed by default */}
              <details className="rounded-xl border border-border bg-card p-4 mb-4">
                <summary className="font-semibold cursor-pointer">Activity</summary>
                <ul className="space-y-1 text-sm mt-2">
                  {events.map((e) => {
                    const visibleDetail = e.detail
                      ? Object.fromEntries(Object.entries(e.detail).filter(([k]) => !HIDDEN_DETAIL_KEYS.test(k) && k !== "note"))
                      : {};
                    return (
                      <li key={e.id} className="text-muted-foreground">
                        <span className="text-foreground">{fmtDateTimeET(e.created_at)}</span> — {EVENT_LABELS[e.event] ?? e.event}
                        {typeof e.detail?.note === "string" && e.detail.note ? <> — “{e.detail.note}”</> : null}
                        {Object.keys(visibleDetail).length > 0 && (
                          <details className="ml-4">
                            <summary className="cursor-pointer text-xs underline">Details</summary>
                            <pre className="text-xs whitespace-pre-wrap">{JSON.stringify(visibleDetail, null, 2)}</pre>
                          </details>
                        )}
                      </li>
                    );
                  })}
                  {events.length === 0 && <li className="text-muted-foreground">No events yet.</li>}
                </ul>
              </details>

              {actionMsg && <p className="text-sm" role="status">{actionMsg}</p>}
            </div>
          );
        })()}
      </div>
    </div>
  );
};

export default Owner;
