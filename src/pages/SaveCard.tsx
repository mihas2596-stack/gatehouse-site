import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CheckCircle, CreditCard, AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import PaymentSummary from "@/components/PaymentSummary";
import SEO from "@/components/SEO";
import { formatDateLong, formatArrivalWindow } from "@/lib/utils";
import { trackFunnel } from "@/lib/measurement";
import { resolveLinkToken } from "@/lib/tokenStrip";

type SavedCardOption = { id: string; brand: string; last4: string; exp_month?: number; exp_year?: number };
type BookingSummary = {
  first?: string; recurring?: string; service?: string; first_service?: string; date?: string;
  has_card?: string; card_confirmed?: string; card_brand?: string; card_last4?: string;
  booking_confirmed?: string; confirmed_date?: string; confirmed_window?: string;
  visit_state?: string; auto_charge_blocked?: string; confirm_by?: string;
  cards?: SavedCardOption[];
};
type Status = "loading" | "ready" | "saved" | "pending" | "failed" | "unknown";

const fmtMoney = (v?: string): string => {
  const n = v ? parseFloat(v.replace(/[^0-9.]/g, "")) : NaN;
  if (!Number.isFinite(n)) return v ? `$${v}` : "";
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
};

export default function SaveCard() {
  const [params] = useSearchParams();
  const [setupAttempt] = useState(() => globalThis.crypto?.randomUUID?.());
  // One-time link token: resolved from the URL once, then stripped from
  // the address bar so it never reaches analytics (see tokenStrip.ts).
  const [bt] = useState<string>(() => resolveLinkToken("bt", "gh_visit_bt", params.toString()));
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
  const [selectedCard, setSelectedCard] = useState("");
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
        if (data.verified && data.status === "saved") { setStatus("saved"); setEntry(false); trackFunnel("gh_card_saved", { form_type: "quote" }, bt || sessionId); }
        else setStatus(data.status === "pending" ? "pending" : data.status === "failed" ? "failed" : "unknown");
      } else setStatus("ready");
    } catch { setStatus("unknown"); }
  }, [bt, sessionId, returning]);
  useEffect(() => { void load(); }, [load]);

  const confirm = async () => {
    if (busy || !bt) return;
    setBusy(true); setError("");
    try {
      const r = await fetch("/api/card-status", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bt, action: "confirm_card", ...(selectedCard ? { payment_method_id: selectedCard } : {}) }) });
      const data = await r.json();
      if (r.ok === false || !data.ok) {
        // The chosen card disappeared between the list and the
        // confirm (deleted, or moved): re-read the list and say so.
        if (data?.error === "card_unavailable") {
          setError("This card is no longer available. Choose another card or add a new one.");
          setSelectedCard("");
          await load();
          return;
        }
        throw new Error("not saved");
      }
      setBooking((b) => ({ ...b, card_confirmed: "1", ...(data.card_brand ? { card_brand: data.card_brand } : {}), ...(data.card_last4 ? { card_last4: data.card_last4 } : {}) }));
      setStatus("saved"); trackFunnel("gh_card_saved", { form_type: "quote" }, bt);
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
      const r = await fetch("/api/create-checkout-session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(bt ? { bt, request_id: setupAttempt } : { name: name.trim(), email: email.trim() }) });
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
  const awaitingConfirmation = done && Boolean(bt) && !confirmed;
  const showForm = !cancelled && !unknown && status !== "loading" && !done && (!hasCard || entry);
  const visitLink = `/visit?bt=${encodeURIComponent(bt)}`;
  // Item 6: never render "Card" without digits — an unidentified saved
  // card is not a choice, it is the ambiguous state.
  const brand = booking?.card_brand?.replace(/\b\w/g, (c) => c.toUpperCase()) || "";
  const cardIdentified = Boolean(brand && booking?.card_last4);
  const cardOptions = booking?.cards ?? [];
  const cardLabel = cardIdentified ? `${brand} ending in ••••${booking?.card_last4}` : "";
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
          <h1 className="font-heading text-3xl font-bold mb-4">{entry ? "Save a card for this visit" : choice ? "Choose a card for this visit" : awaitingConfirmation ? "Cleaning request received" : done ? "Card saved" : "Save a card for this visit"}</h1>
          {done && (
            <p className="mt-2 mb-4 text-base font-semibold text-foreground">
              Card saved. $0 charged today.
            </p>
          )}
          {done && !awaitingConfirmation && (
            <p className="mt-2 mb-4 text-base font-semibold text-foreground">
              Card: saved ✓ · Visit: {!bt ? "not requested yet" : `confirmed for ${formatDateLong(booking?.confirmed_date)}`}
            </p>
          )}
          {awaitingConfirmation ? (
            <p className="mb-6 text-lg leading-relaxed"><strong>No action needed right now.</strong> We’re arranging your visit. We’ll email you an update on your date, arrival window and cleaner {booking?.confirm_by ? `by ${booking.confirm_by}` : "within one business day"}.</p>
          ) : (
            <p className="text-lg mb-6">{entry ? "Update your payment method securely through Stripe. Saving a different card does not change your visit." : choice ? "A card saved earlier is used for this booking only after you choose it." : done ? !bt ? "Your payment method is saved. To request a cleaning, choose your service and date below." : `Your cleaning is confirmed for ${formatDateLong(booking?.confirmed_date)}${booking?.confirmed_window ? ` · ${formatArrivalWindow(booking.confirmed_window)}` : ""}.` : bt ? "Save a card for this visit through Stripe. The card alone does not confirm your date." : "Save a payment method through Stripe. This page alone does not create a cleaning request."}</p>
          )}
          {done && bt && <Button asChild variant="hero" size="lg" className="mb-6 w-full"><Link to={visitLink}>View my visit</Link></Button>}
          {booking && <dl className="rounded-xl border border-border bg-card p-5 text-left space-y-3 mb-6">
            {booking.service && <div><dt className="font-semibold">Service</dt><dd>{booking.service}</dd></div>}
            {(booking.confirmed_date || booking.date) && <div><dt className="font-semibold">{confirmed ? "Confirmed date" : "Requested date"}</dt><dd>{formatDateLong(booking.confirmed_date || booking.date)}</dd></div>}
            {booking.first && <div><dt className="font-semibold">This visit</dt><dd>{fmtMoney(booking.first)}</dd></div>}
            {hasCard && <div><dt className="font-semibold">Card on file</dt><dd>{cardIdentified ? cardLabel : "Couldn't identify"}</dd></div>}
            <div><dt className="font-semibold">Due today</dt><dd>$0</dd></div>
          </dl>}
          {blocked && <p role="status" className="rounded-xl bg-sage/15 p-5 mb-6 text-left">Automatic payment is blocked for this visit because an issue was reported. Updating your card does not restart it. You choose when to approve your report and pay.</p>}
          {error && <p role="alert" className="mb-4 rounded-lg bg-destructive/10 p-4">{error}</p>}
          {/* Item 6: the saved-card choice. An identified card is
              confirmed by one tap; several unidentified cards are a
              radio list with no preselection; no identifiable card at
              all is the safe "add a card" fallback — never a blind
              confirm of an unknown card. The payment block stands
              above the button in both scenarios. */}
          {choice && !blocked && <div className="mb-6"><PaymentSummary showCard /></div>}
          {choice && cardIdentified && <Button variant="hero" size="lg" className="w-full mb-3" disabled={busy} onClick={() => void confirm()}>{busy ? "Confirming…" : `Use ${cardLabel} for this booking`}</Button>}
          {choice && !cardIdentified && cardOptions.length > 0 && (
            <div className="mb-3 text-left" role="radiogroup" aria-label="Choose a card for this visit">
              {cardOptions.map((c) => {
                const label = `${c.brand ? c.brand.replace(/\b\w/g, (ch) => ch.toUpperCase()) : "Card"} ending in ••••${c.last4}`;
                return (
                  <label key={c.id} className="mb-2 flex min-h-[48px] cursor-pointer items-center gap-3 rounded-xl border border-border bg-card p-3">
                    <input type="radio" name="saved-card" value={c.id} checked={selectedCard === c.id} onChange={() => setSelectedCard(c.id)} className="h-5 w-5 accent-primary" />
                    <span className="text-base font-semibold">{label}</span>
                    {typeof c.exp_month === "number" && typeof c.exp_year === "number" && (
                      <span className="text-sm text-muted-foreground">Expires {String(c.exp_month).padStart(2, "0")}/{c.exp_year}</span>
                    )}
                  </label>
                );
              })}
            </div>
          )}
          {choice && !cardIdentified && cardOptions.length > 0 && <Button variant="hero" size="lg" className="w-full mb-3" disabled={busy || !selectedCard} onClick={() => void confirm()}>{busy ? "Confirming…" : "Use selected card"}</Button>}
          {choice && !cardIdentified && cardOptions.length === 0 && (
            <>
              <p className="mb-4 text-base">We couldn&rsquo;t identify a saved card for this visit. Add a card to continue.</p>
              <Button variant="hero" size="lg" className="w-full mb-3" onClick={() => setEntry(true)}>Add a card</Button>
            </>
          )}
          {hasCard && !entry && <Button variant={done ? "link" : "outline"} size="lg" className={done ? "underline" : "w-full mb-4"} onClick={() => setEntry(true)}>Add a different card</Button>}
          {showForm && <>
            {!blocked && <div className="mb-6"><PaymentSummary showCard /></div>}
            {params.get("canceled") === "1" && <p className="mb-6">Card entry was cancelled. You can try again when you're ready.</p>}
            <form onSubmit={submit} className="text-left space-y-4" noValidate>
              {!bt && <>
                <div><label className="block font-medium mb-1" htmlFor="sc-name">Full name</label><input className="w-full rounded-lg border p-3 text-base" id="sc-name" value={name} autoComplete="name" onChange={(e) => setName(e.target.value)} aria-invalid={!!errors.name} aria-describedby={errors.name ? "sc-name-error" : undefined} />{errors.name && <p id="sc-name-error" className="text-destructive">{errors.name}</p>}</div>
                <div><label className="block font-medium mb-1" htmlFor="sc-email">Email</label><input className="w-full rounded-lg border p-3 text-base" id="sc-email" type="email" value={email} autoComplete="email" onChange={(e) => setEmail(e.target.value)} aria-invalid={!!errors.email} aria-describedby={errors.email ? "sc-email-error" : undefined} />{errors.email && <p id="sc-email-error" className="text-destructive">{errors.email}</p>}</div>
              </>}
              <Button type="submit" variant="hero" size="lg" className="w-full" disabled={busy}>{busy ? "Opening Stripe's secure page…" : "Add card"}</Button>
              <p className="text-base text-muted-foreground text-center">You'll enter your card securely on Stripe. No Link account is required.</p>
            </form>
          </>}
          {done && !bt && <Button asChild variant="hero" size="lg"><Link to="/quote">See price & request a cleaning</Link></Button>}
          {bt && !done && <p className="mt-6"><Link to={visitLink} className="underline font-semibold">View my visit</Link></p>}
        </>}
      </div>
    </div>
  );
}
