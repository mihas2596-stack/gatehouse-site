import { useCallback, useEffect, useRef, useState } from "react";
import { Helmet } from "react-helmet-async";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { convertToJpeg } from "@/lib/imageConvert";
import {
  attentionItems,
  nextActionFor,
  reportLabel,
  stripeLabel,
  visitLabel,
  type FocusBlock,
} from "@/lib/ownerActions";

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
  can_charge?: boolean;
  visit_confirmed?: boolean;
  entry_agreed?: boolean;
  entry_method?: string | null;
  entry_detail?: string | null;
  entry_notes?: string | null;
  entry_choice?: { method: string | null; detail: string | null; notes: string | null } | null;
  entry?: { method: string | null; note: string; has_secret: boolean; secret?: string | null; assigned_cleaner_id?: string | null; expires_at?: string | null; reminder_sent?: boolean } | null;
  proposed_date?: string;
  proposed_pending?: boolean;
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
// Entry status for the owner panel: the quote-time choice (row) wins,
// the saved arrangement (gh_visit_access) is the fallback for older rows.
function entryStatusText(v: Visit): string {
  const method = v.entry_choice?.method ?? v.entry_method ?? v.entry?.method ?? null;
  const detail = v.entry_choice?.detail ?? v.entry_detail ?? null;
  if (!method) return "Not arranged yet";
  if (method === "decide_later") return "To be arranged — contact the client";
  if (method === "arrange_before" || method === "arrange") {
    if (detail === "door_code") return "Arrange entry before the visit (Door code / smart lock)";
    if (detail === "lockbox") return "Arrange entry before the visit (Lockbox)";
    if (detail === "other") return "Arrange entry before the visit (Other arrangement)";
    return "Arrange entry before the visit";
  }
  if (method === "home") return "Client will be home to let the cleaner in";
  if (method === "someone" || method === "other_person") return "Someone else will meet the cleaner";
  return method;
}

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

const Owner = () => {
  const [token, setToken] = useState(() => sessionStorage.getItem("gh_owner_session") ?? sessionStorage.getItem("gh_admin_token") ?? "");
  const [verifyingLogin, setVerifyingLogin] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const [showTokenForm, setShowTokenForm] = useState(false);
  const [linkMsg, setLinkMsg] = useState("");
  const [visits, setVisits] = useState<Visit[]>([]);
  // Test bookings are hidden by default (the owner has dozens of them);
  // the choice persists across sessions.
  const [hideTest, setHideTest] = useState(() => {
    try {
      return typeof localStorage !== "undefined" ? localStorage.getItem("gh_hide_test") !== "0" : true;
    } catch {
      return true;
    }
  });
  const setHideTestPersist = (value: boolean) => {
    setHideTest(value);
    try {
      localStorage.setItem("gh_hide_test", value ? "1" : "0");
    } catch {
      /* private mode: session-only */
    }
  };
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
    // While the emailed link verifies, show a waiting state — never the
    // login form, which reads as "login failed" on a slow connection.
    setVerifyingLogin(true);
    fetch("/api/owner-auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "verify", ol }),
    })
      .then((r) => r.json())
      .then((j) => {
        setVerifyingLogin(false);
        if (j?.ok && typeof j.session === "string") {
          sessionStorage.setItem("gh_owner_session", j.session);
          setToken(j.session);
        } else {
          setError("This login link is invalid or expired — request a new one below.");
        }
      })
      .catch(() => { setVerifyingLogin(false); setError("Couldn't verify this login link — request a new one below."); });
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

  // Opening a card scrolls to its top and focuses its title; a
  // Needs-attention deep link scrolls to the block that needs the
  // action instead. Runs once per opened visit: the detail reload
  // replaces the selected object, and must not yank a deep link back
  // to the top.
  const scrolledIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!selected || scrolledIdRef.current === selected.id) return;
    scrolledIdRef.current = selected.id;
    const focus = pendingFocusRef.current;
    pendingFocusRef.current = null;
    const t = window.setTimeout(() => {
      if (focus) {
        document.getElementById(`block-${focus}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
      } else {
        window.scrollTo({ top: 0 });
        document.getElementById("owner-detail-title")?.focus({ preventScroll: true });
      }
    }, 100);
    return () => window.clearTimeout(t);
  }, [selected]);

  const openVisit = async (v: Visit, focus?: FocusBlock) => {
    scrolledIdRef.current = null;
    const sameVisit = selectedIdRef.current === v.id;
    selectedIdRef.current = v.id;
    if (focus) pendingFocusRef.current = focus;
    setSelected(v);
    // The edit form always mirrors the loaded card: after an assignment
    // the panel reopens the same visit from a stale list, and leaving
    // the old editing state in place used to show a blank form.
    setCleanerEditing(!v.cleaner_name);
    setFormPhone(v.cleaner_profile?.phone ?? "");
    setFormPhoto(v.cleaner_profile?.photo ?? "");
    setFormError("");
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
        setCleanerEditing(!j.visit.cleaner_name);
        setFormPhone(j.visit.cleaner_profile?.phone ?? "");
        setFormPhoto(j.visit.cleaner_profile?.photo ?? "");
      }
      const sr = await fetch("/api/booking-action", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ action: "status", booking_id: v.booking_id }),
      });
      // O2: the status action returns state at the ROOT, not under ops
      // (ops carries the detail fields). Reading ops.state always yielded
      // undefined, so the Stripe line never updated.
      const sj = (await sr.json()) as { ok: boolean; state?: string };
      if (sj.ok && sj.state) setStripeState(sj.state);
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

  // G5: busy state always resets (finally), a failed fetch or bad JSON
  // yields a readable message instead of a stuck spinner, and on an
  // unknown outcome the panel re-reads state before any retry, so a
  // repeat cannot create a second action.
  const runAction = async (label: string, payload: Record<string, unknown>, after?: (j: Record<string, unknown>) => void) => {
    setActing(label);
    setActionMsg(`${label}: working…`);
    try {
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
    } catch {
      setActionMsg(`${label}: couldn't reach the server — the action may or may not have run. Reloading the visit before you retry.`);
      void loadList();
      if (selected) {
        const fresh = visits.find((x) => x.id === selected.id);
        if (fresh) void openVisit(fresh);
      }
    } finally {
      setActing("");
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

  // Save the assigned cleaner's contact details. The name is read-only
  // here: assignments come from the directory by ID only, never from a
  // free-text name — sending the card's own name keeps the link and
  // updates just the phone/photo.
  const assignCleaner = () => {
    if (!selected || !selected.cleaner_name) return;
    if (formPhoto.trim() && !formPhoto.trim().startsWith("https://")) {
      setFormError("Photo URL must start with https://.");
      return;
    }
    setFormError("");
    const visitId = selected.id;
    const seq = linkSeqRef.current + 1;
    linkSeqRef.current = seq;
    void runAction("Save cleaner details", {
      action: "set_cleaner",
      booking_id: selected.booking_id,
      cleaner_name: selected.cleaner_name,
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

  if (!token && verifyingLogin) {
    return (
      <div className="min-h-screen bg-background px-4 py-16">
        <Helmet><meta name="robots" content="noindex,nofollow" /></Helmet>
        <div className="max-w-sm mx-auto text-center">
          <h1 className="font-heading text-3xl font-bold mb-4">Owner view</h1>
          <p className="text-sm text-muted-foreground" role="status">Verifying your login link…</p>
        </div>
      </div>
    );
  }

  if (!token) {
    return (
      <div className="min-h-screen bg-background px-4 py-16">
        <Helmet><meta name="robots" content="noindex,nofollow" /></Helmet>
        <div className="max-w-sm mx-auto text-center">
          <h1 className="font-heading text-3xl font-bold mb-4">Owner view</h1>
          <p className="text-sm text-muted-foreground mb-4">Get a login link by email — no key needed.</p>
          {error && <p className="text-sm text-destructive mb-3" role="alert">{error}</p>}
          <Button
            variant="hero"
            className="w-full"
            onClick={async () => {
              setLinkMsg("");
              try {
                const r = await fetch("/api/owner-auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "send" }) });
                const j = await r.json();
                setLinkMsg(j?.ok ? "Login link sent — check nikolajmihasenok@gmail.com (valid 24 hours)." : "Couldn't send the link — try again in a minute.");
              } catch {
                setLinkMsg("Couldn't send the link — try again in a minute.");
              }
            }}
          >
            Send login link to my email
          </Button>
          {linkMsg && <p className="text-sm mt-3">{linkMsg}</p>}
          {!showTokenForm ? (
            <button type="button" className="text-sm underline text-muted-foreground mt-4" onClick={() => setShowTokenForm(true)}>
              Use admin token instead
            </button>
          ) : (
            <div className="mt-4">
              <input
                type="password"
                className="w-full border border-border rounded-lg px-3 py-2 mb-3 bg-background"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder="ADMIN_TOKEN"
              />
              <Button
                variant="outline"
                className="w-full"
                onClick={() => {
                  sessionStorage.setItem("gh_admin_token", tokenInput.trim());
                  setToken(tokenInput.trim());
                }}
              >
                Open with admin token
              </Button>
              <button type="button" className="text-sm underline text-muted-foreground mt-3" onClick={() => setShowTokenForm(false)}>
                Back to email login
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }


  // Next action for a list row — the shared nextActionFor, from the row
  // alone (no event/stripe detail on the list).
  const rowNextAction = (v: Visit): string => nextActionFor(v, Boolean(v.payment_failed));

  // The list and every filter read through this so "Hide test bookings"
  // hides test rows everywhere at once.
  const listedVisits = hideTest ? visits.filter((v) => !v.is_test) : visits;

  // Task-centered filters — one list, no duplicated queues. "Needs
  // attention" is the shared attentionItems rule (plus bounced reports,
  // which need a re-send); "Upcoming" is the active pipeline.
  type OwnerFilter = "attention" | "upcoming" | "completed" | "cancelled" | "all";
  const [filter, setFilter] = useState<OwnerFilter>("attention");
  const isAttention = (v: Visit): boolean => attentionItems(v).length > 0 || v.report_bounced;
  const filterCounts: Record<OwnerFilter, number> = {
    attention: listedVisits.filter(isAttention).length,
    upcoming: listedVisits.filter((v) => v.status !== "cancelled" && v.status !== "paid").length,
    completed: listedVisits.filter((v) => v.status === "paid").length,
    cancelled: listedVisits.filter((v) => v.status === "cancelled").length,
    all: listedVisits.length,
  };
  const FILTERS: { key: OwnerFilter; label: string; empty: string }[] = [
    { key: "attention", label: "Needs attention", empty: "Nothing needs attention right now." },
    { key: "upcoming", label: "Upcoming", empty: "No upcoming visits." },
    { key: "completed", label: "Completed", empty: "No completed visits yet." },
    { key: "cancelled", label: "Cancelled", empty: "No cancelled visits." },
    { key: "all", label: "All visits", empty: "No visits yet." },
  ];
  const filteredVisits = listedVisits.filter((v) => {
    if (filter === "all") return true;
    if (filter === "cancelled") return v.status === "cancelled";
    if (filter === "completed") return v.status === "paid";
    if (filter === "upcoming") return v.status !== "cancelled" && v.status !== "paid";
    return isAttention(v);
  });

  return (
    <div className="min-h-screen bg-background page-shell">
      <Helmet><meta name="robots" content="noindex,nofollow" /></Helmet>
      <div className={selected ? "mx-auto px-4 pb-6 lg:max-w-7xl" : "max-w-5xl mx-auto px-4 pb-6"}>
        <div className="flex items-center justify-between mb-4">
          <h1 className="font-heading text-3xl font-bold">Visits</h1>
          <Button variant="outline" size="sm" onClick={() => void loadList()}>
            <RefreshCw className="w-4 h-4 mr-1" /> Refresh
          </Button>
        </div>
        {error && <p className="text-sm text-destructive mb-3" role="alert">{error}</p>}
        {loading && <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />}
        <div className={selected ? "lg:grid lg:grid-cols-[380px_minmax(0,1fr)] lg:gap-6 lg:items-start" : ""}>
          <div className={selected ? "hidden lg:block lg:sticky lg:top-24 lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto lg:pr-1" : ""}>
          <label className="flex items-center gap-2 text-sm mb-4">
            <input type="checkbox" checked={hideTest} onChange={(e) => setHideTestPersist(e.target.checked)} />
            Hide test bookings
          </label>

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

                  <div className="flex flex-wrap gap-2 mb-4" role="group" aria-label="Filter visits">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                aria-pressed={filter === f.key}
                onClick={() => setFilter(f.key)}
                className={`min-h-[44px] rounded-full px-3 py-1.5 text-sm font-semibold ${filter === f.key ? "bg-primary text-primary-foreground" : "border border-border bg-card"}`}
              >
                {f.label} ({filterCounts[f.key]})
              </button>
            ))}
          </div>
          <div className="space-y-2">
            {filteredVisits.map((v) => (
              <button
                key={v.id}
                type="button"
                className={`w-full text-left rounded-xl border bg-card p-4 hover:border-primary ${selected?.id === v.id ? "border-primary ring-1 ring-primary" : "border-border"}`}
                onClick={() => void openVisit(v)}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{v.client_name ?? "—"}</span>
                  {v.is_test && <span className="text-[10px] bg-amber-100 text-amber-900 px-1.5 py-0.5 rounded">TEST</span>}
                  <span className="text-sm text-muted-foreground">{fmtVisitDate(v.visit_date)} {v.window ?? ""} · {money(v.amount_cents)}</span>
                </div>
                <div className="text-sm font-medium mt-1">Next: {rowNextAction(v)}</div>
                <div className="flex flex-wrap gap-1.5 mt-2 text-[11px]">
                  <span className="bg-muted px-2 py-0.5 rounded">Visit: {visitLabel(v.status)}</span>
                  {v.cleaner_name
                    ? <span className="bg-sky-100 text-sky-900 px-2 py-0.5 rounded">cleaner: {v.cleaner_name}</span>
                    : <span className="bg-amber-100 text-amber-900 px-2 py-0.5 rounded">Needs a cleaner</span>}
                </div>
              </button>
            ))}
            {filteredVisits.length === 0 && !loading && !error && (
              <p className="text-muted-foreground text-sm">
                {filter === "all"
                  ? (visits.length === 0 ? "No visits in the database yet." : "No non-test visits — uncheck “Hide test bookings” to see them.")
                  : FILTERS.find((f) => f.key === filter)?.empty}
              </p>
            )}
          </div>
        </div>

        {selected && (() => {
          if (!selected) return null;
          const v = selected;
          // O3: the server computes payment_failed from the journal
          // (latest failure vs later success + paid row). OR-ing in any
          // historical event or the shared Stripe state here used to
          // resurrect cleared failures.
          const paymentFailed = Boolean(v.payment_failed);
          // O1: show the open problem itself (room + reason), not just
          // the "Resolve" button: the latest issue_opened event with no
          // later issue_resolved.
          const openIssue = (() => {
            const byTimeDesc = [...events].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
            const opened = byTimeDesc.find((e) => e.event === "issue_opened");
            if (!opened) return null;
            const resolved = byTimeDesc.find((e) => e.event === "issue_resolved");
            if (resolved && resolved.created_at >= opened.created_at) return null;
            return opened;
          })();
          const nextAction = nextActionFor(v, paymentFailed);
          const assigned = Boolean(v.cleaner_name);
          const isTerminal = v.status === "cancelled" || v.status === "paid";
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
            setFormPhone(phone ?? "");
            setFormPhoto(photo ?? "");
            setFormError("");
            setCleanerEditing(true);
          };

          return (
            <div>
              <button type="button" className="text-sm underline text-muted-foreground mb-3" onClick={() => { scrolledIdRef.current = null; setSelected(null); }}>
                ← Back to visits
              </button>
              {/* Action feedback lives here, at the top of the detail —
                  not only at the page bottom: on a phone the result of a
                  tap must be visible where the tap happened. */}
              {actionMsg && <p className="text-sm mb-3" role="status">{actionMsg}</p>}

              {/* A. Summary */}
              <section id="block-summary" className="rounded-xl border border-border bg-card p-4 mb-4 scroll-mt-28">
                <h2 id="owner-detail-title" tabIndex={-1} className="font-heading text-2xl font-bold outline-none">{v.client_name ?? "—"}</h2>
                <p className="text-sm text-muted-foreground">
                  {v.service ?? ""} · {fmtVisitDate(v.visit_date)} {v.window ?? ""} · {money(v.amount_cents)}
                </p>
                <p className="text-sm">{v.address ?? ""}</p>
                {v.access_notes && <p className="text-sm">Access: {v.access_notes}</p>}
                <p className="text-sm">
                  Visit: <strong>{visitLabel(v.status)}</strong> · Report: <strong>{reportLabel(v.report_status)}</strong>
                  {stripeState && <> · Stripe: <strong>{stripeLabel(stripeState)}</strong></>}
                  {v.issue_open && <> · <span className="text-destructive font-semibold">Issue open</span></>}
                </p>
                <p className="text-sm font-medium mt-1">Next: {nextAction}</p>
                {v.issue_open && (
                  <div className="flex flex-wrap gap-2 mt-2 items-center">
                    {openIssue && (
                      <p className="text-sm w-full">
                        Issue{typeof openIssue.detail?.room === "string" && openIssue.detail.room ? ` · ${openIssue.detail.room}` : ""}: {typeof openIssue.detail?.reason === "string" && openIssue.detail.reason ? openIssue.detail.reason : "no details given"}
                      </p>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={acting !== ""}
                      onClick={() => {
                        if (!window.confirm("Mark this issue resolved? The client will be able to approve the existing report. Automatic charging stays off for this booking — the client must approve, or you charge manually.")) return;
                        void runAction("Resolve issue", { action: "resolve", booking_id: v.booking_id });
                      }}
                    >
                      Resolve issue
                    </Button>
                    <span className="text-xs text-muted-foreground">Clears the issue without re-sending the report or restarting the review clock.</span>
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-2 mt-2">
                  <span className="text-sm text-muted-foreground">{v.client_email ?? ""}</span>
                  <Button variant="outline" size="sm" onClick={() => void copyClientLink()}>
                    Copy client link (visit + payment)
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground mt-1">For the client — dates, report, payment. Never send this to the cleaner.</p>
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
                {isTerminal ? (
                  <div>
                    {assigned ? (
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
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">No cleaner assigned.</p>
                    )}
                    <p className="text-sm text-muted-foreground mt-2">This visit is {visitLabel(v.status).toLowerCase()} — cleaner changes no longer apply.</p>
                  </div>
                ) : (
                <>
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
                      <p className="text-sm"><span className="text-muted-foreground">Cleaner: </span><strong>{v.cleaner_name}</strong><span className="text-muted-foreground"> — the name comes from the directory; edit the phone and photo here.</span></p>
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

                    {/* One status line + one hero button for every link state:
                        WhatsApp/SMS appear only when a link can be copied. */}
                    {!linkIssued && <p className="text-sm text-muted-foreground mb-2">No access link yet.</p>}
                    {linkIssued && !linkActive && <p className="text-sm mb-2">Access expired.</p>}
                    {linkIssued && linkActive && !linkReusable && (
                      <p className="text-sm mb-2">
                        This link was created before reusable links existed, so it can’t be re-fetched here. It still works until it expires.
                      </p>
                    )}
                    {linkIssued && linkActive && linkReusable ? (
                      <div>
                        <div className="flex flex-wrap gap-2 mb-2">
                          <Button variant="hero" onClick={() => void copyCleanerLink()}>
                            Copy cleaner link (job + photos)
                          </Button>
                          <Button variant="outline" onClick={() => void withLink((url) => openShare("wa", cleanerMessage(url), phone))}>
                            WhatsApp
                          </Button>
                          <Button variant="outline" onClick={() => void withLink((url) => openShare("sms", cleanerMessage(url), phone))}>
                            SMS
                          </Button>
                        </div>
                        <p className="text-xs text-muted-foreground mb-2">For the cleaner — address, rooms, checklist, photos. Never send this to the client.</p>
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
                        {linkIssued && (
                          <p className="text-sm mb-2">
                            {v.cleaner_link_opened_at ? <>Opened {fmtDateTimeET(v.cleaner_link_opened_at)}</> : "Not opened yet"}
                            {" · "}Access expires {fmtDateET(v.cleaner_link_expires)}
                          </p>
                        )}
                        <Button variant="hero" onClick={replaceCleanerLink}>
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
                </>
                )}
              </section>

              {/* C. Schedule — confirming the visit is the owner's explicit action */}
              <section id="block-schedule" className="rounded-xl border border-border bg-card p-4 mb-4 scroll-mt-28">
                <h3 className="font-semibold mb-3">Schedule</h3>
                {v.proposed_pending && v.proposed_date && v.status !== "cancelled" && v.status !== "paid" && (
                  <p className="text-sm mb-3 rounded-lg bg-sky-50 border border-sky-200 p-3" role="status">
                    Client proposed <strong>{fmtVisitDate(v.proposed_date)}</strong> — awaiting your confirmation.
                    The confirmed date stays until you confirm the new one.
                  </p>
                )}
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
                      <Button variant="outline" size="sm" onClick={() => void previewClientView()}>Preview client view (view only)</Button>
                    </div>
                  </div>
                ) : v.status === "cancelled" || v.status === "paid" ? (
                  <p className="text-sm text-muted-foreground">This visit is {visitLabel(v.status).toLowerCase()} — confirmation no longer applies.</p>
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
                          // The server mints the cleaner link on first
                          // assignment — surface it here (same as a cleaner
                          // change does) instead of leaving the owner to
                          // hunt for it in the Cleaner block above.
                          if (typeof j["url"] === "string") {
                            const seq = linkSeqRef.current + 1;
                            linkSeqRef.current = seq;
                            noteLinkResult(v.id, j["url"] as string, seq);
                            setViewLinkUrl(j["url"] as string);
                            setViewLinkOpen(true);
                            pendingFocusRef.current = "cleaner";
                          }
                          if (j["already_confirmed"] === true) setActionMsg("Already assigned and confirmed — no duplicate email sent.");
                          else if (j["email_sent"] === true) setActionMsg(`Cleaner assigned and visit confirmed. Confirmation email sent.${typeof j["url"] === "string" ? " The cleaner link is open in the Cleaner block above." : ""}`);
                          else setActionMsg(`Cleaner assigned and visit confirmed. Confirmation email failed.${typeof j["url"] === "string" ? " The cleaner link is open in the Cleaner block above." : ""}`);
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

              {/* Entry — quote-time choice, saved arrangement, action needed */}
              <section id="block-entry" className="rounded-xl border border-border bg-card p-4 mb-4 scroll-mt-28">
                <h3 className="font-semibold mb-3">Entry</h3>
                <p className="text-sm mb-2">Booking choice: {entryStatusText(v)}</p>
                {(v.entry_choice?.notes ?? v.entry_notes) && (
                  <p className="text-sm mb-2">Parking/building notes: {v.entry_choice?.notes ?? v.entry_notes}</p>
                )}
                {v.entry?.method && (
                  <p className="text-sm mb-2">Saved arrangement: {v.entry.method === "home" ? "Client will be home" : v.entry.method === "someone" ? "Someone else will meet the cleaner" : "Arrange entry before the visit"}{v.entry.has_secret ? " · private entry details saved" : " · no private details yet"}</p>
                )}
                {v.entry?.reminder_sent && (
                  <p className="text-sm text-muted-foreground mb-2">Entry reminder sent.</p>
                )}
                {v.visit_confirmed && v.status !== "cancelled" && v.status !== "paid" && !v.entry_agreed && (
                  <p className="text-sm font-semibold rounded-lg bg-amber-50 border border-amber-500/60 p-3" role="status">Action needed before dispatch: entry is not settled. Contact the client — do not send the cleaner to an unsettled entry.</p>
                )}
                {v.entry_agreed && (
                  <p className="text-sm text-muted-foreground">Entry settled.</p>
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
                        disabled={acting !== "" || !(v.report_status === "submitted" || (v.report_status === "sent" && v.issue_open))}
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
                      disabled={v.can_charge === false}
                      onClick={() => void runAction("Charge", { action: "charge", booking_id: v.booking_id, amount_cents: v.amount_cents ?? undefined })}
                    >
                      Charge {money(v.amount_cents)}
                    </Button>
                    <p className="text-xs text-muted-foreground mt-1">
                      {v.can_charge === false
                        ? "No payment basis yet — the client must approve the report, or 24 hours must pass with no open issue. The server enforces this."
                        : "Works only after the client approved (or the agreed automatic rule fired). Server errors are shown as-is."}
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

            </div>
          );
        })()}
        </div>
      </div>
    </div>
  );
};

export default Owner;
