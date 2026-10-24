import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Helmet } from "react-helmet-async";
import { Camera, CheckCircle, AlertTriangle, Loader2, Trash2, ImagePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { convertToJpeg } from "@/lib/imageConvert";

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
    client_notes?: string | null;
    no_photo_zones: string | null;
    client_first_name: string;
  };
  checklist: Checklist;
  photos: Photo[];
  report_status: string;
  editable: boolean;
  confirmed: boolean;
  owner_note: string | null;
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


const Cleaner = () => {
  const [searchParams] = useSearchParams();
  const ct = searchParams.get("ct") ?? "";
  const [data, setData] = useState<CleanerView | null>(null);
  const [error, setError] = useState("");
  const [checklist, setChecklist] = useState<Checklist>({ rooms: [] });
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [uploads, setUploads] = useState<Record<string, UploadState>>({});
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [missing, setMissing] = useState<string[]>([]);
  const saveTimer = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/cleaner?ct=${encodeURIComponent(ct)}`);
      const j = (await r.json()) as CleanerView;
      if (!j.ok) {
        setError(j.error ?? "load_failed");
        return;
      }
      setData(j);
      setChecklist(j.checklist ?? { rooms: [] });
      setPhotos(j.photos ?? []);
    } catch {
      setError("load_failed");
    }
  }, [ct]);

  useEffect(() => {
    void load();
  }, [load]);

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

  const saveChecklist = useCallback(
    (next: Checklist) => {
      setChecklist(next);
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        void post({ action: "checklist", checklist: next });
      }, 600);
    },
    [post],
  );

  const seenFiles = useRef<Set<string>>(new Set());

  const uploadPhoto = async (room: string, kind: "after" | "before", file: File) => {
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
        if (reg.error === "invalid_photo_file") {
          throw new Error("That file isn't a usable photo (JPG/PNG/HEIC, up to 15 MB). Please pick another one.");
        }
        throw new Error("The photo uploaded but couldn't be saved. Please retry.");
      }
      seenFiles.current.add(signature);
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
    if (r.ok) setPhotos((list) => list.filter((p) => p.id !== photo.id));
  };

  const submit = async () => {
    setBusy(true);
    setSubmitError("");
    setMissing([]);
    const r = await post({ action: "submit", checklist });
    setBusy(false);
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
  const locked = !data.editable || data.confirmed === false;

  return (
    <div className="min-h-screen bg-background">
      <Helmet><meta name="robots" content="noindex,nofollow" /></Helmet>
      <div className="max-w-xl mx-auto px-4 py-6">
        <p className="text-sm font-semibold tracking-wide text-primary mb-1">GATEHOUSE HOME CLEANING</p>
        <h1 className="font-heading text-3xl font-bold mb-1">Your visit</h1>
        <p className="text-lg text-foreground">
          {fmtDate(v.date)}
          {v.window ? <> · {v.window}</> : null}
        </p>
        {v.service && <p className="text-muted-foreground">{v.service}{v.client_first_name ? <> · for {v.client_first_name}</> : null}</p>}

        {data.confirmed === false && (
          <div className="rounded-xl border border-amber-500/60 bg-amber-50 p-4 mt-4">
            <p className="text-sm font-semibold">Visit awaiting confirmation</p>
            <p className="text-sm text-muted-foreground">The owner has not confirmed this visit yet. You can look around, but photos and the report stay disabled until confirmation arrives.</p>
          </div>
        )}

        <div className="rounded-xl border border-border bg-card p-4 mt-4 space-y-2">
          {v.address && (
            <p className="text-sm"><span className="font-semibold">Address:</span> {v.address}</p>
          )}
          {v.access_notes && (
            <p className="text-sm"><span className="font-semibold">Access:</span> {v.access_notes}</p>
          )}
          {v.client_notes && (
            <p className="text-sm"><span className="font-semibold">Customer notes:</span> {v.client_notes}</p>
          )}
          {v.no_photo_zones && (
            <p className="text-sm text-destructive"><span className="font-semibold">Do not photograph:</span> {v.no_photo_zones}</p>
          )}
        </div>

        <div className="rounded-xl border border-border bg-muted/40 p-4 mt-4">
          <p className="text-sm text-foreground">
            Please don&apos;t photograph people, documents, bank cards, alarm codes or other
            personal items. Photos go only into the client&apos;s report for this visit — they are
            never used for marketing without separate consent.
          </p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4 mt-4">
          <p className="text-sm text-foreground">
            <strong>How to photograph:</strong> take a “before” photo of each area before you
            start, and an “after” photo when you finish — from a similar angle, so the client
            can compare. Add a close-up only where it helps (inside the oven, a stain you
            couldn&apos;t remove, damage you found). A photo counts as uploaded only when it
            appears above with its picture.
          </p>
        </div>

        {data.report_status === "returned" && data.owner_note && (
          <div className="rounded-xl border border-amber-500/50 bg-amber-50 p-4 mt-4">
            <p className="text-sm font-semibold mb-1">The owner sent this report back:</p>
            <p className="text-sm">{data.owner_note}</p>
          </div>
        )}
        {data.report_status === "submitted" && (
          <div className="rounded-xl border border-border bg-card p-4 mt-4 text-center">
            <CheckCircle className="w-10 h-10 text-sage-foreground mx-auto mb-2" strokeWidth={1.5} />
            <p className="font-semibold">Report submitted — awaiting Gatehouse review.</p>
            <p className="text-sm text-muted-foreground">Gatehouse will review it before sharing it with the customer. You&apos;re done here — thank you!</p>
          </div>
        )}
        {data.report_status === "sent" && (
          <div className="rounded-xl border border-border bg-card p-4 mt-4 text-center">
            <CheckCircle className="w-10 h-10 text-sage-foreground mx-auto mb-2" strokeWidth={1.5} />
            <p className="font-semibold">Report published.</p>
            <p className="text-sm text-muted-foreground">Gatehouse reviewed this report and shared it with the customer. You&apos;re done here — thank you!</p>
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
                    <p className="text-sm text-muted-foreground mb-2">No photos — {room.skip_reason}</p>
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
              const ready = checklist.rooms.filter((r) => {
                const a = photos.filter((p) => p.room === r.name && p.kind === "after").length;
                return a > 0 || Boolean(r.skip_reason);
              }).length;
              return (
                <>
                  <p className="text-sm font-semibold mb-2">
                    Rooms ready: {ready} of {checklist.rooms.length}
                  </p>
                  <div className="h-2 rounded bg-muted overflow-hidden">
                    <div
                      className="h-full bg-primary transition-all"
                      style={{ width: `${checklist.rooms.length ? (ready / checklist.rooms.length) * 100 : 0}%` }}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground mt-2">
                    Each room needs an “after” photo — or a written reason why there is none.
                  </p>
                </>
              );
            })()}
          </div>
        )}

        {!locked &&
          checklist.rooms.map((room) => {
            const roomPhotos = photos.filter((p) => p.room === room.name);
            const afterCount = roomPhotos.filter((p) => p.kind === "after").length;
            return (
              <div key={room.name} className="rounded-xl border border-border bg-card p-4 mt-4">
                <div className="flex items-center justify-between mb-2">
                  <h2 className="font-heading text-xl font-bold">{room.name}</h2>
                  <span className="flex items-center gap-2">
                    {afterCount > 0 ? (
                      <span className="text-[11px] bg-green-100 text-green-900 px-2 py-0.5 rounded font-semibold">After photo ✓</span>
                    ) : room.skip_reason ? (
                      <span className="text-[11px] bg-sky-100 text-sky-900 px-2 py-0.5 rounded font-semibold">Skipped — reason given</span>
                    ) : (
                      <span className="text-[11px] bg-amber-100 text-amber-900 px-2 py-0.5 rounded font-semibold">Needs an after photo</span>
                    )}
                    <span className="text-xs text-muted-foreground">{afterCount} photo{afterCount === 1 ? "" : "s"}</span>
                  </span>
                </div>
                <div className="space-y-2 mb-3">
                  {room.items.map((item, idx) => (
                    <label key={idx} className="flex items-start gap-3 text-sm cursor-pointer">
                      <input
                        type="checkbox"
                        className="mt-0.5 h-5 w-5 accent-primary"
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

                <div className="grid grid-cols-3 gap-2 mb-3">
                  {roomPhotos.map((p) => (
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
                        className="absolute right-1 top-1 bg-black/60 text-white rounded p-1"
                        onClick={() => void deletePhoto(p)}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                  {Object.values(uploads)
                    .filter((u) => u.room === room.name && u.status === "working")
                    .map((u, i) => (
                      <div key={i} className="rounded-lg bg-muted w-full h-24 flex items-center justify-center">
                        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                      </div>
                    ))}
                </div>
                {Object.entries(uploads)
                  .filter(([, u]) => u.room === room.name && u.status === "error")
                  .map(([tempId, u]) => (
                    <div key={tempId} className="mb-2 flex items-start gap-2">
                      <p className="text-sm text-destructive flex-1" role="alert">{u.error}</p>
                      {u.file && (
                        <button type="button" className="text-sm underline shrink-0" onClick={() => retryUpload(tempId)}>
                          Retry
                        </button>
                      )}
                      <button type="button" className="text-sm text-muted-foreground shrink-0" onClick={() => dismissUpload(tempId)}>
                        Dismiss
                      </button>
                    </div>
                  ))}

                <div className="flex gap-2">
                  <label className="flex-1">
                    <span className="flex items-center justify-center gap-2 rounded-lg bg-primary text-primary-foreground px-3 py-2.5 text-sm font-medium cursor-pointer">
                      <Camera className="w-4 h-4" /> Take AFTER photo
                    </span>
                    <input
                      type="file"
                      accept="image/*"
                      capture="environment"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void uploadPhoto(room.name, "after", f);
                        e.target.value = "";
                      }}
                    />
                  </label>
                  <label className="flex-1">
                    <span className="flex items-center justify-center gap-2 rounded-lg border border-border px-3 py-2.5 text-sm font-medium cursor-pointer">
                      <ImagePlus className="w-4 h-4" /> Gallery (after)
                    </span>
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      className="hidden"
                      onChange={(e) => {
                        const files = Array.from(e.target.files ?? []);
                        for (const f of files) void uploadPhoto(room.name, "after", f);
                        e.target.value = "";
                      }}
                    />
                  </label>
                  <label className="flex-1">
                    <span className="flex items-center justify-center gap-2 rounded-lg border border-border px-3 py-2.5 text-sm font-medium cursor-pointer">
                      <Camera className="w-4 h-4" /> Take BEFORE photo
                    </span>
                    <input
                      type="file"
                      accept="image/*"
                      capture="environment"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void uploadPhoto(room.name, "before", f);
                        e.target.value = "";
                      }}
                    />
                  </label>
                </div>

                {afterCount === 0 && (
                  <div className="mt-3">
                    <label className="block text-sm font-medium mb-1" htmlFor={`skip-${room.name}`}>
                      No photo for this room? Tell us why
                    </label>
                    <input
                      id={`skip-${room.name}`}
                      type="text"
                      className="w-full border border-border rounded-lg px-3 py-2 bg-background text-sm"
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
                {missing.includes(room.name) && (
                  <p className="text-sm text-destructive mt-2" role="alert">This room still needs a photo or a reason.</p>
                )}
              </div>
            );
          })}

        {!locked && (
          <>
            <div className="rounded-xl border border-border bg-card p-4 mt-4">
              <label className="block font-semibold mb-2" htmlFor="problem-note">
                Anything the owner should know?
              </label>
              <textarea
                id="problem-note"
                className="w-full border border-border rounded-lg px-3 py-2 bg-background text-sm"
                rows={3}
                placeholder="Damage you found, a room you couldn't access, supplies missing…"
                value={checklist.problem_note ?? ""}
                onChange={(e) => saveChecklist({ ...checklist, problem_note: e.target.value })}
              />
            </div>
            {submitError && (
              <p className="text-sm text-destructive mt-4" role="alert">
                {submitError}
                {missing.length > 0 && <> {missing.join(", ")}</>}
              </p>
            )}
            <Button variant="hero" size="lg" className="w-full mt-4" disabled={busy} onClick={() => void submit()}>
              {busy ? "Sending…" : "Submit report for review"}
            </Button>
            <p className="text-xs text-muted-foreground text-center mt-2">
              Your draft saves automatically — you can close this page and come back.
            </p>
          </>
        )}
      </div>
    </div>
  );
};

export default Cleaner;
