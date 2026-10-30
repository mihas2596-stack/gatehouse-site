import { useState } from "react";
import { CheckCircle2, ThumbsUp, Flag, Camera, RotateCcw, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";

type DemoState = "idle" | "approved" | "issue";

const reportRooms = [
  {
    name: "Kitchen",
    checks: ["Counters and backsplash wiped", "Sink and fixtures cleaned", "Floors vacuumed and mopped"],
  },
  {
    name: "Bathroom",
    checks: ["Toilet and shower cleaned", "Mirror polished", "Floors vacuumed and mopped"],
  },
  {
    name: "Bedroom",
    checks: ["Surfaces dusted", "Bed neatly made", "Trash removed"],
  },
];

function RoomCard({ name, checks }: { name: string; checks: string[] }) {
  return (
    <div className="rounded-lg border border-border/70 bg-background p-3">
      <div className="flex items-center gap-3">
        <span className="flex h-12 w-12 shrink-0 flex-col items-center justify-center gap-0.5 rounded-md bg-peach/50 text-muted-foreground">
          <Camera className="h-4 w-4" aria-hidden="true" />
          <span className="text-xs font-medium uppercase tracking-wide">Photo</span>
        </span>
        <div className="min-w-0">
          <p className="text-base font-semibold text-sage-foreground">{name}</p>
          <ul className="mt-1 space-y-0.5">
            {checks.map((check) => (
              <li key={check} className="flex items-start gap-1.5 text-sm leading-snug text-foreground">
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
                <span>{check}</span>
              </li>
            ))}
          </ul>
        </div>
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
            This is what lands in your inbox after every visit — photos and the checklist, room by room.
          </p>

          <div className="mt-6 rounded-xl border border-border bg-card p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <p className="text-base font-bold text-sage-foreground">Visit report</p>
              <span className="rounded-full bg-peach px-2.5 py-1 text-sm font-bold uppercase tracking-wide text-foreground">
                Sample — demo, not a real report
              </span>
            </div>

            <div className="space-y-2">
              <RoomCard name={reportRooms[0].name} checks={reportRooms[0].checks} />
              {expanded && reportRooms.slice(1).map((room) => (
                <RoomCard key={room.name} name={room.name} checks={room.checks} />
              ))}
            </div>

            {!expanded ? (
              <Button
                variant="outline"
                size="lg"
                className="mt-4 w-full rounded-full"
                onClick={() => setExpanded(true)}
                aria-expanded="false"
              >
                View sample report <ChevronDown className="h-4 w-4" aria-hidden="true" />
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
                      In a real report, flagging an issue blocks the automatic charge for that visit. Missed checklist items are re-cleaned free within 72 hours.
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
