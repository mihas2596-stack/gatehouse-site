import { useState } from "react";

export default function ClientContact({ phone, label = "Client phone" }: { phone?: string | null; label?: string }) {
  const [copied, setCopied] = useState(false);
  const [copyUnavailable, setCopyUnavailable] = useState(false);
  if (!phone) return <p className="text-base text-muted-foreground">{label}: not available. Contact Gatehouse for help.</p>;
  const digits = phone.replace(/\D/g, "");
  const target = `+${digits.length === 10 ? `1${digits}` : digits}`;
  const national = digits.length === 11 ? digits.slice(1) : digits;
  const formatted = national.length === 10 ? `(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}` : phone;
  return <div className="space-y-2 text-base">
    <p><span className="font-semibold">{label}:</span> <a className="underline" href={`tel:${target}`}>{formatted}</a></p>
    <div className="flex flex-wrap gap-2">
      <a className="inline-flex min-h-[44px] items-center rounded-lg border border-border px-4 font-semibold" href={`tel:${target}`}>Call client</a>
      <a className="inline-flex min-h-[44px] items-center rounded-lg border border-border px-4 font-semibold" href={`sms:${target}`}>Text client</a>
      <button type="button" className="min-h-[44px] rounded-lg border border-border px-4" onClick={() => {
        if (!navigator.clipboard?.writeText) { setCopyUnavailable(true); return; }
        void navigator.clipboard.writeText(phone).then(() => { setCopied(true); setCopyUnavailable(false); }).catch(() => setCopyUnavailable(true));
      }}>{copied ? "Copied" : "Copy number"}</button>
    </div>
    {copied && <p role="status">Phone number copied.</p>}
    {copyUnavailable && <p role="status">Select the phone number above to copy it.</p>}
  </div>;
}
