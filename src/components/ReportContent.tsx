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

export function ZoomablePhoto({ src, alt, children }: { src: string; alt: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
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
  }, [open ]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="block w-full text-left"
        onClick={() => setOpen(true)}
        aria-label={`Enlarge photo: ${alt}`}
      >
        {children}
      </button>
      {open && createPortal(
        <div
          className="fixed inset-0 z-[110] bg-black/90 flex items-center justify-center p-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
          role="dialog"
          aria-modal="true"
          aria-label={`Enlarged photo: ${alt}`}
          onClick={() => setOpen(false)}
        >
          <img
            src={src}
            alt={alt}
            className="max-w-full max-h-[85vh] object-contain rounded-lg"
            onClick={(e) => e.stopPropagation()}
          />
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

export function ReportContent({
  photoItems,
  checklist,
  renderPhoto,
}: {
  photoItems: ReportPhotoItem[];
  checklist?: ReportChecklistData | null;
  renderPhoto: (p: ReportPhotoItem, i: number) => ReactNode;
}) {
  const grouped = (photoItems ?? []).reduce<Record<string, ReportPhotoItem[]>>((acc, p) => {
    const key = p.room || "Your home";
    (acc[key] = acc[key] ?? []).push(p);
    return acc;
  }, {});
  const rooms = Object.entries(grouped);
  return (
    <>
      {rooms.length === 0 && (
        <p className="text-sm text-muted-foreground mb-3">No photos in this report yet.</p>
      )}
      {rooms.map(([room, items]) => (
        <div key={room} className="mb-4">
          <h3 className="font-semibold mb-2">{room}</h3>
          <div className="grid grid-cols-2 gap-2">
            {[...items]
              .sort((a, b) => (a.kind === "before" ? 0 : 1) - (b.kind === "before" ? 0 : 1))
              .map((p, i) => (
                <div key={i}>{renderPhoto(p, i)}</div>
              ))}
          </div>
        </div>
      ))}
      {checklist && <ReportChecklistView checklist={checklist} />}
    </>
  );
}
