import { useState } from "react";

export default function ClientContact({ phone, label = "Client phone", compact = false, name = null }: { phone?: string | null; label?: string; compact?: boolean; name?: string | null }) {
  const [copied, setCopied] = useState(false);
  const [copyUnavailable, setCopyUnavailable] = useState(false);
  if (!phone) return <p className="text-base text-muted-foreground">{label}: not available. Contact Gatehouse for help.</p>;
  const digits = phone.replace(/\D/g, "");
  const target = `+${digits.length === 10 ? `1${digits}` : digits}`;
  const national = digits.length === 11 ? digits.slice(1) : digits;
  const formatted = national.length === 10 ? `(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}` : phone;
  // Item 13: every call action names who it calls — "Call client
  // Anna", falling back to the role alone when there is no name.
  const person = name ? `client ${name}` : "client";
  const copy = () => {
    if (!navigator.clipboard?.writeText) { setCopyUnavailable(true); return; }
    void navigator.clipboard.writeText(phone).then(() => { setCopied(true); setCopyUnavailable(false); }).catch(() => setCopyUnavailable(true));
  };
  // Compact: one inline line of text links (owner cabinet) instead of
  // three large buttons. The cleaner cabinet keeps the buttons.
  if (compact) {
    return <div className="text-base">
      <p>
        <span className="font-semibold">{label}:</span> <a className="underline" href={`tel:${target}`}>{formatted}</a>
        {" · "}
        <a className="underline text-sm" href={`tel:${target}`}>Call {person}</a>
        {" · "}
        <a className="underline text-sm" href={`sms:${target}`}>Text {person}</a>
        {" · "}
        <button type="button" className="underline text-sm" onClick={copy}>Copy</button>
      </p>
      {copied && <p role="status">Phone number copied.</p>}
      {copyUnavailable && <p role="status">Select the phone number above to copy it.</p>}
    </div>;
  }
  return <div className="space-y-2 text-base">
    <p><span className="font-semibold">{label}:</span> <a className="underline" href={`tel:${target}`}>{formatted}</a></p>
    <div className="flex flex-wrap gap-2">
      <a className="inline-flex min-h-[44px] items-center rounded-lg border border-border px-4 font-semibold" href={`tel:${target}`}>Call {person}</a>
      <a className="inline-flex min-h-[44px] items-center rounded-lg border border-border px-4 font-semibold" href={`sms:${target}`}>Text {person}</a>
      <button type="button" className="min-h-[44px] rounded-lg border border-border px-4" onClick={copy}>{copied ? "Copied" : "Copy number"}</button>
    </div>
    {copied && <p role="status">Phone number copied.</p>}
    {copyUnavailable && <p role="status">Select the phone number above to copy it.</p>}
  </div>;
}
