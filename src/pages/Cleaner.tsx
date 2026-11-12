import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Helmet } from "react-helmet-async";
import { Camera, CheckCircle, AlertTriangle, Loader2, Trash2, ImagePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { convertToJpeg } from "@/lib/imageConvert";
import { ReportChecklistView } from "@/components/ReportContent";
import { createAutosaveQueue, type AutosaveState } from "@/lib/autosaveQueue";
import ClientContact from "@/components/ClientContact";
import { photoBlocked } from "@/lib/photoPolicy";

type ChecklistItem = { label: string; done: boolean };
type ChecklistRoom = { name: string; items: ChecklistItem[]; skip_reason?: string };
type Checklist = { rooms: ChecklistRoom[]; problem_note?: string; submitted_at?: string };

type Photo = {
  id: string;
  room: string;
  kind: string;
  note: string | null;
  created_at: string;
  url: string | null;
};

type CleanerView = {
  ok: boolean;
  visit: {
    service: string | null;
    date: string | null;
    window: string | null;
    address: string | null;
    access_notes: string | null;
    entry?: { method: string | null; note: string; secret: string | null } | null;
    entry_choice?: { method: string | null; detail: string | null; notes: string | null } | null;
    client_notes?: string | null;
    no_photo_zones: string | null;
    // A4: the full client name — the header must show the whole name,
    // not just the first word. client_first_name stays for compat.
    client_name?: string | null;
    client_first_name: string;
    client_phone?: string | null;
  };
  checklist: Checklist;
  photos: Photo[];
  report_status: string;
  report_bounced?: boolean;
  report_held?: boolean;
  editable: boolean;
  confirmed: boolean;
  cancelled?: boolean;
  owner_note: string | null;
  // A re-clean the owner agreed (date + the decision text), and the
  // client's original complaint (room + text + source) — null when
  // no re-clean was agreed / no issue was filed.
  reclean?: { date: string; note: string } | null;
  client_issue?: { reason: string; room: string; source: string } | null;
  error?: string;
};

type UploadState = {
  room: string;
  kind: "before" | "after";
  label: string;
  status: "working" | "error";
  error?: string;
  file?: File;
};

// A room is photo-complete only when it has a before photo AND an after
// photo. A set skip_reason excuses the whole room, and so does the
// client's do-not-photograph list for that room. The server enforces
// the same rule (api/cleaner.ts missingRooms); the client blocks in
// submit() too, so the cleaner sees which photo is missing.
type RoomPhotoStatus = { beforeOk: boolean; afterOk: boolean; ready: boolean };
const roomPhotoStatus = (room: ChecklistRoom, photos: Photo[], noPhotoHere: boolean): RoomPhotoStatus => {
  const excused = Boolean(room.skip_reason) || noPhotoHere;
  const beforeOk = excused || photos.some((p) => p.room === room.name && p.kind === "before");
  const afterOk = excused || photos.some((p) => p.room === room.name && p.kind === "after");
  return { beforeOk, afterOk, ready: beforeOk && afterOk };
};


const Cleaner = () => {
  const [searchParams] = useSearchParams();
  const ct = searchParams.get("ct") ?? "";
  const [data, setData] = useState<CleanerView | null>(null);
  const [error, setError] = useState("");
  const [openRoom, setOpenRoom] = useState<string | null | undefined>(undefined);
  const [checklist, setChecklist] = useState<Checklist>({ rooms: [] });
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [uploads, setUploads] = useState<Record<string, UploadState>>({});
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [missing, setMissing] = useState<string[]>([]);
  // K06: visible autosave status — "Saved" only after the server confirms.
  const [saveState, setSaveState] = useState<AutosaveState>("idle");
  // Last successful refresh (Atlanta time) — the page refetches when
  // the tab becomes visible again, so a stale entry/date never sits
  // unnoticed.
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  // Whether a load has ever succeeded. A refetch that fails on the
  // network must not wipe a loaded page (see load()).
  const dataLoaded = useRef(false);

  const post = useCallback(
    async (payload: Record<string, unknown>) => {
      const r = await fetch("/api/cleaner", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ct, ...payload }),
      });
      return (await r.json()) as Record<string, unknown> & { ok: boolean; error?: string };
    },
    [ct],
  );
  const saver = useMemo(() => createAutosaveQueue<Checklist>(
    async (next) => (await post({ action: "checklist", checklist: next })).ok,
    setSaveState,
  ), [post]);
  useEffect(() => { saver.activate(); return () => saver.dispose(); }, [saver]);

  const load = useCallback(async () => {
    const startedAtRevision = saver.revision();
    try {
      // C1: preserve the owner/QA preview flag (?pv=1) on every load, so a
      // preview reload never creates a cleaner_link_opened event.
      const pv = searchParams.get("pv");
      const qs = `ct=${encodeURIComponent(ct)}${pv === "1" ? "&pv=1" : ""}`;
      const r = await fetch(`/api/cleaner?${qs}`);
      const j = (await r.json()) as CleanerView;
      if (!j.ok) {
        const err = j.error ?? "load_failed";
        // A refetch that fails must not wipe a loaded page: the cleaner
        // keeps working on the data they have (the "Updated …" stamp
        // shows it is stale). Only a dead link or a broken setup
        // replaces the form with the error page — and only those, never
        // a transient load failure, which used to show the misleading
        // "This link doesn't work" for a mere network hiccup.
        if (!dataLoaded.current || err === "link_expired" || err === "invalid_link" || err === "db_not_configured") {
          setError(err);
        }
        return;
      }
      dataLoaded.current = true;
      setData(j);
      setLastUpdated(new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }));
      // Photo uploads refresh the page data too. A response started before
      // an edit must not replace the cleaner's newer local checklist.
      if (!saver.isDirty() && saver.revision() === startedAtRevision) {
        setChecklist(j.checklist ?? { rooms: [] });
      }
      // The server list replaces any optimistically shown photo (same id,
      // signed URL) — free its local preview URL now.
      for (const u of optimisticBlobUrls.current) URL.revokeObjectURL(u);
      optimisticBlobUrls.current.clear();
      setPhotos(j.photos ?? []);
    } catch {
      // Same as above: a failed refetch never wipes a loaded page.
      if (!dataLoaded.current) setError("load_failed");
    }
  }, [ct, searchParams, saver]);

  useEffect(() => {
    void load();
  }, [load]);

  // An already-open cleaner page must pick up the client's entry change
  // or the owner's date change without a manual reload — same refetch
  // on return as the client page. No polling, one fetch on return.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [load]);

  const saveChecklist = useCallback(
    (next: Checklist) => {
      setChecklist(next);
      saver.schedule(next);
    },
    [saver],
  );

  const retrySave = () => { void saver.flush(); };

  const seenFiles = useRef<Set<string>>(new Set());
  // Blob URLs of optimistically shown photos (a photo whose register
  // succeeded but whose refetch has not landed yet). Revoked as soon as
  // the server list replaces them, so they never leak past the session.
  const optimisticBlobUrls = useRef<Set<string>>(new Set());

  const uploadPhoto = async (room: string, kind: "after" | "before", file: File) => {
    if (photoBlocked(data?.visit.no_photo_zones, room)) return;
    const tempId = `up-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const signature = `${room}|${kind}|${file.name}|${file.size}|${file.lastModified}`;
    if (seenFiles.current.has(signature)) {
      setUploads((u) => ({
        ...u,
        [tempId]: {
          room, kind, label: file.name || "photo", status: "error",
          error: "This looks like the same photo you already added for this room — skipped to avoid a duplicate.",
        },
      }));
      return;
    }
    setUploads((u) => ({ ...u, [tempId]: { room, kind, label: file.name || "photo", status: "working", file } }));
    try {
      const blob = await convertToJpeg(file);
      const sign = await post({ action: "photo_sign", room, kind });
      if (sign.error === "photo_not_allowed") throw new Error("The client asked for no photos in this room. Use the reason field instead.");
      if (!sign.ok || typeof sign["upload_url"] !== "string" || typeof sign["storage_path"] !== "string") {
        throw new Error("Couldn't start the upload. Check your connection and retry.");
      }
      const put = await fetch(sign["upload_url"] as string, {
        method: "PUT",
        headers: { "Content-Type": "image/jpeg", "x-upsert": "false" },
        body: blob,
      });
      if (!put.ok) throw new Error("The upload failed. Check your connection and retry.");
      const reg = await post({
        action: "photo_register",
        room,
        kind,
        storage_path: sign["storage_path"],
      });
      if (!reg.ok) {
        if (reg.error === "photo_not_allowed") throw new Error("The client asked for no photos in this room. Use the reason field instead.");
        if (reg.error === "invalid_photo_file") {
          throw new Error("That file isn't a usable photo (JPG/PNG/HEIC, up to 15 MB). Please pick another one.");
        }
        throw new Error("The photo uploaded but couldn't be saved. Please retry.");
      }
      seenFiles.current.add(signature);
      // Optimistic: show the photo at once, with the real id from the
      // register response, so the room reads as photo-complete even if
      // the refetch below fails (flaky connection). Without this, a
      // successful upload followed by a failed refetch leaves the page
      // showing "no photo" while a re-upload hits the duplicate guard —
      // a dead end for the cleaner. The refetch replaces this entry
      // with the server row (same id, signed URL) when it lands.
      const photoId = typeof reg["photo_id"] === "string" ? (reg["photo_id"] as string) : null;
      if (photoId) {
        // createObjectURL is universal in browsers; guard it so a
        // non-browser runtime (tests) never turns a saved photo into
        // an error — the refetch below is the fallback there.
        try {
          const previewUrl = URL.createObjectURL(blob);
          optimisticBlobUrls.current.add(previewUrl);
          setPhotos((prev) => {
            if (prev.some((p) => p.id === photoId)) return prev;
            return [...prev, { id: photoId, room, kind, note: null, created_at: new Date().toISOString(), url: previewUrl }];
          });
        } catch {
          // No local preview available; the refetch below still shows it.
        }
      }
      await load();
    } catch (err) {
      setUploads((u) => ({
        ...u,
        [tempId]: {
          room, kind, file,
          label: file.name || "photo",
          status: "error",
          error: err instanceof Error ? err.message : "Upload failed. Please retry.",
        },
      }));
      return;
    }
    setUploads((u) => {
      const next = { ...u };
      delete next[tempId];
      return next;
    });
  };

  const retryUpload = (tempId: string) => {
    const u = uploads[tempId];
    if (!u?.file) return;
    setUploads((prev) => {
      const next = { ...prev };
      delete next[tempId];
      return next;
    });
    void uploadPhoto(u.room, u.kind, u.file);
  };
  const dismissUpload = (tempId: string) =>
    setUploads((prev) => {
      const next = { ...prev };
      delete next[tempId];
      return next;
    });

  const deletePhoto = async (photo: Photo) => {
    const r = await post({ action: "photo_delete", photo_id: photo.id });
    if (r.ok) {
      if (photo.url && photo.url.startsWith("blob:")) {
        URL.revokeObjectURL(photo.url);
        optimisticBlobUrls.current.delete(photo.url);
      }
      setPhotos((list) => list.filter((p) => p.id !== photo.id));
    }
  };

  const submit = async () => {
    // C3: never submit while a photo is still uploading — a photo_register
    // landing after submit would hit report_locked and be lost from the
    // published report.
    if (Object.values(uploads).some((u) => u.status === "working")) {
      setSubmitError("Photos are still uploading — please wait until they finish, then press Finish again.");
      return;
    }
    // Client-side before-photo gate: a room is ready only when it has a
    // before photo (or a reason / no-photo zone) AND an after photo
    // (or a reason / no-photo zone). Block here so the cleaner sees
    // which photo is missing instead of sending a report with no
    // before/after comparison. The server enforces the same rule and
    // stays the backstop.
    const statuses = checklist.rooms.map((r) => ({
      name: r.name,
      ...roomPhotoStatus(r, photos, photoBlocked(data?.visit.no_photo_zones ?? null, r.name)),
    }));
    const notReady = statuses.filter((s) => !s.ready);
    if (notReady.length > 0) {
      setMissing(notReady.map((s) => s.name));
      setSubmitError(
        notReady.some((s) => !s.beforeOk)
          ? "Some rooms still need a before photo (or a reason they were skipped):"
          : "Some rooms still need an after photo (or a reason they were skipped):",
      );
      return;
    }
    setBusy(true);
    setSubmitError("");
    setMissing([]);
    try {
      // Flush the debounced checklist save first, so the submitted report
      // contains the latest edits (no debounce/autosave race).
      if (!await saver.flush()) {
        setSubmitError("Couldn't save your latest checklist edits — please try again.");
        return;
      }
      const r = await post({ action: "submit", checklist });
      if (r.ok) {
        await load();
        return;
      }
      if (r.error === "rooms_incomplete" && Array.isArray(r["missing"])) {
        setMissing(r["missing"] as string[]);
        setSubmitError("Some rooms still need a photo or a reason they were skipped:");
        return;
      }
      setSubmitError("Couldn't submit. Check your connection and try again.");
    } catch {
      // G5 (cleaner half): busy always resets; re-read state before any
      // retry so a repeat cannot create a second action.
      setSubmitError("Couldn't reach the server — the report may or may not have been sent. Reloading before you retry.");
      await load();
    } finally {
      setBusy(false);
    }
  };

  const fmtDate = (iso: string | null): string => {
    if (!iso) return "";
    const d = new Date(`${iso}T12:00:00`);
    return Number.isNaN(d.getTime())
      ? iso
      : d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  };

  if (error) {
    return (
      <div className="min-h-screen bg-background px-4 py-16 text-center">
        <Helmet><meta name="robots" content="noindex,nofollow" /></Helmet>
        <AlertTriangle className="w-14 h-14 text-destructive mx-auto mb-4" strokeWidth={1.5} />
        <h1 className="font-heading text-2xl font-bold mb-3">
          {error === "link_expired" ? "This link has expired" : "This link doesn't work"}
        </h1>
        <p className="text-muted-foreground max-w-sm mx-auto">
          {error === "link_expired"
            ? "Ask the office for a fresh link to this visit."
            : error === "db_not_configured"
              ? "The visit system isn't set up yet. Please contact the office."
              : "The link may be incomplete or no longer active. Ask the office for a fresh link."}
        </p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Helmet><meta name="robots" content="noindex,nofollow" /></Helmet>
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const v = data.visit;
  // Unconfirmed visits are read-only: the cleaner may look, but no
  // photos, checklist edits, or submit until the owner confirms. The
  // server enforces the same gate, so this is display, not security.
  // C2: a cancelled visit is read-only even when the report state alone
  // would look editable; the server rejects POSTs the same way.
  const locked = !data.editable || data.confirmed === false || data.cancelled === true;
  // B (payment-date gate): the visit has not happened yet — the report
  // may be sent only on or after the visit date, never before. "Today"
  // is the Atlanta calendar date (America/New_York), compared as
  // YYYY-MM-DD strings, mirroring the server gate in api/cleaner.ts.
  // The server enforces the same gate, so this is display, not security.
  const isFutureVisit = (() => {
    const d = v.date;
    if (typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    return d > today;
  })();
  // Finish stays disabled until every room is ready — the cleaner sees
  // the missing list in section 3 instead of tapping Finish and getting
  // an error. submit() still checks as a backstop. (A visit with no
  // rooms at all keeps the old behaviour: nothing blocks the submit.)
  const allRoomsReady = checklist.rooms.length === 0 || checklist.rooms.every((r) =>
    roomPhotoStatus(r, photos, photoBlocked(data?.visit.no_photo_zones ?? null, r.name)).ready,
  );

  return (
    <div className="min-h-screen bg-background page-shell">
      <Helmet><meta name="robots" content="noindex,nofollow" /></Helmet>
      <div className="cleaner-flow max-w-2xl mx-auto px-4 pb-6">
        <p className="text-base font-semibold tracking-wide text-primary mb-1">GATEHOUSE HOME CLEANING</p>
        <h1 className="font-heading text-3xl font-bold mb-1">Your cleaning job</h1>
        <p className="text-lg text-foreground">
          {fmtDate(v.date)}
          {v.window ? <> · {({ morning: "7–11 AM ET", midday: "11 AM–2 PM ET", afternoon: "2–5 PM ET", flexible: "Arrival window to be agreed" } as Record<string, string>)[v.window] ?? v.window}</> : null}
        </p>
        {v.service && <p className="text-muted-foreground break-words">{v.service}{(v.client_name ?? v.client_first_name) ? <> · for {v.client_name ?? v.client_first_name}</> : null}</p>}
        {/* B: the visit has not happened yet — the report can be sent
            only after the visit. The server rejects an early submit;
            this notice explains why Finish stays disabled. */}
        {isFutureVisit && (
          <p className="text-base font-medium rounded-lg border border-border bg-muted p-3 mt-3" role="status">
            This visit is on {fmtDate(v.date)} — you can send the report after the visit.
          </p>
        )}
        {lastUpdated && <p className="text-xs text-muted-foreground">Updated {lastUpdated} Atlanta time — reopening this page refreshes it.</p>}
        {data.cancelled === true && (
          <div className="rounded-xl border border-border bg-muted p-4 mt-4" role="status">
            <p className="font-semibold">This visit was cancelled.</p>
            <p className="text-base text-muted-foreground">The form is read-only — no changes can be sent for this visit.</p>
          </div>
        )}

        {data.reclean && (
          <div className="rounded-xl border border-primary/40 bg-primary/5 p-4 mt-4" role="status">
            <p className="text-base font-semibold">Re-clean agreed{data.reclean.date ? <> for {fmtDate(data.reclean.date)}</> : null}</p>
            {data.reclean.note && <p className="text-base text-muted-foreground">{data.reclean.note}</p>}
            <p className="text-base text-muted-foreground">The owner will confirm the details with you — check the rooms below for what needs a second look.</p>
          </div>
        )}

        {data.confirmed === false && (
          <div className="rounded-xl border border-amber-500/60 bg-amber-50 p-4 mt-4">
            <p className="text-base font-semibold">Visit awaiting confirmation</p>
            <p className="text-base text-muted-foreground">Wait for confirmation before traveling. Photos and sending unlock after confirmation.</p>
          </div>
        )}

        {/* C: address/entry live here only while the job is in
            progress. Once the report is submitted, the job is done —
            the address and entry are no longer needed, so the block
            hides. (Gated on report_status, not `locked`: an
            unconfirmed visit still needs its address/entry.) */}
        {data.report_status !== "submitted" && data.report_status !== "sent" && (
        <div className="rounded-xl border border-border bg-card p-5 mt-4 space-y-4">
          <h2 className="font-heading text-xl font-bold">1. Before you go</h2>
          {v.address && (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-base"><span className="font-semibold">Address:</span> {v.address}</p>
              <a className="text-base underline shrink-0" target="_blank" rel="noreferrer" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(v.address)}`}>
                Open in Maps
              </a>
            </div>
          )}
          {!locked && <ClientContact phone={v.client_phone} />}
          {v.entry && (
            <div className="text-base space-y-1">
              <p><span className="font-semibold">Entry:</span> {v.entry.method === "home" ? "Client will be home to let you in." : v.entry.method === "someone" ? "Someone else will meet you." : "Arrange entry before the visit."}</p>
              {v.entry.note && <p><span className="font-semibold">Note:</span> {v.entry.note}</p>}
              {v.entry.secret && <p><span className="font-semibold">Entry details:</span> {v.entry.secret}</p>}
            </div>
          )}
          {!v.entry && v.entry_choice?.method && (
            <div className="text-base space-y-1">
              <p><span className="font-semibold">Entry choice:</span> {v.entry_choice.method === "home" ? "Client will be home to let you in." : v.entry_choice.method === "other_person" ? "Someone else will meet you." : v.entry_choice.method === "arrange_before" ? `Arrange entry before the visit${v.entry_choice.detail === "door_code" ? " (Door code / smart lock)" : v.entry_choice.detail === "lockbox" ? " (Lockbox)" : v.entry_choice.detail === "other" ? " (Other arrangement)" : ""}.` : "Client will decide later — contact the owner."}</p>
              {v.entry_choice.notes && <p><span className="font-semibold">Note:</span> {v.entry_choice.notes}</p>}
            </div>
          )}
          {v.client_notes && (
            <p className="text-base"><span className="font-semibold">Customer notes:</span> {v.client_notes}</p>
          )}
          {v.no_photo_zones && (
            <p className="text-base text-destructive"><span className="font-semibold">Do not photograph:</span> {v.no_photo_zones}</p>
          )}
        </div>
        )}
        {/* C: the help line lives outside "Before you go" so it stays
            visible after the report is submitted too. */}
        <p className="text-sm text-muted-foreground mt-4"><span className="font-semibold">Need help?</span> Call or text Gatehouse <a className="underline" href="tel:+17705258599">(770) 525-8599</a> — for entry problems, damage you find, or anything that goes wrong mid-job.</p>

        {!locked && saveState !== "idle" && (
          <p className="text-base text-muted-foreground mt-4" role="status">
            {saveState === "saving" ? "Saving…" : saveState === "saved" ? "All changes saved." : (
              <>Not saved — <button type="button" className="underline font-semibold" onClick={retrySave}>Retry</button></>
            )}
          </p>
        )}

        {data.confirmed && data.cancelled !== true && data.report_status !== "submitted" && data.report_status !== "sent" && !v.entry && (!v.entry_choice?.method || v.entry_choice.method === "decide_later" || v.entry_choice.method === "arrange_before") && (
          <div className="rounded-xl border border-amber-500/60 bg-amber-50 p-4 mt-4">
            <p className="text-base font-semibold">Entry not arranged yet</p>
            <p className="text-base text-muted-foreground">Contact Gatehouse before leaving. Entry must be agreed first. Call or text <a className="underline" href="tel:+17705258599">(770) 525-8599</a> or email <a className="underline" href="mailto:hello@gatehousehomecleaning.com">hello@gatehousehomecleaning.com</a>.</p>
          </div>
        )}

        {/* C: "How photos work" is a quiet collapsed note, not a card —
            the room steps already explain the photos. */}
        <details className="mt-4">
          <summary className="text-sm text-muted-foreground cursor-pointer">How photos work</summary>
          <p className="text-sm text-muted-foreground mt-2">
            Please don&apos;t photograph people, documents, bank cards, alarm codes or other
            personal items. Photos go only into the client&apos;s report for this visit — they are
            never used for marketing without separate consent.
          </p>
          <p className="text-sm text-muted-foreground mt-2">
            Take a “before” photo of each area before you start, and an “after” photo when
            you finish — from a similar angle, so the client can compare. Add a close-up only
            where it helps (inside the oven, a stain you couldn&apos;t remove, damage you found).
            A photo counts as uploaded only when it appears above with its picture.
          </p>
        </details>

        {data.report_status === "returned" && (data.owner_note || data.client_issue) && (
          <div className="rounded-xl border border-amber-500/50 bg-amber-50 p-4 mt-4">
            <p className="text-base font-semibold mb-1">The owner sent this report back:</p>
            {data.owner_note && <p className="text-base">{data.owner_note}</p>}
            {data.client_issue && (
              <p className="text-base mt-2">
                {data.client_issue.source === "client" ? "What the client flagged" : "Issue reported"}
                {data.client_issue.room ? <> ({data.client_issue.room})</> : null}
                : “{data.client_issue.reason}”
              </p>
            )}
          </div>
        )}
        {data.report_status === "submitted" && (
          <div className="rounded-xl border border-border bg-card p-4 mt-4 text-center">
            <CheckCircle className="w-10 h-10 text-sage-foreground mx-auto mb-2" strokeWidth={1.5} />
            {data.report_held ? (
              <>
                <p className="font-semibold">Report received — it&apos;s waiting for the owner to review the client&apos;s issue.</p>
                <p className="text-base text-muted-foreground">The owner will review it and let you know if anything needs a second look.</p>
              </>
            ) : (
              <>
                <p className="font-semibold">Report received — the owner will share it with the client.</p>
                <p className="text-base text-muted-foreground">You&apos;re done here — thank you!</p>
              </>
            )}
          </div>
        )}
        {data.report_status === "sent" && data.report_bounced && (
          <div className="rounded-xl border border-amber-500/50 bg-amber-50 p-4 mt-4 text-center">
            <p className="font-semibold">Sending failed — the client never got this report.</p>
            <p className="text-base text-muted-foreground">The owner will re-send it. You don&apos;t need to do anything.</p>
          </div>
        )}
        {data.report_status === "sent" && !data.report_bounced && (
          <div className="rounded-xl border border-border bg-card p-4 mt-4 text-center">
            <CheckCircle className="w-10 h-10 text-sage-foreground mx-auto mb-2" strokeWidth={1.5} />
            <p className="font-semibold">Report published — the client can open it from their link.</p>
            <p className="text-base text-muted-foreground">You&apos;re done — thank you!</p>
          </div>
        )}

        {locked && (data.report_status === "submitted" || data.report_status === "sent") && checklist.rooms.length > 0 && (
          <div className="rounded-xl border border-border bg-card p-4 mt-4">
            <ReportChecklistView checklist={checklist} />
          </div>
        )}

        {locked && (
          <div className="mt-4 space-y-4">
            {checklist.rooms.map((room) => {
              // The customer's own problem-report photos (kind "client")
              // belong to the owner review, not the cleaner's summary.
              const roomPhotos = photos.filter((ph) => ph.room === room.name && ph.kind !== "client");
              if (roomPhotos.length === 0 && !room.skip_reason) return null;
              return (
                <div key={room.name} className="rounded-xl border border-border bg-card p-4">
                  <h2 className="font-heading text-xl font-bold mb-2">{room.name}</h2>
                  {room.skip_reason && (
                    <p className="text-base text-muted-foreground mb-2">No photos — {room.skip_reason}</p>
                  )}
                  <div className="grid grid-cols-3 gap-2">
                    {roomPhotos.map((ph) => (
                      <div key={ph.id} className="relative">
                        {ph.url ? (
                          <img src={ph.url} alt={`${room.name} ${ph.kind}`} className="rounded-lg object-cover w-full h-24" />
                        ) : (
                          <div className="rounded-lg bg-muted w-full h-24" />
                        )}
                        <span className="absolute left-1 top-1 text-[10px] bg-black/60 text-white px-1.5 py-0.5 rounded">
                          {ph.kind === "before" ? "Before" : "After"}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {!locked && checklist.rooms.length > 0 && (
          <div className="rounded-xl border border-border bg-card p-4 mt-4">
            {(() => {
              const ready = checklist.rooms.filter((r) =>
                roomPhotoStatus(r, photos, photoBlocked(v.no_photo_zones, r.name)).ready,
              ).length;
              return (
                <>
                  <h2 className="font-heading text-xl font-bold mb-2">2. Clean each room</h2>
                  <p className="text-base font-semibold mb-2">
                    Rooms ready: {ready} of {checklist.rooms.length}
                  </p>
                  <div className="h-2 rounded bg-muted overflow-hidden">
                    <div
                      className="h-full bg-primary transition-all"
                      style={{ width: `${checklist.rooms.length ? (ready / checklist.rooms.length) * 100 : 0}%` }}
                    />
                  </div>
                  <p className="text-base text-muted-foreground mt-2">
                    Open a room: take a before photo, complete the tasks, then add an after photo. If a task cannot be completed, add a note for Gatehouse. If photos are not allowed, give a reason.
                  </p>
                </>
              );
            })()}
          </div>
        )}

        {!locked &&
          checklist.rooms.map((room, roomIdx) => {
            const roomPhotos = photos.filter((p) => p.room === room.name);
            const beforePhotos = roomPhotos.filter((p) => p.kind === "before");
            const afterPhotos = roomPhotos.filter((p) => p.kind === "after");
            const beforeCount = beforePhotos.length;
            const afterCount = afterPhotos.length;
            const noPhotoHere = photoBlocked(v.no_photo_zones, room.name);
            const { beforeOk, afterOk, ready } = roomPhotoStatus(room, photos, noPhotoHere);
            const beforeUploads = Object.values(uploads).filter((u) => u.room === room.name && u.kind === "before");
            const afterUploads = Object.values(uploads).filter((u) => u.room === room.name && u.kind === "after");
            const photoThumb = (p: Photo) => (
              <div key={p.id} className="relative">
                {p.url ? (
                  <img src={p.url} alt={`${room.name} ${p.kind}`} className="rounded-lg object-cover w-full h-24" />
                ) : (
                  <div className="rounded-lg bg-muted w-full h-24" />
                )}
                <span className="absolute left-1 top-1 text-[10px] bg-black/60 text-white px-1.5 py-0.5 rounded">
                  {p.kind === "before" ? "Before" : "After"}
                </span>
                <button
                  type="button"
                  aria-label="Remove photo"
                  className="absolute right-1 top-1 flex min-h-[44px] min-w-[44px] items-center justify-center bg-black/60 text-white rounded p-1"
                  onClick={() => void deletePhoto(p)}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            );
            const uploadError = ([tempId, u]: [string, UploadState]) => (
              <div key={tempId} className="mb-2 flex items-start gap-2 mt-2">
                <p className="text-base text-destructive flex-1" role="alert">{u.error}</p>
                {u.file && (
                  <button type="button" className="min-h-[44px] px-2 text-base underline shrink-0" onClick={() => retryUpload(tempId)}>
                    Retry
                  </button>
                )}
                <button type="button" className="min-h-[44px] px-2 text-base text-muted-foreground shrink-0" onClick={() => dismissUpload(tempId)}>
                  Dismiss
                </button>
              </div>
            );
            return (
              <details key={room.name} open={openRoom === undefined ? roomIdx === 0 : openRoom === room.name} className="rounded-xl border border-border bg-card p-4 mt-4">
                <summary className="flex min-h-[48px] flex-wrap items-center justify-between gap-3 cursor-pointer list-none" onClick={(e) => { e.preventDefault(); setOpenRoom((openRoom === undefined ? roomIdx === 0 : openRoom === room.name) ? null : room.name); }}>
                  <span className="font-heading text-xl font-bold">{room.name}</span>
                  <span className="flex flex-wrap items-center gap-2">
                    {room.skip_reason ? (
                      <span className="text-base bg-sky-100 text-sky-900 px-2 py-0.5 rounded font-semibold">Reason added</span>
                    ) : ready ? (
                      <span className="text-base bg-green-100 text-green-900 px-2 py-0.5 rounded font-semibold">Photo ready ✓</span>
                    ) : noPhotoHere ? (
                      <span className="text-base bg-amber-100 text-amber-900 px-2 py-0.5 rounded font-semibold">No photos — add a reason</span>
                    ) : !beforeOk ? (
                      <span className="text-base bg-amber-100 text-amber-900 px-2 py-0.5 rounded font-semibold">Take before photo</span>
                    ) : (
                      <span className="text-base bg-amber-100 text-amber-900 px-2 py-0.5 rounded font-semibold">Add after photo</span>
                    )}
                    <span className="text-base text-primary underline">{(openRoom === undefined ? roomIdx === 0 : openRoom === room.name) ? "Hide" : "Open"}</span>
                  </span>
                </summary>

                {/* Step 1 — before photo (or a reason). The checklist stays locked until this step is done. */}
                <div className="mt-3">
                  <p className="text-base font-semibold mb-2">Step 1 — Before photo</p>
                  {noPhotoHere && (
                    <p className="text-base text-destructive">This room is on the client&apos;s do-not-photograph list — use the reason field below instead of a photo.</p>
                  )}
                  {(beforePhotos.length > 0 || beforeUploads.some((u) => u.status === "working")) && (
                    <div className="grid grid-cols-3 gap-2 mb-3 mt-2">
                      {beforePhotos.map(photoThumb)}
                      {beforeUploads.filter((u) => u.status === "working").map((u, i) => (
                        <div key={i} className="rounded-lg bg-muted w-full h-24 flex items-center justify-center">
                          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                        </div>
                      ))}
                    </div>
                  )}
                  {!noPhotoHere && (
                    <div className="grid grid-cols-2 gap-2">
                      <label className="flex-1 rounded-lg focus-within:ring-2 focus-within:ring-ring">
                        <span className="flex min-h-[44px] items-center justify-center gap-2 rounded-lg bg-primary text-primary-foreground px-3 py-2.5 text-base font-medium cursor-pointer">
                          <Camera className="w-4 h-4" /> Take BEFORE photo
                        </span>
                        <input
                          type="file"
                          accept="image/*"
                          capture="environment"
                          className="sr-only"
                          disabled={busy || noPhotoHere}
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) void uploadPhoto(room.name, "before", f);
                            e.target.value = "";
                          }}
                        />
                      </label>
                      <label className="flex-1 rounded-lg focus-within:ring-2 focus-within:ring-ring">
                        <span className="flex min-h-[44px] items-center justify-center rounded-lg border border-border px-3 py-2.5 text-base cursor-pointer">Gallery (before)</span>
                        <input type="file" accept="image/*" multiple className="sr-only" disabled={busy || noPhotoHere} onChange={(e) => { for (const file of Array.from(e.target.files ?? [])) void uploadPhoto(room.name, "before", file); e.target.value = ""; }} />
                      </label>
                    </div>
                  )}
                  {Object.entries(uploads)
                    .filter(([, u]) => u.room === room.name && u.kind === "before" && u.status === "error")
                    .map(uploadError)}
                  {(beforeCount === 0 || afterCount === 0) && (
                    <div className="mt-3">
                      <label className="block text-base font-medium mb-1" htmlFor={`skip-${room.name}`}>
                        No photo for this room? Tell us why
                      </label>
                      <input
                        id={`skip-${room.name}`}
                        type="text"
                        className="w-full border border-border rounded-lg px-3 py-2 bg-background text-base"
                        disabled={busy}
                        placeholder="e.g. Room wasn't part of this visit"
                        value={room.skip_reason ?? ""}
                        onChange={(e) => {
                          const rooms = checklist.rooms.map((r) =>
                            r.name === room.name ? { ...r, skip_reason: e.target.value } : r,
                          );
                          saveChecklist({ ...checklist, rooms });
                        }}
                      />
                    </div>
                  )}
                </div>

                {/* Step 2 — checklist, locked until the before step is done. */}
                <div className="mt-4">
                  <p className="text-base font-semibold mb-2">Step 2 — Clean the room</p>
                  {!beforeOk && (
                    <p className="text-base text-muted-foreground mb-2">
                      {noPhotoHere ? "Add a reason in Step 1 to unlock the checklist." : "Take a before photo in Step 1 to unlock the checklist."}
                    </p>
                  )}
                  <div className="space-y-2 mb-3">
                    {room.items.map((item, idx) => (
                      <label key={idx} className="flex min-h-[44px] items-center gap-3 text-base cursor-pointer">
                        <input
                          type="checkbox"
                          className="mt-0.5 h-5 w-5 accent-primary"
                          disabled={busy || !beforeOk}
                          checked={item.done}
                          onChange={(e) => {
                            const rooms = checklist.rooms.map((r) =>
                              r.name === room.name
                                ? { ...r, items: r.items.map((it, i) => (i === idx ? { ...it, done: e.target.checked } : it)) }
                                : r,
                            );
                            saveChecklist({ ...checklist, rooms });
                          }}
                        />
                        <span>{item.label}</span>
                      </label>
                    ))}
                  </div>
                </div>

                {/* Step 3 — after photo. */}
                <div className="mt-4">
                  <p className="text-base font-semibold mb-2">Step 3 — After photo</p>
                  {(afterPhotos.length > 0 || afterUploads.some((u) => u.status === "working")) && (
                    <div className="grid grid-cols-3 gap-2 mb-3">
                      {afterPhotos.map(photoThumb)}
                      {afterUploads.filter((u) => u.status === "working").map((u, i) => (
                        <div key={i} className="rounded-lg bg-muted w-full h-24 flex items-center justify-center">
                          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                        </div>
                      ))}
                    </div>
                  )}
                  {!noPhotoHere && (
                    <div className="grid grid-cols-2 gap-2">
                      <label className="flex-1 rounded-lg focus-within:ring-2 focus-within:ring-ring">
                        <span className="flex min-h-[44px] items-center justify-center gap-2 rounded-lg bg-primary text-primary-foreground px-3 py-2.5 text-base font-medium cursor-pointer">
                          <Camera className="w-4 h-4" /> Take AFTER photo
                        </span>
                        <input
                          type="file"
                          accept="image/*"
                          capture="environment"
                          className="sr-only"
                          disabled={busy || noPhotoHere}
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) void uploadPhoto(room.name, "after", f);
                            e.target.value = "";
                          }}
                        />
                      </label>
                      <label className="flex-1 rounded-lg focus-within:ring-2 focus-within:ring-ring">
                        <span className="flex min-h-[44px] items-center justify-center gap-2 rounded-lg border border-border px-3 py-2.5 text-base font-medium cursor-pointer">
                          <ImagePlus className="w-4 h-4" /> Gallery (after)
                        </span>
                        <input
                          type="file"
                          accept="image/*"
                          multiple
                          className="sr-only"
                          disabled={busy || noPhotoHere}
                          onChange={(e) => {
                            const files = Array.from(e.target.files ?? []);
                            for (const f of files) void uploadPhoto(room.name, "after", f);
                            e.target.value = "";
                          }}
                        />
                      </label>
                    </div>
                  )}
                  {Object.entries(uploads)
                    .filter(([, u]) => u.room === room.name && u.kind === "after" && u.status === "error")
                    .map(uploadError)}
                  {afterCount === 0 && !room.skip_reason && (
                    <p className="text-base text-muted-foreground mt-2">No after photo yet — take one above, or add a reason in Step 1.</p>
                  )}
                </div>

                {missing.includes(room.name) && (
                  <p className="text-base text-destructive mt-2" role="alert">
                    {!beforeOk
                      ? "This room still needs a before photo (or a reason)."
                      : !afterOk
                        ? "This room still needs an after photo (or a reason)."
                        : "This room still needs a photo or a reason."}
                  </p>
                )}
              </details>
            );
          })}

        {!locked && (
          <>
            <details className="rounded-xl border border-border bg-card p-4 mt-4">
              <summary className="min-h-[44px] cursor-pointer font-semibold">Add a note for Gatehouse (optional)</summary>
              <label className="block font-semibold mb-2 mt-2" htmlFor="problem-note">
                Anything the owner should know?
              </label>
              <textarea
                id="problem-note"
                className="w-full border border-border rounded-lg px-3 py-2 bg-background text-base"
                rows={3}
                disabled={busy}
                placeholder="Damage you found, a room you couldn't access, supplies missing…"
                value={checklist.problem_note ?? ""}
                onChange={(e) => saveChecklist({ ...checklist, problem_note: e.target.value })}
              />
            </details>
            {submitError && (
              <p className="text-base text-destructive mt-4" role="alert">
                {submitError}
                {missing.length > 0 && <> {missing.join(", ")}</>}
              </p>
            )}
            {Object.values(uploads).some((u) => u.status === "error") && (
              <p className="text-base text-destructive mt-4" role="alert">
                Some photos failed to upload — retry them above before finishing, or they will not be in the report.
              </p>
            )}
            {Object.values(uploads).some((u) => u.status === "working") && (
              <p className="text-base text-muted-foreground mt-4" role="status">
                Photos are still uploading — Finish will unlock when they are done.
              </p>
            )}
            {(() => {
              const statuses = checklist.rooms.map((r) => ({
                name: r.name,
                ...roomPhotoStatus(r, photos, photoBlocked(v.no_photo_zones, r.name)),
              }));
              const missingRooms = statuses.filter((s) => !s.ready).map((s) => s.name);
              const missingBefore = statuses.filter((s) => !s.beforeOk).map((s) => s.name);
              const missingAfter = statuses.filter((s) => s.beforeOk && !s.afterOk).map((s) => s.name);
              const uploading = Object.values(uploads).filter((u) => u.status === "working").length;
              return (
                <div className="rounded-xl border border-border bg-card p-4 mt-4 text-base" role="status">
                  <h2 className="font-heading text-xl font-bold mb-2">3. Finish your job</h2>
                  <p>Rooms ready: {checklist.rooms.length - missingRooms.length} of {checklist.rooms.length}</p>
                  {missingBefore.length > 0 && <p className="text-destructive">Still need a before photo (or a reason): {missingBefore.join(", ")}</p>}
                  {missingAfter.length > 0 && <p className="text-destructive">Still need an after photo (or a reason): {missingAfter.join(", ")}</p>}
                  {uploading > 0 && <p>Photos still uploading: {uploading} — Finish unlocks when they are done.</p>}
                  {missingRooms.length === 0 && uploading === 0 && !isFutureVisit && <p>Everything is ready — Finish will send the report.</p>}
                  {isFutureVisit && <p>This visit is on {fmtDate(v.date)} — Finish unlocks after the visit.</p>}
                </div>
              );
            })()}
            <Button variant="hero" size="lg" className="w-full mt-4" disabled={busy || isFutureVisit || !allRoomsReady || Object.values(uploads).some((u) => u.status === "working")} onClick={() => void submit()}>
              {busy ? "Sending…" : "Finish & send report"}
            </Button>
            <p className="text-base text-muted-foreground text-center mt-2">
              Your work saves automatically. Finish sends the report, or passes it to Gatehouse if review is needed.
            </p>
          </>
        )}
      </div>
    </div>
  );
};

export default Cleaner;
