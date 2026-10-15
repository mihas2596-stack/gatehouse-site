import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CheckCircle, CreditCard, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import SEO from "@/components/SEO";

type Status = "idle" | "sending" | "error";

const SaveCard = () => {
  const [searchParams] = useSearchParams();
  const saved = searchParams.get("saved") === "1";
  const canceled = searchParams.get("canceled") === "1";

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<Status>("idle");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const errors: Record<string, string> = {};
    if (name.trim().length < 2) errors.name = "Enter your name.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
      errors.email = "Enter a valid email, like name@example.com.";
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setStatus("sending");
    try {
      const res = await fetch("/api/create-checkout-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), email: email.trim() }),
      });
      const data = (await res.json()) as { ok?: boolean; url?: string };
      if (res.ok && data.ok && typeof data.url === "string") {
        window.location.href = data.url;
        return;
      }
      setStatus("error");
    } catch {
      setStatus("error");
    }
  };

  return (
    <div className="page-shell min-h-[80vh] bg-background">
      <SEO
        url="https://www.gatehousehomecleaning.com/save-card"
        title="Save Your Card — $0 Today | Gatehouse Home Cleaning"
        description="Save your card to secure your booking. No charge today — we charge only after you approve your photo report."
        noindex
      />
      <div className="container max-w-xl py-12 text-center">
        {saved ? (
          <>
            <CheckCircle className="w-16 h-16 text-sage-foreground mx-auto mb-6" strokeWidth={1.5} aria-hidden="true" />
            <h1 className="font-heading text-3xl md:text-[44px] font-bold mb-4">Card saved</h1>
            <p className="text-lg text-foreground mb-6">
              Your card is on file. Nothing was charged today — we charge it only after you approve
              your photo report.
            </p>
            <Button variant="hero" size="lg" asChild>
              <Link to="/">Back to Home</Link>
            </Button>
          </>
        ) : (
          <>
            <CreditCard className="w-16 h-16 text-sage-foreground mx-auto mb-6" strokeWidth={1.5} aria-hidden="true" />
            <h1 className="font-heading text-3xl md:text-[44px] font-bold mb-4">
              Save your card — $0 today
            </h1>
            <p className="text-lg text-foreground mb-6">
              Your card secures your booking. We charge it only after you approve your photo report.
              No response within 24 hours counts as approval.
            </p>
            <div className="mb-8 rounded-xl bg-card p-6 text-left">
              <ul className="space-y-3 text-base leading-relaxed">
                <li className="flex gap-3">
                  <ShieldCheck className="w-5 h-5 mt-1 shrink-0 text-sage-foreground" aria-hidden="true" />
                  <span>No charge today — $0 now.</span>
                </li>
                <li className="flex gap-3">
                  <ShieldCheck className="w-5 h-5 mt-1 shrink-0 text-sage-foreground" aria-hidden="true" />
                  <span>Charged only after you approve the clean.</span>
                </li>
                <li className="flex gap-3">
                  <ShieldCheck className="w-5 h-5 mt-1 shrink-0 text-sage-foreground" aria-hidden="true" />
                  <span>Free cancellation up to 48 hours before your visit.</span>
                </li>
                <li className="flex gap-3">
                  <ShieldCheck className="w-5 h-5 mt-1 shrink-0 text-sage-foreground" aria-hidden="true" />
                  <span>
                    Card details are processed securely by Stripe. We never see or store your card number.
                  </span>
                </li>
              </ul>
            </div>
            {canceled && (
              <p className="mb-6 rounded-lg bg-muted p-4 text-sm text-muted-foreground">
                Card entry was canceled — nothing was saved or charged. You can try again below whenever
                you're ready.
              </p>
            )}
            <form onSubmit={submit} className="text-left space-y-4" noValidate>
              <div>
                <label htmlFor="sc-name" className="mb-1 block text-sm font-medium">
                  Full name
                </label>
                <input
                  id="sc-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full rounded-lg border border-input bg-background px-4 py-3 text-base"
                  autoComplete="name"
                />
                {fieldErrors.name && <p className="mt-1 text-sm text-destructive">{fieldErrors.name}</p>}
              </div>
              <div>
                <label htmlFor="sc-email" className="mb-1 block text-sm font-medium">
                  Email
                </label>
                <input
                  id="sc-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full rounded-lg border border-input bg-background px-4 py-3 text-base"
                  autoComplete="email"
                />
                {fieldErrors.email && <p className="mt-1 text-sm text-destructive">{fieldErrors.email}</p>}
              </div>
              {status === "error" && (
                <p className="rounded-lg bg-destructive/10 p-4 text-sm text-destructive">
                  Something went wrong starting the secure card entry. Please try again in a minute.
                </p>
              )}
              <Button type="submit" variant="hero" size="lg" className="w-full" disabled={status === "sending"}>
                {status === "sending" ? "Opening secure card entry…" : "Continue to secure card entry"}
              </Button>
              <p className="text-center text-xs text-muted-foreground">
                You'll enter your card on Stripe's secure page. $0 is charged today.
              </p>
            </form>
          </>
        )}
      </div>
    </div>
  );
};

export default SaveCard;
