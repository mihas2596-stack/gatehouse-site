import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CheckCircle, CreditCard, AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import PaymentSummary from "@/components/PaymentSummary";
import SEO from "@/components/SEO";
import { formatDateLong, formatArrivalWindow } from "@/lib/utils";
import { trackFunnel } from "@/lib/measurement";

type BookingSummary = {
  first?: string; recurring?: string; service?: string; first_service?: string; date?: string;
  has_card?: string; card_confirmed?: string; card_brand?: string; card_last4?: string;
  booking_confirmed?: string; confirmed_date?: string; confirmed_window?: string;
  visit_state?: string; auto_charge_blocked?: string; confirm_by?: string;
};
type Status = "loading" | "ready" | "saved" | "pending" | "failed" | "unknown";

export default function SaveCard() {
  const [params] = useSearchParams();
  const bt = params.get("bt") ?? "";
  const sessionId = params.get("session_id") ?? "";
  const returning = params.get("saved") === "1";
  const [status, setStatus] = useState<Status>(bt || returning ? "loading" : "ready");
  const [booking, setBooking] = useState<BookingSummary | null>(null);
  const [entry, setEntry] = useState(params.get("mode") === "change");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    if (!bt && !returning) { setStatus("ready"); return; }
    if (returning && !sessionId) { setStatus("unknown"); return; }
    setStatus("loading");
    try {
      const response = await fetch(`/api/card-status?${new URLSearchParams({ ...(bt ? { bt } : {}), ...(sessionId ? { session_id: sessionId } : {}) })}`);
      const data = await response.json();
      if (response.ok === false || data.ok === false || (bt && !data.booking)) throw new Error("unknown");
      setBooking(data.booking ?? null);
      if (returning) {
        if (data.verified && data.status === "saved") { setStatus("saved"); setEntry(false); trackFunnel("gh_card_saved", { form_type: "quote" }); }
        else setStatus(data.status === "pending" ? "pending" : data.status === "failed" ? "failed" : "unknown");
      } else setStatus("ready");
    } catch { setStatus("unknown"); }
  }, [bt, sessionId, returning]);
  useEffect(() => { void load(); }, [load]);

  const confirm = async () => {
    if (busy || !bt) return;
    setBusy(true); setError("");
    try {
      const r = await fetch("/api/card-status", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bt, action: "confirm_card" }) });
      const data = await r.json();
      if (r.ok === false || !data.ok) throw new Error("not saved");
      setBooking((b) => ({ ...b, card_confirmed: "1" }));
      setStatus("saved"); trackFunnel("gh_card_saved", { form_type: "quote" });
    } catch { setError("We couldn't confirm your choice. Your request is saved. Please try again."); }
    finally { setBusy(false); }
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); if (busy) return;
    const fields: Record<string, string> = {};
    if (!bt) {
      if (name.trim().length < 2) fields.name = "Enter your name.";
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) fields.email = "Enter a valid email, like name@example.com.";
    }
    setErrors(fields); if (Object.keys(fields).length) return;
    setBusy(true); setError("");
    try {
      const r = await fetch("/api/create-checkout-session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(bt ? { bt } : { name: name.trim(), email: email.trim() }) });
      const data = await r.json();
      if (!r.ok || !data.ok || typeof data.url !== "string") throw new Error("checkout");
      window.location.href = data.url;
    } catch { setError("We couldn't open Stripe's secure page. Your request is saved — please try again."); setBusy(false); }
  };
  const cancelled = booking?.visit_state === "cancelled";
  const hasCard = booking?.has_card === "1";
  const chosen = booking?.card_confirmed === "1" || status === "saved";
  const confirmed = booking?.booking_confirmed === "1";
  const blocked = booking?.auto_charge_blocked === "1";
  const unknown = status === "unknown" || status === "pending" || status === "failed";
  const choice = status === "ready" && hasCard && !chosen && !entry;
  const done = !entry && (status === "saved" || (hasCard && chosen)) && !unknown;
  const showForm = !cancelled && !unknown && status !== "loading" && !done && (!hasCard || entry);
  const visitLink = `/visit?bt=${encodeURIComponent(bt)}`;
  const brand = booking?.card_brand?.replace(/\b\w/g, (c) => c.toUpperCase()) || "Card";
  return (
    <div className="page-shell readable-flow min-h-[80vh] bg-background">
      <SEO url="https://www.gatehousehomecleaning.com/save-card" title="Choose Your Card — $0 Today | Gatehouse Home Cleaning" description="Choose a card for your visit through Stripe. No charge for saving or updating your card." noindex />
      <div className="container max-w-xl py-10 pb-24 text-center md:pb-12">
        {status === "loading" ? <>
          <Loader2 className="mx-auto mb-6 h-12 w-12 animate-spin" aria-hidden="true" />
          <h1 className="font-heading text-3xl font-bold">Checking your card…</h1>
          <p className="mt-4">Please wait while we check the status of this visit.</p>
        </> : cancelled ? <>
          <h1 className="font-heading text-3xl font-bold">This visit is cancelled</h1>
          <p className="my-6">You don't need to save a card for this visit.</p>
          <Button asChild variant="outline"><Link to={visitLink}>View my visit</Link></Button>
        </> : unknown ? <>
          <AlertTriangle className="mx-auto mb-6 h-12 w-12" aria-hidden="true" />
          {status === "failed" ? <>
            <h1 className="font-heading text-3xl font-bold">Card not saved</h1>
            <p className="my-6">You can try again on Stripe. Saving a card costs $0 today.</p>
            <Button variant="hero" size="lg" onClick={() => {
              setEntry(hasCard);
              setStatus("ready");
              setError("");
            }}>Try card entry again</Button>
          </> : <>
            <h1 className="font-heading text-3xl font-bold">{status === "pending" ? "Checking your card" : "Couldn't verify card"}</h1>
            <p className="my-6">{status === "pending" ? "Stripe is still processing your card setup. Check again in a moment." : "Check your card status again before re-entering your details."}</p>
            <Button variant="hero" size="lg" onClick={() => void load()}>Check again</Button>
          </>}
          {done && !bt && <Button asChild variant="hero" size="lg"><Link to="/quote">See price & request a cleaning</Link></Button>}
          {bt && <p className="mt-6"><Link className="underline" to={visitLink}>View my visit</Link></p>}
        </> : <>
          {done ? <CheckCircle className="mx-auto mb-6 h-12 w-12 text-sage-foreground" aria-hidden="true" /> : <CreditCard className="mx-auto mb-6 h-12 w-12 text-sage-foreground" aria-hidden="true" />}
          <h1 className="font-heading text-3xl font-bold mb-4">{entry ? "Add a different card — $0 today" : choice ? "Choose a card for this visit" : done ? "Card saved — $0 charged today" : "Last step: save your card — $0 today"}</h1>
          {done && (
            <p className="mt-2 mb-4 text-base font-semibold text-foreground">
              Card: saved ✓ · Visit: {!bt ? "not requested yet" : confirmed ? `confirmed for ${formatDateLong(booking?.confirmed_date)}` : "awaiting confirmation"}
            </p>
          )}
          <p className="text-lg mb-6">{entry ? "Update your payment method securely through Stripe. Saving a different card does not change your visit or charge you today." : choice ? "A card saved earlier is used for this booking only after you choose it. Nothing is charged today." : done ? !bt ? "Your payment method is saved. To request a cleaning, choose your service and date below." : confirmed ? `Your cleaning is confirmed for ${formatDateLong(booking?.confirmed_date)}${booking?.confirmed_window ? ` · ${formatArrivalWindow(booking.confirmed_window)}` : ""}.` : `Your date is awaiting confirmation. We'll email your cleaner and arrival window ${booking?.confirm_by ? `by ${booking.confirm_by}` : "within one business day"}.` : bt ? "Save a card for this visit through Stripe. The card alone does not confirm your date." : "Save a payment method through Stripe. This page alone does not create a cleaning request."}</p>
          {booking && <dl className="rounded-xl border border-border bg-card p-5 text-left space-y-3 mb-6">
            {booking.service && <div><dt className="font-semibold">Service</dt><dd>{booking.service}</dd></div>}
            {(booking.confirmed_date || booking.date) && <div><dt className="font-semibold">{confirmed ? "Confirmed date" : "Requested date"}</dt><dd>{formatDateLong(booking.confirmed_date || booking.date)}</dd></div>}
            {booking.first && <div><dt className="font-semibold">This visit</dt><dd>${booking.first}</dd></div>}
            {hasCard && <div><dt className="font-semibold">Card on file</dt><dd>{brand}{booking.card_last4 ? ` ••••${booking.card_last4}` : ""}</dd></div>}
            <div><dt className="font-semibold">Due today</dt><dd>$0</dd></div>
          </dl>}
          {blocked && <p role="status" className="rounded-xl bg-sage/15 p-5 mb-6 text-left">Automatic payment is blocked for this visit because an issue was reported. Updating your card does not restart it. You choose when to approve your report and pay.</p>}
          {error && <p role="alert" className="mb-4 rounded-lg bg-destructive/10 p-4">{error}</p>}
          {choice && <Button variant="hero" size="lg" className="w-full mb-3" disabled={busy} onClick={() => void confirm()}>{busy ? "Confirming…" : "Use this card for this booking — $0 today"}</Button>}
          {hasCard && !entry && <Button variant="outline" size="lg" className="w-full mb-4" onClick={() => setEntry(true)}>Add a different card</Button>}
          {showForm && <>
            {!blocked && <div className="mb-6"><PaymentSummary showCard /></div>}
            {params.get("canceled") === "1" && <p className="mb-6">Card entry was cancelled. You can try again when you're ready.</p>}
            <form onSubmit={submit} className="text-left space-y-4" noValidate>
              {!bt && <>
                <div><label className="block font-medium mb-1" htmlFor="sc-name">Full name</label><input className="w-full rounded-lg border p-3 text-base" id="sc-name" value={name} autoComplete="name" onChange={(e) => setName(e.target.value)} aria-invalid={!!errors.name} aria-describedby={errors.name ? "sc-name-error" : undefined} />{errors.name && <p id="sc-name-error" className="text-destructive">{errors.name}</p>}</div>
                <div><label className="block font-medium mb-1" htmlFor="sc-email">Email</label><input className="w-full rounded-lg border p-3 text-base" id="sc-email" type="email" value={email} autoComplete="email" onChange={(e) => setEmail(e.target.value)} aria-invalid={!!errors.email} aria-describedby={errors.email ? "sc-email-error" : undefined} />{errors.email && <p id="sc-email-error" className="text-destructive">{errors.email}</p>}</div>
              </>}
              <Button type="submit" variant="hero" size="lg" className="w-full" disabled={busy}>{busy ? "Opening Stripe's secure page…" : "Add card — $0 today"}</Button>
              <p className="text-base text-muted-foreground text-center">You'll enter your card securely on Stripe. No Link account is required.</p>
            </form>
          </>}
          {done && !bt && <Button asChild variant="hero" size="lg"><Link to="/quote">See price & request a cleaning</Link></Button>}
          {bt && <p className="mt-6"><Link to={visitLink} className="underline font-semibold">View my visit</Link></p>}
        </>}
      </div>
    </div>
  );
}
