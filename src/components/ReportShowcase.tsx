import { useState } from "react";
import { CheckCircle2, Circle, ThumbsUp, Flag, RotateCcw, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import bedroomPhoto from "@/assets/hero-real-bedroom.webp";

type DemoState = "idle" | "approved" | "issue";

type DemoCheck = { label: string; done: boolean; note?: string };

// One room carries a real Gatehouse photo to show the room → photo →
// status → note shape of a real report; the other rooms honestly say
// where their photos appear in a real report. Nothing here is a real
// visit: the whole block is marked Sample/Demo throughout.
const reportRooms: { name: string; photo?: { src: string; alt: string; caption: string }; checks: DemoCheck[] }[] = [
  {
    name: "Bedroom",
    photo: { src: bedroomPhoto, alt: "Freshly cleaned bedroom — real photo from a Gatehouse clean", caption: "Real photo from a Gatehouse clean (sample)." },
    checks: [
      { label: "Surfaces dusted", done: true },
      { label: "Bed neatly made", done: true },
      { label: "Trash removed", done: false, note: "Sample note: left as shown in this example." },
    ],
  },
  {
    name: "Kitchen",
    checks: [
      { label: "Counters and backsplash wiped", done: true },
      { label: "Sink and fixtures cleaned", done: true },
      { label: "Floors vacuumed and mopped", done: true },
    ],
  },
  {
    name: "Bathroom",
    checks: [
      { label: "Toilet and shower cleaned", done: true },
      { label: "Mirror polished", done: true },
      { label: "Floors vacuumed and mopped", done: true },
    ],
  },
];

function RoomCard({ name, photo, checks }: { name: string; photo?: { src: string; alt: string; caption: string }; checks: DemoCheck[] }) {
  return (
    <div className="rounded-lg border border-border/70 bg-background p-3">
      <div className="min-w-0">
          <p className="text-base font-semibold text-sage-foreground">{name}</p>
          {photo ? (
            <figure className="mt-2">
              <img src={photo.src} alt={photo.alt} loading="lazy" className="h-40 w-full rounded-lg object-cover" />
              <figcaption className="mt-1 text-xs text-muted-foreground">{photo.caption}</figcaption>
            </figure>
          ) : (
            <p className="mt-1 text-sm text-muted-foreground">Sample checklist shown — a real report also has before and after photos for each room.</p>
          )}
          <ul className="mt-2 space-y-1">
            {checks.map((check) => (
              <li key={check.label} className="text-sm leading-snug text-foreground">
                <span className="flex items-start gap-1.5">
                  {check.done ? (
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
                  ) : (
                    <Circle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  )}
                  <span>{check.label} — <strong>{check.done ? "Done" : "Not done"}</strong></span>
                </span>
                {check.note && <span className="mt-0.5 block pl-5 text-sm text-muted-foreground">{check.note}</span>}
              </li>
            ))}
          </ul>
      </div>
    </div>
  );
}

/**
 * Compact sample report: one room preview + an explicit "View sample
 * report" action. The full demo opens on demand — it is marked Sample/Demo
 * throughout, and its buttons are labeled demo actions that send nothing.
 */
const ReportShowcase = () => {
  const [expanded, setExpanded] = useState(false);
  const [state, setState] = useState<DemoState>("idle");

  return (
    <section className="border-b border-border/60 bg-background py-8 md:py-10" aria-label="Sample report">
      <div className="container">
        <div className="mx-auto max-w-2xl">
          <h2 className="text-center font-heading text-2xl font-bold text-sage-foreground md:text-heading-secondary">
            See a sample report
          </h2>
          <p className="mt-3 text-center text-base leading-relaxed text-foreground">
            This is the shape of the report you get after every visit — rooms, photos, and a checklist marked Done or Not done, with a note for anything not done.
          </p>

          <div className="mt-6 rounded-xl border border-border bg-card p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <p className="text-base font-bold text-sage-foreground">Visit report</p>
              <span className="rounded-full bg-peach px-2.5 py-1 text-sm font-bold uppercase tracking-wide text-foreground">
                SAMPLE — DEMO ONLY
              </span>
            </div>

            <div className="space-y-2">
              <RoomCard name={reportRooms[0].name} photo={reportRooms[0].photo} checks={reportRooms[0].checks} />
              {expanded && reportRooms.slice(1).map((room) => (
                <RoomCard key={room.name} name={room.name} photo={room.photo} checks={room.checks} />
              ))}
            </div>
            <p className="mt-3 text-sm text-muted-foreground">In a real report, every item is marked ✓ Done or ○ Not done, with a note for anything not done.</p>

            {!expanded ? (
              <Button
                variant="outline"
                size="lg"
                className="mt-4 w-full rounded-full"
                onClick={() => setExpanded(true)}
                aria-expanded="false"
              >
                Show all rooms <ChevronDown className="h-4 w-4" aria-hidden="true" />
              </Button>
            ) : (
              <>
                {state === "idle" && (
                  <div className="pt-4">
                    <p className="mb-3 text-center text-sm font-medium text-muted-foreground">
                      Try the demo actions below — they send nothing.
                    </p>
                    <div className="flex gap-2">
                      <Button
                        size="lg"
                        className="min-h-[48px] flex-1 rounded-full"
                        onClick={() => setState("approved")}
                      >
                        <ThumbsUp className="h-4 w-4" aria-hidden="true" /> Approve (demo)
                      </Button>
                      <Button
                        size="lg"
                        variant="outline"
                        className="min-h-[48px] flex-1 rounded-full"
                        onClick={() => setState("issue")}
                      >
                        <Flag className="h-4 w-4" aria-hidden="true" /> Report an issue (demo)
                      </Button>
                    </div>
                  </div>
                )}

                {state === "approved" && (
                  <div className="mt-4 rounded-lg bg-primary/10 p-4 text-center">
                    <ThumbsUp className="mx-auto h-5 w-5 text-primary" aria-hidden="true" />
                    <p className="mt-1 text-base font-bold text-sage-foreground">Demo only — no payment was taken.</p>
                    <p className="mt-0.5 text-sm text-muted-foreground">In a real report, approving charges your saved card.</p>
                    <button
                      type="button"
                      onClick={() => setState("idle")}
                      className="mt-2 inline-flex min-h-[44px] items-center gap-1 text-sm font-medium text-primary underline"
                    >
                      <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> Reset demo
                    </button>
                  </div>
                )}

                {state === "issue" && (
                  <div className="mt-4 rounded-lg bg-peach/40 p-4 text-center">
                    <Flag className="mx-auto h-5 w-5 text-primary" aria-hidden="true" />
                    <p className="mt-1 text-base font-bold text-sage-foreground">
                      Demo only — no payment was taken.
                    </p>
                    <p className="mt-0.5 text-sm leading-snug text-muted-foreground">
                      In a real report, flagging an issue blocks the automatic charge for that visit. Missed checklist items are re-cleaned free within 72 hours after you report them. After the fix, you approve the report again to pay — the automatic charge never resumes on its own.
                    </p>
                    <button
                      type="button"
                      onClick={() => setState("idle")}
                      className="mt-2 inline-flex min-h-[44px] items-center gap-1 text-sm font-medium text-primary underline"
                    >
                      <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> Reset demo
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
          <p className="mt-2 text-center text-sm text-muted-foreground">
            Sample report shown for illustration.
          </p>
        </div>
      </div>
    </section>
  );
};

export default ReportShowcase;
