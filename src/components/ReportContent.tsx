import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

// V4: one shared report body for /visit (embedded section) and /report
// (standalone page). The CONTENT never changes with state — only the
// actions around it do — so a paid report shows the same photos and
// checklist as an awaiting one.
//
// Photo tiles are zoomable on both pages through ZoomablePhoto: the
// dialog is portaled to <body> so it sits above the fixed header
// (z-110 vs the header's z-100) — a global `isolation: isolate` on
// main/section/footer caps any in-page dialog below the header,
// so no z-index inside the page can win; the portal escapes it.
// has a 44px Close button, closes on Escape or backdrop tap, locks
// body scroll while open, and returns focus to the thumbnail that
// opened it.

export type ReportPhotoItem = {
  url: string;
  thumb_url?: string | null;
  room?: string;
  note?: string;
  kind?: string;
};

export type ReportChecklistData = {
  rooms: Array<{
    name: string;
    items: Array<{ label: string; done: boolean }>;
    skip_reason?: string;
  }>;
  problem_note?: string;
};

export function ZoomablePhoto({ src, alt, children, photos, index }: {
  src: string;
  alt: string;
  children: ReactNode;
  // Cabinets audit (fix 5): when the full photo list is passed, the
  // dialog gains Previous / Next and a counter (room + Before/After
  // travel in the alt text). Without it, the dialog stays single-frame.
  photos?: Array<{ src: string; alt: string }>;
  index?: number;
}) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState(0);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  const hasNav = Boolean(photos && photos.length > 1 && typeof index === "number");
  const currentPhoto = hasNav && photos ? photos[current] ?? { src, alt } : { src, alt };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
      if (hasNav && photos) {
        if (e.key === "ArrowRight") setCurrent((c) => Math.min(c + 1, photos.length - 1));
        if (e.key === "ArrowLeft") setCurrent((c) => Math.max(c - 1, 0));
      }
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      triggerRef.current?.focus();
    };
  }, [open, hasNav, photos]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="block w-full text-left"
        onClick={() => { setCurrent(index ?? 0); setOpen(true); }}
        aria-label={`Enlarge photo: ${alt}`}
      >
        {children}
      </button>
      {open && createPortal(
        <div
          className="fixed inset-0 z-[110] bg-black/90 flex flex-col items-center justify-center p-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
          role="dialog"
          aria-modal="true"
          aria-label={`Enlarged photo: ${currentPhoto.alt}`}
          onClick={() => setOpen(false)}
        >
          <img
            src={currentPhoto.src}
            alt={currentPhoto.alt}
            className="max-w-full max-h-[75vh] object-contain rounded-lg"
            onClick={(e) => e.stopPropagation()}
          />
          {hasNav && photos && (
            <p className="text-white text-sm mt-3 text-center">
              Photo {current + 1} of {photos.length} — {currentPhoto.alt}
            </p>
          )}
          {hasNav && photos && (
            <div className="flex items-center gap-3 mt-3" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                aria-label="Previous photo"
                disabled={current === 0}
                className="min-h-[44px] min-w-[44px] px-4 rounded-lg bg-white text-black text-sm font-semibold disabled:opacity-40"
                onClick={() => setCurrent((c) => Math.max(c - 1, 0))}
              >
                Previous
              </button>
              <button
                type="button"
                aria-label="Next photo"
                disabled={current === photos.length - 1}
                className="min-h-[44px] min-w-[44px] px-4 rounded-lg bg-white text-black text-sm font-semibold disabled:opacity-40"
                onClick={() => setCurrent((c) => Math.min(c + 1, photos.length - 1))}
              >
                Next
              </button>
            </div>
          )}
          <button
            ref={closeRef}
            type="button"
            aria-label="Close enlarged photo"
            className="absolute top-4 right-4 min-h-[44px] min-w-[44px] px-3 rounded-lg bg-white text-black text-sm font-semibold"
            onClick={() => setOpen(false)}
          >
            Close
          </button>
        </div>,
        document.body
      )}
    </>
  );
}

// Checklist with a visible legend: symbols alone don't explain
// themselves, and an unfilled item must never read as done.
export function ReportChecklistView({ checklist }: { checklist: ReportChecklistData }) {
  if (!checklist || checklist.rooms.length === 0) return null;
  return (
    <div className="mb-4">
      <h3 className="font-semibold mb-2">What was done</h3>
      <p className="text-sm text-muted-foreground mb-2">
        <span aria-hidden="true">✓ Done · ○ Not done</span>
        <span className="sr-only">Checklist legend: checkmark means done, circle means not done.</span>
      </p>
      {checklist.rooms.map((r) => (
        <div key={r.name} className="mb-2">
          <p className="text-sm font-semibold">
            {r.name}
            {r.skip_reason ? <span className="font-normal text-muted-foreground"> — skipped: {r.skip_reason}</span> : null}
          </p>
          <ul className="pl-5 text-sm">
            {r.items.map((it, i) => (
              <li key={i} className={`list-none ${it.done ? "" : "text-muted-foreground"}`}>
                <span aria-hidden="true">{it.done ? "✓ " : "○ "}</span>
                <span className="sr-only">{it.done ? "Done: " : "Not done: "}</span>
                {it.label}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {checklist.problem_note && (
        <p className="mt-2 text-sm text-muted-foreground">Cleaner&apos;s note: {checklist.problem_note}</p>
      )}
    </div>
  );
}

export type ReportPhotoNavContext = {
  // Position of this photo in the whole report, in display order.
  index: number;
  total: number;
  // Full-size list for the lightbox Previous / Next (alt carries room
  // + Before/After). Photos without a URL are left out.
  photos: Array<{ src: string; alt: string }>;
  // Caption for the grid tile: "Before" / "After", plus a frame
  // number when several photos in the room share the same stage.
  frameLabel: string;
};

export function ReportContent({
  photoItems,
  checklist,
  excludedRooms,
  renderPhoto,
}: {
  photoItems: ReportPhotoItem[];
  checklist?: ReportChecklistData | null;
  excludedRooms?: string[];
  renderPhoto: (p: ReportPhotoItem, i: number, ctx: ReportPhotoNavContext) => ReactNode;
}) {
  const grouped = (photoItems ?? []).reduce<Record<string, ReportPhotoItem[]>>((acc, p) => {
    const key = p.room || "Your home";
    (acc[key] = acc[key] ?? []).push(p);
    return acc;
  }, {});
  const rooms = Object.entries(grouped);
  const shown = new Set(rooms.map(([r]) => r.toLowerCase()));
  const excluded = (excludedRooms ?? [])
    .map((r) => r.trim())
    .filter((r) => r && !shown.has(r.toLowerCase()));
  // Flat display order (room order, before before after) — the
  // lightbox navigates this list, and the counter reads from it.
  const sortedRooms = rooms.map(([room, items]) => ({
    room,
    items: [...items].sort((a, b) => (a.kind === "before" ? 0 : 1) - (b.kind === "before" ? 0 : 1)),
  }));
  const flat: Array<{ p: ReportPhotoItem; room: string; alt: string }> = [];
  for (const { room, items } of sortedRooms) {
    for (const p of items) {
      if (!p.url) continue;
      flat.push({ p, room, alt: `${room} — ${p.kind === "before" ? "before" : "after"} cleaning` });
    }
  }
  const flatIndex = new Map<ReportPhotoItem, number>();
  flat.forEach((f, i) => flatIndex.set(f.p, i));
  return (
    <>
      {rooms.length === 0 && (
        <p className="text-sm text-muted-foreground mb-3">No photos in this report yet.</p>
      )}
      {excluded.length > 0 && (
        <div className="mb-4">
          <h3 className="font-semibold mb-2">Not photographed</h3>
          <p className="text-sm text-muted-foreground">
            You asked us not to photograph: {excluded.join(", ")}. No photos were taken in these rooms.
          </p>
        </div>
      )}
      {sortedRooms.map(({ room, items }) => (
        <div key={room} className="mb-4">
          <h3 className="font-semibold mb-2">{room}</h3>
          <div className="grid grid-cols-2 gap-2">
            {items.map((p, i) => {
              const sameStage = items.filter((x) => x.kind === p.kind);
              const n = sameStage.indexOf(p) + 1;
              const stage = p.kind === "before" ? "Before" : "After";
              const frameLabel = sameStage.length > 1 ? `${stage} · ${n} of ${sameStage.length}` : stage;
              const ctx: ReportPhotoNavContext = {
                index: flatIndex.get(p) ?? 0,
                total: flat.length,
                photos: flat.map((f) => ({ src: f.p.url as string, alt: f.alt })),
                frameLabel,
              };
              return (
                <div key={i}>{renderPhoto(p, i, ctx)}</div>
              );
            })}
          </div>
        </div>
      ))}
      {checklist && <ReportChecklistView checklist={checklist} />}
    </>
  );
}
