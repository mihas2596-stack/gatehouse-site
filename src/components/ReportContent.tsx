import type { ReactNode } from "react";

// V4: one shared report body for /visit (embedded section) and /report
// (standalone page). The CONTENT never changes with state — only the
// actions around it do — so a paid report shows the same photos and
// checklist as an awaiting one. Each page supplies its own photo tile
// (Visit: plain image; Report: zoom + load-failure fallback).
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
      {checklist && checklist.rooms.length > 0 && (
        <div className="mb-4">
          <h3 className="font-semibold mb-2">What was done</h3>
          {checklist.rooms.map((r) => (
            <div key={r.name} className="mb-2">
              <p className="text-sm font-semibold">
                {r.name}
                {r.skip_reason ? <span className="font-normal text-muted-foreground"> — skipped: {r.skip_reason}</span> : null}
              </p>
              <ul className="pl-5 text-sm">
                {r.items.map((it, i) => (
                  <li key={i} className="list-none">
                    <span aria-hidden="true">{it.done ? "✓ " : "○ "}</span>
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
      )}
    </>
  );
}
