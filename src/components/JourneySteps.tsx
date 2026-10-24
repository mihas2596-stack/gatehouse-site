// One shared 5-step journey strip (§4C): the same scheme on every page
// that talks about a booking, so the client always knows the current
// step and the next action. current: 0 request, 1 confirmed, 2 cleaning,
// 3 report, 4 review & payment.
const STEPS = ["Request", "Confirmed visit", "Cleaning", "Photo report", "Review & payment"];

export default function JourneySteps({ current }: { current: number }) {
  return (
    <ol className="mb-6 flex flex-wrap items-center gap-y-2 text-sm" aria-label="Your booking journey">
      {STEPS.map((label, i) => (
        <li key={label} className="flex items-center">
          {i > 0 && <span aria-hidden="true" className="mx-1.5 text-muted-foreground">→</span>}
          <span
            className={
              i === current
                ? "font-semibold text-primary underline decoration-2 underline-offset-4"
                : i < current
                  ? "text-foreground"
                  : "text-muted-foreground"
            }
          >
            {label}
          </span>
        </li>
      ))}
    </ol>
  );
}
