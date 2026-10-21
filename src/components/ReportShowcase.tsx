import { useState } from "react";
import { CheckCircle2, ThumbsUp, Flag, Camera, RotateCcw } from "lucide-react";
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

const steps = [
  {
    title: "We send the report",
    text: "After every visit you get a photo report — room by room, with the checklist we followed.",
  },
  {
    title: "You review within 24 hours",
    text: "Approve it, or flag anything we missed. Your card is charged on approval — or automatically 24 hours after the report if you don't flag an issue.",
  },
  {
    title: "An issue pauses the charge",
    text: "Flagged something? Your card isn't charged until we've fixed it — missed checklist items are re-cleaned free within 72 hours.",
  },
];

function RoomCard({ name, checks }: { name: string; checks: string[] }) {
  return (
    <div className="rounded-lg border border-border/70 bg-background p-2.5">
      <div className="flex items-center gap-2">
        <span className="flex h-14 w-14 shrink-0 flex-col items-center justify-center gap-0.5 rounded-md bg-peach/50 text-muted-foreground">
          <Camera className="h-4 w-4" aria-hidden="true" />
          <span className="text-[8px] font-medium uppercase tracking-wide">Illustration</span>
        </span>
        <div className="min-w-0">
          <p className="text-xs font-semibold text-sage-foreground">{name}</p>
          <ul className="mt-1 space-y-0.5">
            {checks.map((check) => (
              <li key={check} className="flex items-start gap-1 text-[10px] leading-tight text-foreground">
                <CheckCircle2 className="mt-px h-3 w-3 shrink-0 text-primary" aria-hidden="true" />
                <span>{check}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function PhoneDemo() {
  const [state, setState] = useState<DemoState>("idle");

  return (
    <div className="mx-auto w-full max-w-[300px]">
      <div className="rounded-[2.2rem] border-[10px] border-sage-foreground/90 bg-card shadow-warm-lg">
        <div className="flex flex-col gap-2.5 p-3">
          <div className="text-center">
            <p className="text-xs font-bold text-sage-foreground">Visit report</p>
            <p className="text-[10px] text-muted-foreground">Every-other-week clean · Sample</p>
          </div>

          <div className="space-y-2">
            {reportRooms.map((room) => (
              <RoomCard key={room.name} name={room.name} checks={room.checks} />
            ))}
          </div>

          {state === "idle" && (
            <div className="pt-1">
              <p className="mb-2 text-center text-[10px] font-medium text-muted-foreground">
                Try it — this is a demo
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  className="min-h-[40px] flex-1 rounded-full text-xs"
                  onClick={() => setState("approved")}
                >
                  <ThumbsUp className="h-3.5 w-3.5" aria-hidden="true" /> Approve
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="min-h-[40px] flex-1 rounded-full text-xs"
                  onClick={() => setState("issue")}
                >
                  <Flag className="h-3.5 w-3.5" aria-hidden="true" /> Report an issue
                </Button>
              </div>
            </div>
          )}

          {state === "approved" && (
            <div className="rounded-lg bg-primary/10 p-3 text-center">
              <ThumbsUp className="mx-auto h-5 w-5 text-primary" aria-hidden="true" />
              <p className="mt-1 text-xs font-bold text-sage-foreground">Approved — card charged.</p>
              <p className="mt-0.5 text-[10px] text-muted-foreground">Thank you! See you in two weeks.</p>
              <button
                type="button"
                onClick={() => setState("idle")}
                className="mt-2 inline-flex items-center gap-1 text-[10px] font-medium text-primary underline"
              >
                <RotateCcw className="h-3 w-3" aria-hidden="true" /> Reset demo
              </button>
            </div>
          )}

          {state === "issue" && (
            <div className="rounded-lg bg-peach/40 p-3 text-center">
              <Flag className="mx-auto h-5 w-5 text-primary" aria-hidden="true" />
              <p className="mt-1 text-xs font-bold text-sage-foreground">
                We&apos;ll fix it free within 72 hours.
              </p>
              <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
                Email a photo to hello@gatehousehomecleaning.com within 24 hours after your report is sent.
              </p>
              <button
                type="button"
                onClick={() => setState("idle")}
                className="mt-2 inline-flex items-center gap-1 text-[10px] font-medium text-primary underline"
              >
                <RotateCcw className="h-3 w-3" aria-hidden="true" /> Reset demo
              </button>
            </div>
          )}
        </div>
      </div>
      <p className="mt-2 text-center text-[11px] text-muted-foreground">
        Sample report shown for illustration.
      </p>
    </div>
  );
}

const ReportShowcase = () => (
  <section className="border-b border-border/60 bg-background py-8 md:py-10" aria-label="See how your clean is documented">
    <div className="container">
      <div className="mx-auto grid max-w-5xl grid-cols-1 items-center gap-8 md:grid-cols-2 md:gap-12">
        <PhoneDemo />
        <div className="text-center md:text-left">
          <p className="eyebrow mb-2 text-primary">Approve, then pay</p>
          <h2 className="font-heading text-2xl font-bold text-sage-foreground md:text-heading-secondary">
            See how your clean is documented
          </h2>
          <p className="mt-3 text-base leading-relaxed text-foreground md:text-lg">
            This is what lands in your inbox after every visit — photos and the checklist,
            room by room. Your card is charged when you approve the report, or automatically
            24 hours after we send it if you haven't reported an issue.
          </p>
          <ol className="mt-5 space-y-4 text-left">
            {steps.map(({ title, text }, i) => (
              <li key={title} className="flex items-start gap-3">
                <span
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary font-heading text-sm font-bold text-primary-foreground"
                  aria-hidden="true"
                >
                  {i + 1}
                </span>
                <div>
                  <p className="font-semibold text-sage-foreground">{title}</p>
                  <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">{text}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  </section>
);

export default ReportShowcase;
