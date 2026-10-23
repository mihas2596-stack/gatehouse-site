// Cleaner cabinet API — one token-scoped visit per link.
//   GET  /api/cleaner?ct=...            → visit view (scope, checklist, photos)
//   POST /api/cleaner {ct, action}     → checklist | photo_sign | photo_register
//                                         | photo_delete | submit
//
// The token is random (32 bytes); only its SHA-256 hash is stored on the
// visit row, with an expiry. A link opens exactly one visit: the cleaner
// cannot see other bookings, prices beyond the visit scope, or any payment
// data. Photos live in a private Supabase bucket; the page receives
// short-lived signed URLs, and uploads go straight to Storage with a
// signed upload URL (bytes never pass through this function).

import {
  dbConfigured,
  dbSelect,
  dbInsert,
  dbUpdate,
  dbDelete,
  logEvent,
  storageSignUpload,
  storageSignDownload,
  storageRemove,
  storageObjectInfo,
  ALLOWED_PHOTO_TYPES,
  MAX_PHOTO_BYTES,
  hashToken,
} from "./_db.js";

type Req = {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  query?: Record<string, string | string[] | undefined>;
  body: unknown;
};
type Res = {
  status(code: number): Res;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
};

type ChecklistItem = { label: string; done: boolean };
type ChecklistRoom = { name: string; items: ChecklistItem[]; skip_reason?: string };
type Checklist = { rooms: ChecklistRoom[]; problem_note?: string; submitted_at?: string };

type VisitRow = {
  id: string;
  booking_id: string;
  client_name: string | null;
  service: string | null;
  visit_date: string | null;
  window: string | null;
  address: string | null;
  access_notes: string | null;
  no_photo_zones: string | null;
  checklist: Checklist;
  report_status: string;
  cleaner_token_hash: string | null;
  cleaner_token_expires: string | null;
  status: string;
};

type PhotoRow = {
  id: string;
  room: string;
  storage_path: string;
  kind: string;
  note: string | null;
  created_at: string;
};

const OWNER_EMAIL = "nikolajmihasenok@gmail.com";
const FROM_EMAIL = "Gatehouse Home Cleaning <info@gatehousehomecleaning.com>";
const EDITABLE = new Set(["none", "draft", "returned"]);

const roomSlug = (room: string): string =>
  room.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "room";

export function sanitizeChecklist(raw: unknown): Checklist | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as { rooms?: unknown; problem_note?: unknown };
  if (!Array.isArray(c.rooms) || c.rooms.length === 0 || c.rooms.length > 20) return null;
  const rooms: ChecklistRoom[] = [];
  for (const r of c.rooms as Array<Record<string, unknown>>) {
    if (!r || typeof r.name !== "string" || !Array.isArray(r.items) || r.items.length > 40) return null;
    const items: ChecklistItem[] = [];
    for (const it of r.items as Array<Record<string, unknown>>) {
      if (!it || typeof it.label !== "string") return null;
      items.push({ label: it.label.slice(0, 120), done: it.done === true });
    }
    const room: ChecklistRoom = { name: r.name.slice(0, 60), items };
    if (typeof r.skip_reason === "string" && r.skip_reason.trim()) {
      room.skip_reason = r.skip_reason.slice(0, 200);
    }
    rooms.push(room);
  }
  const out: Checklist = { rooms };
  if (typeof c.problem_note === "string") out.problem_note = c.problem_note.slice(0, 1000);
  if (JSON.stringify(out).length > 64_000) return null;
  return out;
}

async function resolveVisit(
  token: string,
): Promise<{ visit: VisitRow } | { error: string; status: number }> {
  if (!dbConfigured()) return { error: "db_not_configured", status: 501 };
  if (!token || token.length < 20 || token.length > 200) {
    return { error: "invalid_link", status: 404 };
  }
  const rows = await dbSelect<VisitRow>(
    "gh_visits",
    `cleaner_token_hash=eq.${hashToken(token)}&limit=1`,
  );
  const visit = rows[0];
  if (!visit) return { error: "invalid_link", status: 404 };
  if (visit.cleaner_token_expires && Date.parse(visit.cleaner_token_expires) < Date.now()) {
    return { error: "link_expired", status: 410 };
  }
  return { visit };
}

/** Rooms that still block submission: no after-photo and no skip reason. */
export function missingRooms(
  checklist: Checklist,
  photos: { room: string; kind: string }[],
): string[] {
  const missing: string[] = [];
  for (const room of checklist.rooms ?? []) {
    const hasPhoto = photos.some((ph) => ph.room === room.name && ph.kind === "after");
    if (!hasPhoto && !room.skip_reason) missing.push(room.name);
  }
  return missing;
}

async function photosOf(visitId: string): Promise<PhotoRow[]> {
  return dbSelect<PhotoRow>(
    "gh_photos",
    `visit_id=eq.${visitId}&order=created_at.asc&limit=200`,
  );
}

async function view(visit: VisitRow) {
  const photos = await photosOf(visit.id);
  const withUrls = await Promise.all(
    photos.map(async (p) => ({
      id: p.id,
      room: p.room,
      kind: p.kind,
      note: p.note,
      created_at: p.created_at,
      url: await storageSignDownload(p.storage_path, 3600),
    })),
  );
  const events = await dbSelect<{ detail: { note?: string } | null }>(
    "gh_events",
    `visit_id=eq.${visit.id}&event=eq.report_returned&order=created_at.desc&limit=1`,
  );
  const firstName = (visit.client_name ?? "").trim().split(/\s+/)[0] ?? "";
  return {
    ok: true,
    visit: {
      service: visit.service,
      date: visit.visit_date,
      window: visit.window,
      address: visit.address,
      access_notes: visit.access_notes,
      no_photo_zones: visit.no_photo_zones,
      client_first_name: firstName,
    },
    checklist: visit.checklist ?? { rooms: [] },
    photos: withUrls,
    report_status: visit.report_status,
    editable: EDITABLE.has(visit.report_status),
    owner_note: events[0]?.detail?.note ?? null,
  };
}

async function sendOwnerEmail(subject: string, text: string): Promise<boolean> {
  const key = process.env["RESEND_API_KEY"];
  if (!key) return false;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM_EMAIL, to: [OWNER_EMAIL], subject, text }),
      signal: AbortSignal.timeout(15000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export default async function handler(req: Req, res: Res) {
  const requestId = Math.random().toString(36).slice(2);
  const json = (status: number, body: Record<string, unknown>) =>
    res.status(status).json({ requestId, ...body });
  try {
    if (req.method === "GET") {
      const ct = typeof req.query?.["ct"] === "string" ? (req.query["ct"] as string) : "";
      const resolved = await resolveVisit(ct);
      if ("error" in resolved) return json(resolved.status, { ok: false, error: resolved.error });
      return json(200, await view(resolved.visit));
    }
    if (req.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });

    const body = (req.body ?? {}) as Record<string, unknown>;
    const ct = typeof body["ct"] === "string" ? (body["ct"] as string) : "";
    const action = typeof body["action"] === "string" ? (body["action"] as string) : "";
    const resolved = await resolveVisit(ct);
    if ("error" in resolved) return json(resolved.status, { ok: false, error: resolved.error });
    const visit = resolved.visit;

    if (!EDITABLE.has(visit.report_status) && action !== "submit") {
      return json(409, { ok: false, error: "report_locked", report_status: visit.report_status });
    }

    if (action === "checklist") {
      const checklist = sanitizeChecklist(body["checklist"]);
      if (!checklist) return json(400, { ok: false, error: "invalid_checklist" });
      // Keep the server-stamped submission time out of cleaner control.
      if (visit.checklist?.submitted_at) checklist.submitted_at = visit.checklist.submitted_at;
      const ok = await dbUpdate("gh_visits", `id=eq.${visit.id}`, {
        checklist,
        report_status: visit.report_status === "none" ? "draft" : visit.report_status,
      });
      if (!ok) return json(502, { ok: false, error: "db_error" });
      return json(200, { ok: true });
    }

    if (action === "photo_sign") {
      const room = typeof body["room"] === "string" ? (body["room"] as string).slice(0, 60) : "";
      const kind = body["kind"] === "before" ? "before" : "after";
      const rooms = (visit.checklist?.rooms ?? []).map((r) => r.name);
      if (!room || (!rooms.includes(room) && room !== "Other areas")) {
        return json(400, { ok: false, error: "invalid_room" });
      }
      const objectPath = `visits/${visit.id}/${roomSlug(room)}/${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 10)}.jpg`;
      const signed = await storageSignUpload(objectPath);
      if (!signed) return json(502, { ok: false, error: "storage_error" });
      return json(200, { ok: true, upload_url: signed.signedUrl, storage_path: objectPath, kind });
    }

    if (action === "photo_register") {
      const room = typeof body["room"] === "string" ? (body["room"] as string).slice(0, 60) : "";
      const kind = body["kind"] === "before" ? "before" : "after";
      const storagePath = typeof body["storage_path"] === "string" ? (body["storage_path"] as string) : "";
      if (!room || !storagePath.startsWith(`visits/${visit.id}/`)) {
        return json(400, { ok: false, error: "invalid_photo" });
      }
      // Server-side validation of the uploaded bytes (type + size): the
      // client uploads straight to Storage, so this is the first point
      // the server sees the file. Anything else is removed again.
      const info = await storageObjectInfo(storagePath);
      if (!info) return json(502, { ok: false, error: "storage_error" });
      if (!ALLOWED_PHOTO_TYPES.includes(info.contentType) || info.size <= 0 || info.size > MAX_PHOTO_BYTES) {
        await storageRemove(storagePath);
        return json(400, { ok: false, error: "invalid_photo_file" });
      }
      const existing = await photosOf(visit.id);
      if (existing.some((p) => p.storage_path === storagePath)) {
        return json(200, { ok: true, already: true });
      }
      if (existing.length >= 60) return json(400, { ok: false, error: "too_many_photos" });
      const note = typeof body["note"] === "string" ? (body["note"] as string).slice(0, 300) : null;
      const row = await dbInsert<PhotoRow>("gh_photos", {
        visit_id: visit.id,
        room,
        storage_path: storagePath,
        kind,
        note,
      });
      if (!row) return json(502, { ok: false, error: "db_error" });
      return json(200, { ok: true, photo_id: row.id });
    }

    if (action === "photo_delete") {
      const photoId = typeof body["photo_id"] === "string" ? (body["photo_id"] as string) : "";
      const photos = await photosOf(visit.id);
      const target = photos.find((p) => p.id === photoId);
      if (!target) return json(404, { ok: false, error: "photo_not_found" });
      await dbDelete("gh_photos", `id=eq.${target.id}&visit_id=eq.${visit.id}`);
      await storageRemove(target.storage_path);
      return json(200, { ok: true });
    }

    if (action === "submit") {
      if (visit.report_status === "submitted") {
        return json(200, { ok: true, already: true });
      }
      if (!EDITABLE.has(visit.report_status)) {
        return json(409, { ok: false, error: "report_locked", report_status: visit.report_status });
      }
      const checklist = sanitizeChecklist(body["checklist"]) ?? visit.checklist;
      const photos = await photosOf(visit.id);
      const missing = missingRooms(checklist, photos);
      if (missing.length > 0) {
        return json(400, { ok: false, error: "rooms_incomplete", missing });
      }
      checklist.submitted_at = new Date().toISOString();
      const ok = await dbUpdate("gh_visits", `id=eq.${visit.id}`, {
        checklist,
        report_status: "submitted",
        status: "report_submitted",
      });
      if (!ok) return json(502, { ok: false, error: "db_error" });
      await logEvent(visit.id, visit.booking_id, "cleaner", "report_submitted", {
        photos: photos.length,
        problem_note: checklist.problem_note ?? null,
      });
      const emailed = await sendOwnerEmail(
        `Report ready for review — ${visit.client_name ?? "client"}, ${visit.visit_date ?? ""}`,
        `The cleaner submitted the photo report for review.\n\nClient: ${visit.client_name ?? ""}\nDate: ${visit.visit_date ?? ""}\nPhotos: ${photos.length}\nCleaner note: ${checklist.problem_note ?? "—"}\n\nOpen the owner view to review and send it to the client.`,
      );
      if (!emailed) {
        await logEvent(visit.id, visit.booking_id, "system", "owner_email_failed", {
          what: "report_submitted",
        });
      }
      return json(200, { ok: true });
    }

    return json(400, { ok: false, error: "invalid_action" });
  } catch (err) {
    console.error(JSON.stringify({ requestId, step: "cleaner", error: err instanceof Error ? err.message : String(err) }));
    return json(500, { ok: false, error: "server_error" });
  }
}
