import { formatArrivalWindow } from "@/lib/utils";
import { useCallback, useEffect, useRef, useState } from "react";
import { Helmet } from "react-helmet-async";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { convertToJpeg } from "@/lib/imageConvert";
import { photoBlocked } from "@/lib/photoPolicy";
import { cleanerJobMessage } from "@/lib/cleanerMessage";
import ClientContact from "@/components/ClientContact";
import {
  attentionItems,
  nextActionFor,
  isPastUnfinishedVisit,
  reportLabel,
  stripeLabel,
  visitBadgeLabel,
  visitLabel,
  type FocusBlock,
} from "@/lib/ownerActions";

type CleanerProfile = { phone?: string | null; photo?: string | null };

type Visit = {
  id: string;
  booking_id: string;
  client_name: string | null;
  client_email: string | null;
  client_phone?: string | null;
  service: string | null;
  visit_date: string | null;
  window: string | null;
  address: string | null;
  access_notes: string | null;
  no_photo_zones?: string | null;
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
  // TASK 1 (fix6): open-issue detail for the "Open issues" block,
  // batched by the list endpoint — see api/owner.ts.
  issue_opened_at?: string | null;
  issue_reason?: string | null;
  issue_room?: string | null;
  issue_decision?: { decision: string; resolution: string; decided_at: string } | null;
  report_bounced: boolean;
  report_sent_at?: string | null;
  payment_failed?: boolean;
  // C3: journal view of the card (latest `card_confirmed` event), batched
  // by the list endpoint — see api/owner.ts. Not live Stripe state: a
  // detached card still reads true here; the detail view is authoritative.
  card_confirmed?: boolean;
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

// TASK 1 (fix6): short "opened 3h ago" label for the Open issues block.
const timeAgo = (iso: string | null | undefined): string => {
  const ms = Date.parse(iso ?? "");
  if (!Number.isFinite(ms)) return "";
  const mins = Math.max(0, Math.floor((Date.now() - ms) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
};

const ISSUE_DECISION_LABEL: Record<string, string> = {
  payment_requested: "Payment requested",
  reclean: "Re-clean arranged",
  waived: "Charge waived",
};

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

// C8: entry data was never saved for test-era bookings — entry_method /
// entry_detail are NULL even for paid ones — so "not agreed" is the
// default, not a signal. The "do not send the cleaner" warning is
// only meaningful for a confirmed, upcoming, real visit: never for a
// test booking, a visit that already happened (report sent), or a
// date in the past.
export function entryNeedsAttention(v: Visit): boolean {
  if (v.entry_agreed) return false;
  if (!v.visit_confirmed) return false;
  if (v.status === "cancelled" || v.status === "paid") return false;
  if (v.is_test) return false;
  if (v.report_status === "sent" || v.report_status === "submitted") return false;
  if (!v.visit_date) return false;
  const todayET = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  return v.visit_date >= todayET;
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

// Noon in America/New_York for a YYYY-MM-DD date — the same rule the
// server's 48h cancel clock uses. A fixed -04:00/-05:00 offset is
// wrong across EST/EDT, so the noon wall-clock reading is converted
// via Intl. Used only for the owner's cancel-fee hint; the server
// decides the real fee.
const visitNoonETMs = (d: string): number => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return NaN;
  const [y, m, day] = d.split("-").map(Number);
  const noonGuess = Date.UTC(y, m - 1, day, 12, 0, 0);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(noonGuess));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? NaN);
  const wallAsUTC = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  if (!Number.isFinite(wallAsUTC)) return NaN;
  return noonGuess + (noonGuess - wallAsUTC);
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
  // Fix round 2: refund / dispute / basis-blocked payment events from
  // the Stripe webhook — the owner must see them in Activity.
  payment_refunded: "Payment refunded",
  payment_disputed: "Payment disputed in Stripe",
  payment_succeeded_no_basis: "Payment succeeded but not recorded — needs review",
  client_link_issued: "Client link created",
  date_proposed: "Another date proposed",
  client_note: "Customer note",
  scope_review: "Scope review",
};

// Detail keys that must never render in Activity (defense in depth —
// events should not carry them, but the panel never displays them).
const HIDDEN_DETAIL_KEYS = /token|hash|secret|password|api[_-]?key/i;
type OwnerFilter = "attention" | "upcoming" | "past" | "completed" | "cancelled" | "all";

const Owner = () => {
  const [token, setToken] = useState(() => {
    // The session persists in localStorage across tabs and browser
    // restarts (30 days); sessionStorage is read only as a fallback for
    // sessions minted before this change. The hand-typed admin token
    // stays session-only by design.
    try {
      return localStorage.getItem("gh_owner_session") ?? sessionStorage.getItem("gh_owner_session") ?? sessionStorage.getItem("gh_admin_token") ?? "";
    } catch {
      return "";
    }
  });
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const [verifyingLogin, setVerifyingLogin] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const [showTokenForm, setShowTokenForm] = useState(false);
  const [linkMsg, setLinkMsg] = useState("");
  const [visits, setVisits] = useState<Visit[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
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
  // TASK 1 (fix6): the owner's decision text for the open issue —
  // shown to the client as "Our response".
  const [decisionResolution, setDecisionResolution] = useState("");
  const [stripeState, setStripeState] = useState("");
  // A2: the status action returns the live card state as
  // payment_method ("saved" / "none") — the "Card:" line in the
  // readiness checklist must read THIS, not the payment lifecycle
  // state (stripeState), which says "Requested"/"Paid" while a card
  // is already saved. "" means the status has not loaded yet.
  const [cardMethod, setCardMethod] = useState("");
  // C9: the status action returns the saved card's brand + last4 —
  // shown in the Payment block as "Visa •••• 4242" when both are known.
  const [cardBrand, setCardBrand] = useState("");
  const [cardLast4, setCardLast4] = useState("");
  // B4: the status action answers booking_not_found for a booking
  // with no Stripe customer at all (Kate) — the panel must say so
  // plainly instead of the neutral "Not paid yet".
  const [noStripeCustomer, setNoStripeCustomer] = useState(false);
  const [actionMsg, setActionMsg] = useState("");
  // "Tell the cleaner" prompt after an owner cancel or date change on a
  // visit with an assigned cleaner — the cleaner otherwise only finds
  // out by opening their link. Cleared when another visit is opened.
  const [tellCleaner, setTellCleaner] = useState<{ kind: "cancelled" | "date"; date: string; altDate?: string } | null>(null);
  const [returnNote, setReturnNote] = useState("");
  const [issueReason, setIssueReason] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [filter, setFilter] = useState<OwnerFilter>("attention");
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
  const visitEpochRef = useRef(0);
  const operationSeqRef = useRef(0);
  const isCurrentVisit = (id: string | null, epoch: number) => selectedIdRef.current === id && visitEpochRef.current === epoch;
  const pendingFocusRef = useRef<FocusBlock | null>(null);

  const headers = useCallback(
    () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" }),
    [token],
  );

  // Email-link login: /owner?ol=<token> exchanges the link for a 30-day
  // session, stored in localStorage. The token is stripped from
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
          try { localStorage.setItem("gh_owner_session", j.session); sessionStorage.removeItem("gh_owner_session"); } catch { /* storage unavailable */ }
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
      const j = (await r.json()) as { ok: boolean; visits?: Visit[]; error?: string; next_offset?: number | null };
      if (tokenRef.current !== token) return;
      if (!j.ok) {
        if (j.error === "unauthorized") {
          try { localStorage.removeItem("gh_owner_session"); sessionStorage.removeItem("gh_owner_session"); sessionStorage.removeItem("gh_admin_token"); } catch { /* storage unavailable */ }
          tokenRef.current = "";
          selectedIdRef.current = null;
          visitEpochRef.current++;
          setToken("");
          setSelected(null);
          setRoster([]);
          setRosterLoaded(false);
          linkSessionRef.current = null;
        }
        setError(j.error === "unauthorized" ? "Login expired or rejected — request a new login link or re-enter the admin token." : j.error === "db_not_configured" ? "Database isn't connected yet (SUPABASE env vars missing)." : "Couldn't load visits.");
        setVisits([]);
      } else {
        setVisits(j.visits ?? []);
        setNextOffset(j.next_offset ?? null);
      }
    } catch {
      if (tokenRef.current !== token) return;
      setError("Network error while loading visits.");
    }
    setLoading(false);
  }, [token, headers]);

  // A3: re-read ONLY the open visit's detail (status, report, photos,
  // events) — deliberately NOT openVisit: that resets the cleaner-edit
  // form (setCleanerEditing / setFormPhone / setFormPhoto), which would
  // clobber an edit in progress. A visibility refresh must be silent.
  const refreshSelected = useCallback(async () => {
    const visitId = selectedIdRef.current;
    if (!visitId || !token) return;
    const visitEpoch = visitEpochRef.current;
    try {
      const r = await fetch(`/api/owner?view=detail&visit_id=${visitId}`, { headers: headers() });
      const j = (await r.json()) as { ok: boolean; visit?: Visit; photos?: Photo[]; events?: GhEvent[] };
      if (!isCurrentVisit(visitId, visitEpoch)) return;
      if (j.ok && j.visit) {
        setSelected(j.visit);
        setPhotos(j.photos ?? []);
        setEvents(j.events ?? []);
      }
    } catch { /* silent: the Refresh button is still there */ }
  }, [token, headers]);

  // A3: same pattern as the cleaner cabinet — when the owner returns
  // to the tab, re-read the list and (when a card is open) its detail,
  // so a report the cleaner just submitted no longer needs a manual
  // Refresh. No polling: the refetch fires only on tab return.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      void loadList();
      void refreshSelected();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [loadList, refreshSelected]);

  const loadMore = async () => {
    if (nextOffset === null || loadingMore || !token) return;
    setLoadingMore(true);
    const session = token;
    try {
      const response = await fetch(`/api/owner?view=list&offset=${nextOffset}`, { headers: headers() });
      const data = await response.json();
      if (tokenRef.current !== session) return;
      if (!response.ok || !data.ok) throw new Error("list");
      setVisits((current) => { const ids = new Set(current.map((v) => v.id)); return [...current, ...(data.visits ?? []).filter((v: Visit) => !ids.has(v.id))]; });
      setNextOffset(data.next_offset ?? null);
    } catch { if (tokenRef.current === session) setError("Couldn't load more visits. Please try again."); }
    finally { setLoadingMore(false); }
  };

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const loadRoster = useCallback(async () => {
    if (!token) return;
    try {
      const r = await fetch("/api/owner?view=roster", { headers: headers() });
      const j = (await r.json()) as { ok: boolean; cleaners?: RosterCleaner[] };
      if (tokenRef.current !== token) return;
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
    if (!sameVisit) visitEpochRef.current++;
    const visitEpoch = visitEpochRef.current;
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
      setCardMethod("");
      setCardBrand("");
      setCardLast4("");
      setNoStripeCustomer(false);
      setActionMsg("");
      setTellCleaner(null);
      setViewLinkOpen(false);
      setViewLinkUrl("");
      setViewLinkError("");
      setCleanerCopyStatus("");
      setClientCopyStatus("");
      setManualCopy(null);
      setPublishMsg("");
      setReturnNote("");
      setIssueReason("");
      setScheduleEditing(false);
      setAltDate("");
      setAssignCleanerId("");
      setCleanerChanging(false);
      setChangeCleanerId("");
    }
    // Audit fix (§5): when the client proposed a date, confirming
    // defaults to the proposed date — the owner no longer re-types it
    // from the banner above (re-typing invited a wrong-date confirm).
    setConfirmDate(v.proposed_pending && v.proposed_date ? v.proposed_date : (v.visit_date ?? ""));
    setConfirmWindow(v.window ?? "");
    if (!rosterLoaded) void loadRoster();
    try {
      const r = await fetch(`/api/owner?view=detail&visit_id=${v.id}`, { headers: headers() });
      const j = (await r.json()) as { ok: boolean; visit?: Visit; photos?: Photo[]; events?: GhEvent[] };
      if (!isCurrentVisit(v.id, visitEpoch)) return;
      if (j.ok && j.visit) {
        setSelected(j.visit);
        setPhotos(j.photos ?? []);
        setEvents(j.events ?? []);
        setDecisionResolution("");
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
      const sj = (await sr.json()) as { ok: boolean; state?: string; error?: string; no_stripe_customer?: boolean; payment_method?: string; card_brand?: string; card_last4?: string };
      if (!isCurrentVisit(v.id, visitEpoch)) return;
      if (sj.ok && sj.state) {
        setStripeState(sj.state);
        // A2: the live card state rides on the same status response.
        setCardMethod(typeof sj.payment_method === "string" ? sj.payment_method : "");
        // C9: brand + last4 ride on the same status response; either
        // may be "" (no card / journal fallback) — the Payment block
        // shows the card line only when both are non-empty.
        setCardBrand(typeof sj.card_brand === "string" ? sj.card_brand : "");
        setCardLast4(typeof sj.card_last4 === "string" ? sj.card_last4 : "");
        setNoStripeCustomer(sj.no_stripe_customer === true);
      } else if (sj.error === "booking_not_found") {
        // B4: the booking exists in /owner but has no Stripe customer
        // (Kate) — the server now answers status from the visit row,
        // so reaching this branch means the row itself is gone; keep
        // the honest "no customer" line rather than stale state.
        setStripeState("");
        setCardMethod("");
        setCardBrand("");
        setCardLast4("");
        setNoStripeCustomer(true);
      }
    } catch {
      if (isCurrentVisit(v.id, visitEpoch)) setActionMsg("Couldn't load the visit details.");
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
  // onError, when given, gets the failed response first: returning true
  // means the handler took over (e.g. it asked the operator a follow-up
  // and re-issued the action) — runAction then skips its default message
  // and reload, which the follow-up run performs itself.
  const runAction = async (label: string, payload: Record<string, unknown>, after?: (j: Record<string, unknown>) => void, onError?: (j: Record<string, unknown>) => Promise<boolean> | boolean) => {
    const actionVisitId = selectedIdRef.current;
    const actionEpoch = visitEpochRef.current;
    const operation = ++operationSeqRef.current;
    setActing(label);
    setActionMsg(`${label}: working…`);
    try {
      const j = await act(payload);
      if (!isCurrentVisit(actionVisitId, actionEpoch)) { void loadList(); return; }
      if (j.ok) {
        setActionMsg(j.email_sent === false ? `${label}: saved, but the email could not be sent. You can retry the status email below.` : `${label}: done.`);
        after?.(j);
        void loadList();
        if (selected) {
          const fresh = visits.find((x) => x.id === selected.id);
          if (fresh) void openVisit(fresh);
        }
      } else {
        if (onError && (await onError(j))) return;
        setActionMsg(j["issue_blocked"] === true
          ? "Automatic charging is blocked for this visit, but the activity record could not be saved. No confirmation email was sent. Refresh the visit before retrying."
          : `${label}: ${j.error ?? "failed"}${j["report_status"] ? ` (report: ${String(j["report_status"])})` : ""}`);
        void loadList();
        if (selected) void openVisit(selected);
      }
    } catch {
      if (!isCurrentVisit(actionVisitId, actionEpoch)) return;
      setActionMsg(`${label}: couldn't reach the server — the action may or may not have run. Reloading the visit before you retry.`);
      void loadList();
      if (selected) {
        const fresh = visits.find((x) => x.id === selected.id);
        if (fresh) void openVisit(fresh);
      }
    } finally {
      if (operationSeqRef.current === operation) setActing("");
    }
  };

  // Delete a visit permanently (owner only). Unlike runAction, the
  // detail view is closed on success: the visit is gone, so there is
  // nothing to re-open — runAction's re-open would resurrect the stale
  // card from its pre-delete list snapshot.
  const deleteVisit = async (v: Visit) => {
    if (!window.confirm("Delete this visit permanently? This removes the visit, its activity record, its report photos and its entry arrangement. It does not touch Stripe — payments, customers and payouts stay as they are. This cannot be undone.")) return;
    const operation = ++operationSeqRef.current;
    setActing("Delete visit");
    setActionMsg("Delete visit: working…");
    try {
      const j = await act({ action: "delete_visit", booking_id: v.booking_id });
      if (j.ok) {
        selectedIdRef.current = null;
        visitEpochRef.current++;
        setSelected(null);
        setActionMsg(j["already_deleted"] === true
          ? "This visit was already deleted."
          : "Visit deleted.");
        void loadList();
      } else {
        setActionMsg(`Delete visit: ${j.error ?? "failed"}`);
        void loadList();
      }
    } catch {
      setActionMsg("Delete visit: couldn't reach the server — the visit may or may not have been deleted. Reloading the list before you retry.");
      void loadList();
    } finally {
      if (operationSeqRef.current === operation) setActing("");
    }
  };


  const ownerUpload = async (files: FileList | null) => {
    if (!selected || !files || files.length === 0) return;
    const uploadVisit = selected;
    const uploadEpoch = visitEpochRef.current;
    const operation = ++operationSeqRef.current;
    if (photoBlocked(selected.no_photo_zones, ownerRoom)) {
      setActionMsg("The client asked not to photograph this room. Add a skip reason instead.");
      return;
    }
    setActing("Owner upload");
    setActionMsg("Owner upload: working…");
    try {
      for (const f of Array.from(files)) {
        if (!isCurrentVisit(uploadVisit.id, uploadEpoch)) return;
        const blob = await convertToJpeg(f);
        if (!isCurrentVisit(uploadVisit.id, uploadEpoch)) return;
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
      if (isCurrentVisit(uploadVisit.id, uploadEpoch)) {
        setActionMsg("Owner upload: done.");
        void openVisit(uploadVisit);
      }
    } catch (err) {
      if (isCurrentVisit(uploadVisit.id, uploadEpoch)) setActionMsg(`Owner upload: ${err instanceof Error ? err.message : "failed"}`);
    } finally {
      if (operationSeqRef.current === operation) setActing("");
    }
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
    return cleanerJobMessage(selected, url);
  };

  // Message for the cleaner when the owner cancels or moves a visit.
  // A cancelled date is final; a proposed alternative is not confirmed
  // yet, so the message says so instead of promising the new date.
  const cleanerChangeMessage = (kind: "cancelled" | "date", date: string, altDate?: string): string => {
    const first = (selected?.cleaner_name ?? "").split(" ")[0] || "Hi";
    const when = fmtVisitDate(date) || "the scheduled date";
    if (kind === "cancelled") {
      return `Hi ${first}, the Gatehouse cleaning on ${when} has been cancelled — no need to travel. Sorry for the change, and thank you.`;
    }
    const alt = altDate ? ` We're offering the client ${fmtVisitDate(altDate)} instead.` : "";
    return `Hi ${first}, the Gatehouse cleaning on ${when} is being moved — please don't travel on that date.${alt} We'll confirm the new date with you.`;
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
    const epoch = visitEpochRef.current;
    const seq = linkSeqRef.current;
    let j: Awaited<ReturnType<typeof act>>;
    try { j = await act({ action: "get_cleaner_link", booking_id: selected.booking_id }); }
    catch { return { error: "failed" }; }
    if (!isCurrentVisit(selected.id, epoch) || linkSeqRef.current !== seq) return { error: "stale" };
    if (j.ok && typeof j["url"] === "string") return { url: j["url"] as string };
    const session = linkSessionRef.current;
    if (session && session.visitId === selected.id) return { url: session.url };
    return { error: typeof j.error === "string" ? j.error : "failed" };
  };

  const copyCleanerLink = async () => {
    const visitId = selectedIdRef.current;
    const epoch = visitEpochRef.current;
    setCleanerCopyStatus("");
    setManualCopy(null);
    const res = await loadCleanerLink();
    if (!isCurrentVisit(visitId, epoch) || ("error" in res && res.error === "stale")) return;
    if ("url" in res) {
      const copied = await copyText(res.url);
      if (!isCurrentVisit(visitId, epoch)) return;
      if (copied) {
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
    const visitId = selectedIdRef.current;
    const epoch = visitEpochRef.current;
    if (viewLinkOpen) {
      setViewLinkOpen(false);
      return;
    }
    setViewLinkError("");
    const res = await loadCleanerLink();
    if (!isCurrentVisit(visitId, epoch) || ("error" in res && res.error === "stale")) return;
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
    const visitId = selected.id;
    const epoch = visitEpochRef.current;
    setClientCopyStatus("");
    setManualCopy(null);
    let j: Awaited<ReturnType<typeof act>>;
    try { j = await act({ action: "client_link", booking_id: selected.booking_id }); }
    catch { if (isCurrentVisit(visitId, epoch)) setClientCopyStatus("Couldn’t load the client link — try again."); return; }
    if (!isCurrentVisit(visitId, epoch)) return;
    if (j.ok && typeof j["url"] === "string") {
      const url = j["url"] as string;
      const copied = await copyText(url);
      if (!isCurrentVisit(visitId, epoch)) return;
      if (copied) {
        // No persistent success notice: the copy control lives
        // in More actions, and the tap itself is the
        // confirmation. Failures still surface below.
        setClientCopyStatus("");
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
    const visitId = selected.id;
    const epoch = visitEpochRef.current;
    let j: Awaited<ReturnType<typeof act>>;
    try { j = await act({ action: "preview_link", booking_id: selected.booking_id }); }
    catch { if (isCurrentVisit(visitId, epoch)) setActionMsg("Couldn't load the client preview — try again."); return; }
    if (!isCurrentVisit(visitId, epoch)) return;
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
  const isAttention = (v: Visit): boolean => attentionItems(v).length > 0 || v.report_bounced || isPastUnfinishedVisit(v);
  const filterCounts: Record<OwnerFilter, number> = {
    attention: listedVisits.filter(isAttention).length,
    upcoming: listedVisits.filter((v) => v.status !== "cancelled" && v.status !== "paid" && !isPastUnfinishedVisit(v)).length,
    past: listedVisits.filter((v) => isPastUnfinishedVisit(v)).length,
    completed: listedVisits.filter((v) => v.status === "paid").length,
    cancelled: listedVisits.filter((v) => v.status === "cancelled").length,
    all: listedVisits.length,
  };
  const FILTERS: { key: OwnerFilter; label: string; empty: string }[] = [
    { key: "attention", label: "Needs attention", empty: "Nothing needs attention right now." },
    { key: "upcoming", label: "Upcoming", empty: "No upcoming visits." },
    { key: "past", label: "Past dates to review", empty: "No unfinished visits with past dates." },
    { key: "completed", label: "Completed", empty: "No completed visits yet." },
    { key: "cancelled", label: "Cancelled", empty: "No cancelled visits." },
    { key: "all", label: "All visits", empty: "No visits yet." },
  ];
  const filteredVisits = listedVisits.filter((v) => {
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      // N9: search covers client name, email, phone, address, booking id,
      // cleaner name and amount (formatted "$1.49" and raw cents "149").
      const hay = `${v.client_name ?? ""} ${v.client_email ?? ""} ${v.client_phone ?? ""} ${v.address ?? ""} ${v.booking_id ?? ""} ${v.cleaner_name ?? ""} ${money(v.amount_cents)} ${v.amount_cents ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (filter === "all") return true;
    if (filter === "cancelled") return v.status === "cancelled";
    if (filter === "completed") return v.status === "paid";
    if (filter === "past") return isPastUnfinishedVisit(v);
    if (filter === "upcoming") return v.status !== "cancelled" && v.status !== "paid" && !isPastUnfinishedVisit(v);
    return isAttention(v);
  });

  // TASK 1 (fix6): the open-issues queue — every visit with an open
  // dispute, newest first. Reads the list endpoint's batched fields.
  const openIssues = [...listedVisits]
    .filter((v) => v.issue_open)
    .sort((a, b) => String(b.issue_opened_at ?? "").localeCompare(String(a.issue_opened_at ?? "")));

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

                  <input
                    type="search"
                    className="w-full border border-border rounded-lg px-3 py-2 bg-background text-sm mb-3"
                    placeholder="Search by client, email, phone, cleaner, amount, address, or booking…"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    aria-label="Search visits"
                  />
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
          {openIssues.length > 0 && (
            <section className="mb-5 rounded-xl border border-red-200 bg-red-50 p-4" aria-label="Open issues">
              <h2 className="font-heading text-lg font-bold text-red-900">Open issues ({openIssues.length})</h2>
              <p className="text-sm text-red-900 mt-1">
                Automatic charging is blocked for these visits and never resumes on its own — the client must approve again to pay, or you waive the charge.
              </p>
              <ul className="mt-3 space-y-3">
                {openIssues.map((v) => (
                  <li key={v.id} className="rounded-lg border border-red-200 bg-card p-3">
                    <button type="button" className="w-full text-left" onClick={() => void openVisit(v)}>
                      <span className="font-semibold">{v.client_name ?? "—"}</span>
                      <span className="text-sm text-muted-foreground"> · {money(v.amount_cents)}</span>
                      <span className="block text-sm mt-1">
                        {v.issue_room ? `${v.issue_room}: ` : ""}{v.issue_reason || "no details given"}
                      </span>
                      <span className="block text-xs text-muted-foreground mt-1">
                        Opened {v.issue_opened_at ? new Date(v.issue_opened_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—"}
                        {timeAgo(v.issue_opened_at) ? ` · ${timeAgo(v.issue_opened_at)}` : ""}
                        {` · ${v.issue_decision ? (ISSUE_DECISION_LABEL[v.issue_decision.decision] ?? v.issue_decision.decision) : "Awaiting your decision"}`}
                        {v.photo_count ? ` · ${v.photo_count} photo${v.photo_count === 1 ? "" : "s"}` : ""}
                      </span>
                      {v.issue_decision?.resolution ? (
                        <span className="block text-sm mt-1">Your decision: {v.issue_decision.resolution}</span>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
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
                  <span className="text-sm text-muted-foreground">{fmtVisitDate(v.visit_date)} {v.window ? formatArrivalWindow(v.window) : ""} · {money(v.amount_cents)} {v.is_test && <span className="text-[10px] bg-amber-100 text-amber-900 px-1.5 py-0.5 rounded">test price</span>}</span>
                </div>
                <div className="text-sm font-medium mt-1">Next: {rowNextAction(v)}</div>
                <div className="flex flex-wrap gap-1.5 mt-2 text-[11px]">
                  <span className="bg-muted px-2 py-0.5 rounded">Visit: {visitBadgeLabel(v.status, v.report_status)}</span>
                  {v.cleaner_name
                    ? <span className="bg-sky-100 text-sky-900 px-2 py-0.5 rounded">cleaner: {v.cleaner_name}</span>
                    : <span className="bg-amber-100 text-amber-900 px-2 py-0.5 rounded">Needs a cleaner</span>}
                  {/* C3: card badge is the journal's view (see api/owner.ts) —
                      a detached card can still read "Card ready"; the live
                      Stripe state is in the detail view. Issue badge is exact:
                      it reads the row's issue_open flag. */}
                  {v.card_confirmed
                    ? <span className="bg-emerald-100 text-emerald-900 px-2 py-0.5 rounded">Card ready</span>
                    : <span className="bg-muted text-muted-foreground px-2 py-0.5 rounded">No card</span>}
                  {v.issue_open && <span className="bg-red-100 text-red-900 px-2 py-0.5 rounded">Issue open</span>}
                </div>
              </button>
            ))}
            {nextOffset !== null && <Button variant="outline" className="w-full mt-4" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? "Loading…" : "Load older visits"}</Button>}
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
          // TASK 1 (fix6): the latest owner decision on this issue,
          // from the journal — the detail panel renders its state
          // from this, and offers a re-notification for it.
          const latestDecision = (() => {
            const byTimeDesc = [...events].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
            const d = byTimeDesc.find((e) => e.event === "issue_decision");
            if (!d || typeof d.detail?.["decision"] !== "string") return null;
            return {
              decision: d.detail["decision"] as string,
              resolution: typeof d.detail?.["resolution"] === "string" ? (d.detail["resolution"] as string) : "",
              decided_at: d.created_at,
            };
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
          // C4: the 24h auto-charge deadline is report_sent_at + 24h —
          // shown only while a charge could still happen (report sent,
          // no open issue, not bounced, not terminal).
          const autoChargeAt = v.report_status === "sent" && v.report_sent_at && !v.issue_open && !v.report_bounced && v.status !== "paid" && v.status !== "cancelled"
            ? new Date(Date.parse(v.report_sent_at) + 24 * 3600 * 1000).toISOString()
            : null;
          // C5: UI hint for the cancel confirm — true only when the
          // visit is live and inside 48h. A past date is free (the
          // server decides the real fee either way).
          const cancelLate = (() => {
            if (!v.visit_date) return false;
            const noon = visitNoonETMs(v.visit_date);
            if (!Number.isFinite(noon)) return false;
            const delta = noon - Date.now();
            return delta > 0 && delta < 48 * 3600 * 1000;
          })();
          // Cancel gating — mirrors the server owner_cancel rule
          // exactly: the server refuses with 409 when the visit
          // is already cancelled/paid, or when the report was
          // already sent (report_status === "sent" or
          // report_sent_at set). A submitted (not yet sent)
          // report does NOT block a cancel.
          const canCancel = v.status !== "cancelled" && v.status !== "paid" && v.report_status !== "sent" && !v.report_sent_at;

          // Load the current link, then run fn with it; failures surface
          // in the cleaner status line (never a false "Copied").
          const withLink = async (fn: (url: string) => void) => {
            const epoch = visitEpochRef.current;
            const res = await loadCleanerLink();
            if (!isCurrentVisit(v.id, epoch) || ("error" in res && res.error === "stale")) return;
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
              <button type="button" className="text-sm underline text-muted-foreground mb-3" onClick={() => { scrolledIdRef.current = null; selectedIdRef.current = null; visitEpochRef.current++; setSelected(null); }}>
                ← Back to visits
              </button>
              {/* Action feedback lives here, at the top of the detail —
                  not only at the page bottom: on a phone the result of a
                  tap must be visible where the tap happened. */}
              {actionMsg && <p className="text-sm mb-3" role="status">{actionMsg}</p>}

              {/* Tell the cleaner — a cancelled or moved visit: the
                  cleaner only finds out by opening their link, so offer
                  the ready message here, reusing the share buttons. */}
              {tellCleaner && v.cleaner_name && (
                <div className="rounded-xl border border-amber-500/60 bg-amber-50 p-4 mb-3" role="status">
                  <p className="text-sm font-semibold mb-1">Tell the cleaner</p>
                  <p className="text-sm text-muted-foreground mb-2">
                    {tellCleaner.kind === "cancelled"
                      ? "The cleaner only finds out by opening their link. Send them this message so they don't travel for nothing."
                      : "The cleaner only finds out by opening their link. Send them this message so they don't travel on the old date."}
                  </p>
                  <textarea readOnly rows={3} className="w-full text-sm bg-background rounded p-2 mb-2" value={cleanerChangeMessage(tellCleaner.kind, tellCleaner.date, tellCleaner.altDate)} aria-label="Message for the cleaner" />
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" size="sm" onClick={() => openShare("wa", cleanerChangeMessage(tellCleaner.kind, tellCleaner.date, tellCleaner.altDate), phone)}>
                      WhatsApp
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => openShare("sms", cleanerChangeMessage(tellCleaner.kind, tellCleaner.date, tellCleaner.altDate), phone)}>
                      SMS
                    </Button>
                    <Button variant="outline" size="sm" onClick={async () => {
                      const copied = await copyText(cleanerChangeMessage(tellCleaner.kind, tellCleaner.date, tellCleaner.altDate));
                      if (copied) setCleanerCopyStatus("Cleaner message copied.");
                      else setManualCopy({ text: cleanerChangeMessage(tellCleaner.kind, tellCleaner.date, tellCleaner.altDate), label: "Message — copy it manually:", owner: "cleaner" });
                    }}>
                      Copy message
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setTellCleaner(null)}>
                      Dismiss
                    </Button>
                  </div>
                  {cleanerCopyStatus && <p className="text-sm mt-1" role="status">{cleanerCopyStatus}</p>}
                </div>
              )}

              {/* A. Summary */}
              <section id="block-summary" className="rounded-xl border border-border bg-card p-4 mb-4 scroll-mt-28">
                <h2 id="owner-detail-title" tabIndex={-1} className="font-heading text-2xl font-bold outline-none">{v.client_name ?? "—"}</h2>
                <p className="text-sm text-muted-foreground">
                  {v.service ?? ""} · {fmtVisitDate(v.visit_date)} {v.window ? formatArrivalWindow(v.window) : ""} · {money(v.amount_cents)}
                </p>
                <p className="text-sm">{v.address ?? ""}</p>
                {v.access_notes && <p className="text-sm">Access: {v.access_notes}</p>}
                <p className="text-sm">
                  Visit: <strong>{visitBadgeLabel(v.status, v.report_status)}</strong> · Report: <strong>{reportLabel(v.report_status)}</strong>
                  {stripeState && <> · Payment: <strong>{stripeLabel(stripeState)}</strong></>}
                  {noStripeCustomer && <> · <span className="text-destructive font-semibold">No Stripe customer</span></>}
                  {v.issue_open && <> · <span className="text-destructive font-semibold">Issue open</span></>}
                </p>
                <p className="text-sm font-medium mt-1">Next: {nextAction}</p>
                {/* B4: an explicit readiness checklist — the card must
                    not look ready when the cleaner, the confirmation,
                    the card, the entry, or the phone is missing. */}
                <div className="mt-3 rounded-lg border border-border p-3">
                  <p className="text-sm font-semibold mb-1">Ready for the visit</p>
                  <ul className="text-sm space-y-0.5">
                    <li>Cleaner: {v.cleaner_name ?? "not assigned"}</li>
                    <li>Visit confirmed: {v.visit_confirmed ? "yes" : "not yet"}</li>
                    {/* A2: the "Card:" line reads the CARD state, not the
                        payment lifecycle. The live state (cardMethod)
                        comes from the status action ("saved"/"none");
                        while it has not loaded, fall back to the
                        journal signal v.card_confirmed, which the list
                        view already uses for its "Card ready" chip.
                        The payment lifecycle ("Requested"/"Paid") lives
                        in the "Payment:" line above, not here. */}
                    <li>Card: {noStripeCustomer ? "no Stripe customer — no card can be charged" : cardMethod === "saved" ? (cardBrand && cardLast4 ? `${cardBrand} •••• ${cardLast4}` : "Card ready") : cardMethod === "none" ? "not saved yet" : v.card_confirmed ? "Card ready" : "not saved yet"}</li>
                    <li>
                      Entry: {entryStatusText(v)}
                      {v.entry_agreed ? " · settled" : ""}
                      {v.entry?.has_secret ? " · private entry details saved" : ""}
                    </li>
                    {(v.entry_choice?.notes ?? v.entry_notes) && (
                      <li>Parking/building notes: {v.entry_choice?.notes ?? v.entry_notes}</li>
                    )}
                    {v.entry?.reminder_sent && <li>Entry reminder sent.</li>}
                    {/* A1: the client phone lives ONLY in the compact
                        ClientContact line below (formatted, with Call /
                        Text / Copy) — the raw "+17705258599" line here
                        duplicated it. When there is no phone, the
                        compact line says so ("not available"). */}
                  </ul>
                  {entryNeedsAttention(v) && (
                    <p className="text-sm font-semibold rounded-lg bg-amber-50 border border-amber-500/60 p-3 mt-2" role="status">Action needed before dispatch: entry is not settled. Contact the client — do not send the cleaner to an unsettled entry.</p>
                  )}
                </div>
                {v.issue_open && (
                  <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3">
                    {openIssue && (
                      <p className="text-sm w-full">
                        Issue{typeof openIssue.detail?.room === "string" && openIssue.detail.room ? ` · ${openIssue.detail.room}` : ""}: {typeof openIssue.detail?.reason === "string" && openIssue.detail.reason ? openIssue.detail.reason : "no details given"}
                      </p>
                    )}
                    {latestDecision && (
                      <p className="text-sm mt-1">
                        Latest decision: <strong>{ISSUE_DECISION_LABEL[latestDecision.decision] ?? latestDecision.decision}</strong>
                        {latestDecision.resolution ? ` — ${latestDecision.resolution}` : ""}
                      </p>
                    )}
                    <label htmlFor="issue-decision-text" className="block text-sm font-medium mt-3 mb-1">Your decision for the client *</label>
                    <textarea
                      id="issue-decision-text"
                      value={decisionResolution}
                      onChange={(e) => setDecisionResolution(e.target.value)}
                      rows={2}
                      maxLength={1000}
                      placeholder="e.g. The original amount stays due — the kitchen was cleaned twice. / We'll come back Tuesday to re-clean the bathroom."
                      className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                    />
                    <p className="text-xs text-muted-foreground mt-1">The client reads this as “Our response”. Request payment does not charge the card — the client approves the report to pay.</p>
                    <div className="flex flex-wrap gap-2 mt-3">
                      <Button
                        variant="hero"
                        size="sm"
                        disabled={acting !== "" || !decisionResolution.trim()}
                        onClick={() => {
                          if (!window.confirm(`Ask the client to approve and pay ${money(v.amount_cents)}? Nothing is charged now — the client approves the report to pay.`)) return;
                          void runAction("Request payment", { action: "issue_request_payment", booking_id: v.booking_id, resolution: decisionResolution }, () => setDecisionResolution(""));
                        }}
                      >
                        Request payment
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={acting !== "" || !decisionResolution.trim()}
                        onClick={() => {
                          void runAction("Arrange re-clean", { action: "issue_arrange_reclean", booking_id: v.booking_id, resolution: decisionResolution }, () => setDecisionResolution(""));
                        }}
                      >
                        Arrange re-clean
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={acting !== ""}
                        onClick={() => {
                          if (!window.confirm("Waive the charge for this visit? The visit closes without payment and can never be charged.")) return;
                          void runAction("Waive charge", { action: "issue_waive_charge", booking_id: v.booking_id, resolution: decisionResolution }, () => setDecisionResolution(""));
                        }}
                      >
                        Waive charge
                      </Button>
                      {latestDecision && (latestDecision.decision === "payment_requested" || latestDecision.decision === "reclean") && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={acting !== ""}
                          onClick={() => {
                            void runAction("Send reminder", { action: "issue_renotify", booking_id: v.booking_id });
                          }}
                        >
                          Send reminder
                        </Button>
                      )}
                    </div>
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-2 mt-2">
                  <a className="text-base underline break-all" href={`mailto:${v.client_email ?? ""}`}>{v.client_email ?? ""}</a>
                </div>
                <div className="mt-4"><ClientContact key={`${v.id}:${v.client_phone ?? ""}`} phone={v.client_phone} compact /></div>
                {/* C: "Update client phone" lives in "More actions"
                    below, not as a standalone disclosure on the card. */}
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
                {/* Card-level More actions — the rarely-used
                    controls live here so the card leads with the
                    next step: copy the client link, open an issue
                    from email, cancel, and delete the visit. The
                    Payment section's own "More actions" below is
                    unchanged. */}
                <details className="mt-3">
                  <summary className="text-sm underline text-muted-foreground cursor-pointer">More actions</summary>
                  <div className="mt-3 space-y-3">
                    <div>
                      <Button variant="outline" size="sm" onClick={() => void copyClientLink()}>
                        Copy client link (visit + payment)
                      </Button>
                      {clientCopyStatus && <p className="text-sm mt-1" role="status">{clientCopyStatus}</p>}
                      {manualCopy?.owner === "client" && (
                        <div className="mt-1">
                          <p className="text-xs text-muted-foreground">{manualCopy.label}</p>
                          <input readOnly className="w-full text-xs bg-muted rounded p-2 mt-1" value={manualCopy.text} onFocus={(e) => e.target.select()} aria-label="Client link (select and copy if the button does not work)" />
                        </div>
                      )}
                    </div>
                {/* N7: also before any report is sent — a client who
                    emails "don't come" while the visit is still
                    requested/confirmed needs a recorded issue too, or
                    the future automatic charge has nothing blocking it. */}
                {!v.issue_open && v.status !== "paid" && v.status !== "cancelled" && (v.report_status === "sent" || v.report_status === "submitted" || v.status === "requested" || v.status === "confirmed") && (
                  <div className="mt-3">
                    <div className="flex flex-wrap gap-2">
                      <input type="text" className="border border-border rounded-lg px-3 py-2 bg-background text-sm flex-1 min-w-52" placeholder="What did the client report by email? (optional)" value={issueReason} onChange={(e) => setIssueReason(e.target.value)} aria-label="Issue reported by email" />
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={acting !== ""}
                        onClick={() => {
                          if (!window.confirm((v.report_status === "sent" || v.report_status === "submitted")
                            ? "Open an issue for this visit? Automatic charging stops at once for this visit and never resumes on its own, and the client gets a confirmation email."
                            : "Open an issue for this visit? It blocks any future automatic charge for this visit — including after the report is sent — and never resumes on its own, and the client gets a confirmation email.")) return;
                          void runAction("Open issue from email", { action: "dispute", booking_id: v.booking_id, reason: issueReason }, (j) => {
                            setIssueReason("");
                            setActionMsg(j["already_open"] === true
                              ? "Issue was already open — nothing changed, no second email sent."
                              : j["email_sent"] === true
                                ? "Issue opened — automatic charging is blocked for this visit. The confirmation email was accepted for sending; delivery is not yet confirmed."
                                : "Issue opened — automatic charging is blocked for this visit, but the confirmation email could not be sent — contact the client manually.");
                          });
                        }}
                      >
                        Open issue from email
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">{(v.report_status === "sent" || v.report_status === "submitted")
                      ? "Use this when the client reported a problem by email instead of the report page. It blocks automatic charging at once — an email sitting in the inbox alone does not."
                      : "Use this when the client reported a problem by email before the report is sent. It blocks any future automatic charge for this visit — an email sitting in the inbox alone does not."}</p>
                  </div>
                )}
                {/* C5: owner cancel — the server refuses it once the
                    report is sent, and computes the $25 late fee. */}
                {canCancel && (
                  <div className="mt-3">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={acting !== ""}
                      onClick={() => {
                        if (!window.confirm(cancelLate
                          ? "Cancel this visit? The visit is within 48 hours, so the $25 late-cancellation fee from the Terms applies and will be charged to the saved card. This cannot be undone."
                          : "Cancel this visit? No fee — the visit is more than 48 hours away. This cannot be undone.")) return;
                        void runAction("Cancel visit", { action: "owner_cancel", booking_id: v.booking_id }, (j) => {
                          const fee = typeof j["fee_cents"] === "number" ? (j["fee_cents"] as number) : null;
                          setActionMsg(fee !== null && fee > 0
                            ? `Visit cancelled. Late-cancellation fee: $${(fee / 100).toFixed(2)} — recorded on the booking.${j["email_sent"] === true ? " The client was emailed." : " The client email could not be sent — contact the client manually."}`
                            : `Visit cancelled. No fee.${j["email_sent"] === true ? " The client was emailed." : " The client email could not be sent — contact the client manually."}`);
                          if (v.cleaner_name) setTellCleaner({ kind: "cancelled", date: v.visit_date ?? "" });
                        });
                      }}
                    >
                      Cancel visit
                    </Button>
                  </div>
                )}
                {/* Delete — every visit, any status: the server removes
                    the row, journal, photos and entry arrangement, and
                    never touches Stripe. */}
                <div className="mt-3">
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={acting !== ""}
                    onClick={() => void deleteVisit(v)}
                  >
                    Delete visit
                  </Button>
                  <p className="text-xs text-muted-foreground mt-1">Deletes the visit, its activity record, report photos and entry arrangement. Payments and Stripe records stay as they are. This cannot be undone.</p>
                </div>
                {/* C: client phone — moved here from its own standalone
                    disclosure on the card, so the card leads with the
                    next step and this rarely-used edit stays quiet. */}
                <details className="mt-3" key={`contact:${v.id}:${v.client_phone ?? ""}`}>
                  <summary className="text-sm underline text-muted-foreground cursor-pointer">{v.client_phone ? "Update client phone" : "Add client phone"}</summary>
                  <form className="flex flex-wrap gap-2 mt-2" onSubmit={(e) => {
                    e.preventDefault();
                    const phone = new FormData(e.currentTarget).get("client_phone");
                    void runAction("Save client phone", { action: "set_client_phone", booking_id: v.booking_id, client_phone: String(phone ?? "") });
                  }}>
                    <input name="client_phone" type="tel" required maxLength={50} aria-label="Client phone" defaultValue={v.client_phone ?? ""} placeholder="10-digit US phone number" className="min-h-[44px] rounded-lg border border-border bg-background px-3 text-base" />
                    <Button type="submit" variant="outline" disabled={acting !== ""}>Save phone</Button>
                  </form>
                </details>
                {/* C: next-visit invitation — moved here from its own
                    prominent block on the paid card. The visit data
                    carries no frequency, so the panel cannot tell a
                    one-time visit from a recurring one; the invitation
                    stays available here for the owner to send when a
                    next visit is actually wanted, instead of sitting
                    on every paid card. */}
                {v.status === "paid" && (
                  <div className="mt-3">
                    <Button variant="outline" size="sm" disabled={!!acting} onClick={() => void runAction("Invite next visit", { action: "invite_next_visit", booking_id: v.booking_id })}>Email next-visit invitation</Button>
                    <p className="text-xs text-muted-foreground mt-1">Invites the client to review the current price and request their next date.</p>
                  </div>
                )}
                  </div>
                </details>
              </section>

              {/* B. Cleaner — assignment and link in one block. Hidden
                  when no cleaner is assigned yet: the Schedule block
                  below already shows the cleaner state and the
                  dropdown, so there is nothing to show here. */}
              {(isTerminal || assigned || cleanerChanging) && (
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
                    {/* N11: an expired link after a submitted report
                        needs no action — say so instead of a bare
                        "Access expired". */}
                    {linkIssued && !linkActive && <p className="text-sm mb-2">{(v.report_status === "sent" || v.report_status === "submitted") ? "Access expired — the report is already submitted, no action needed." : "Access expired."}</p>}
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
                        </div>
                        {/* C: one set of WhatsApp/SMS only — next to the
                            message field inside "View link & message"
                            below. The second set that sat here next to
                            the copy button duplicated it. */}
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
                                  const epoch = visitEpochRef.current;
                                  const message = cleanerMessage(viewLinkUrl);
                                  const copied = await copyText(message);
                                  if (!isCurrentVisit(v.id, epoch)) return;
                                  if (copied) setCleanerCopyStatus("Cleaner message copied.");
                                  else { setManualCopy({ text: message, label: "Message — copy it manually:", owner: "cleaner" }); setCleanerCopyStatus("Copy failed — copy the message manually below."); }
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
              )}

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
                      <p className="text-sm">Confirmed: {fmtVisitDate(v.visit_date)}{v.window ? ` · ${formatArrivalWindow(v.window)}` : ""}</p>
                      <Button variant="outline" size="sm" onClick={() => { setConfirmDate(v.proposed_pending && v.proposed_date ? v.proposed_date : (v.visit_date ?? "")); setConfirmWindow(v.window ?? ""); setScheduleEditing(true); }}>
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
                            : "Propose another time: saved, but the email could not be sent — contact the client manually.");
                          if (v.cleaner_name) setTellCleaner({ kind: "date", date: v.visit_date ?? "", altDate: altDate || undefined });
                        })}>
                          Propose another time
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">Proposing emails the client an alternative date — a proposal is not a confirmation.</p>
                    </details>
                    <div className="flex flex-wrap gap-2 mt-3">
                      <Button variant="outline" size="sm" onClick={() => void previewClientView()}>Preview client view (view only)</Button>
                    </div>
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
                              onClick={() => {
                                // B5: deleting a report photo is
                                // irreversible — it is evidence for the
                                // report — so it needs a confirm.
                                if (!window.confirm("Delete this report photo? This cannot be undone.")) return;
                                void runAction("Delete photo", { action: "owner_photo_delete", booking_id: v.booking_id, photo_id: ph.id });
                              }}
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
                                : "Published and saved, but the customer email could not be sent — the review period is paused. Check the report email status and publish again to retry.",
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
                    {v.no_photo_zones && <p className="text-sm text-destructive mb-2">Do not photograph: {v.no_photo_zones}</p>}
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
                          disabled={acting !== "" || photoBlocked(v.no_photo_zones, ownerRoom)}
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
                  {v.paid_at
                    ? ` · Paid ${fmtDateET(v.paid_at)}`
                    : noStripeCustomer
                      ? " · No Stripe customer — no card can be charged"
                      : stripeState
                        ? ` · ${stripeLabel(stripeState)}`
                        : " · Not paid yet"}
                </p>
                {/* C9: the saved card, from the status action — shown
                    only when both brand and last4 are known; otherwise
                    the line above (state / no-customer) stands alone. */}
                {cardBrand && cardLast4 && (
                  <p className="text-sm mt-1">
                    Card: {cardBrand.charAt(0).toUpperCase() + cardBrand.slice(1)} •••• {cardLast4}
                  </p>
                )}
                {/* C4: the 24h auto-charge deadline, from the report
                    send time — and "window passed" once it is gone. */}
                {autoChargeAt && (
                  <p className="text-sm mt-1">
                    {Date.parse(autoChargeAt) > Date.now()
                      ? <>Auto-charge at {fmtDateTimeET(autoChargeAt)} if the client stays silent — an open issue blocks it.</>
                      : "Auto-charge window passed."}
                  </p>
                )}
                {paymentFailed && (
                  <p className="text-sm text-destructive mt-1">
                    Payment failed — check the saved card, then retry from the customer’s report page or charge again below.
                  </p>
                )}
                <details className="mt-2">
                  <summary className="text-sm underline text-muted-foreground cursor-pointer">More actions</summary>
                  <Button variant="outline" size="sm" className="mt-3 mr-2" disabled={!!acting} onClick={() => void runAction("Send status email", { action: "resend_status_email", booking_id: v.booking_id })}>Resend status email</Button>
                  <Button variant="outline" size="sm" className="mt-3" disabled={!!acting} onClick={() => {
                    // B5: flipping the test flag hides/shows the
                    // booking in every filter — a fat-finger tap must
                    // not do it silently.
                    if (!window.confirm(v.is_test ? "Mark as a real booking? It will show in the normal visit list." : "Mark as a test booking? It will be hidden by the “Hide test bookings” filter.")) return;
                    void runAction("Update test flag", { action: "set_test_booking", booking_id: v.booking_id, is_test: !v.is_test });
                  }}>{v.is_test ? "Mark as real booking" : "Mark as test booking"}</Button>
                  {/* C6: detach the saved card — the existing
                      delete_card action, now reachable from the panel.
                      The result (including a Stripe error) is shown
                      by runAction, never swallowed. */}
                  {!noStripeCustomer && stripeState === "card_ready" && (
                    <Button variant="outline" size="sm" className="mt-3 ml-2" disabled={!!acting} onClick={() => {
                      if (!window.confirm("Detach the saved card for this booking? The client will need to save a new card before any charge.")) return;
                      void runAction("Detach card", { action: "delete_card", booking_id: v.booking_id }, (j) => {
                        if (j["card_deleted"] === true) { setStripeState(""); setCardBrand(""); setCardLast4(""); }
                      });
                    }}>Detach card</Button>
                  )}

                  <div className="mt-2">
                    <Button
                      variant="outline"
                      disabled={v.can_charge === false}
                      onClick={() => {
                        // B5: Charge is a real charge — one click must
                        // never fire it. Amount + client name in the
                        // confirm, like the other dangerous actions.
                        if (!window.confirm(`Charge ${money(v.amount_cents)} to ${v.client_name ?? "this client"} now? This charges the saved card right away.`)) return;
                        void runAction("Charge", { action: "charge", booking_id: v.booking_id, amount_cents: v.amount_cents ?? undefined }, undefined, async (j) => {
                          // C16: the server refuses a timer-basis charge
                          // with no delivered reminder (409
                          // needs_reminder_confirm) until the operator
                          // confirms — with the server's own hint text.
                          if (j.error !== "needs_reminder_confirm") return false;
                          const hint = typeof j.hint === "string" && j.hint ? j.hint : "No reminder was sent for this report yet. Confirm to charge without a reminder.";
                          if (!window.confirm(`${hint} Charge anyway?`)) return false;
                          void runAction("Charge", { action: "charge", booking_id: v.booking_id, amount_cents: v.amount_cents ?? undefined, confirm_no_reminder: true });
                          return true;
                        });
                      }}
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

              {/* C: the "Before dispatch" hint is gone as a separate
                  line — its content already sits in the cleaner-link
                  section ("Opens WhatsApp or SMS … Opening the link
                  doesn't mean the cleaner accepted the job."). */}
              {/* C: the "Next visit" block is gone from the paid card —
                  it now lives in "More actions" above, so the invitation
                  is still one tap away when a next visit is actually
                  wanted, instead of sitting on every paid card. */}
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
