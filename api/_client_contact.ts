// Contact belongs to a visit, never to a shared Stripe customer's latest booking.
// Stored in the existing private journal so this fix needs no schema rollout.
export function normalizeClientPhone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const digits = value.replace(/\D/g, "");
  const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return national.length === 10 ? `+1${national}` : null;
}

export async function loadClientPhone(visitId: string): Promise<string | null> {
  const { dbSelect } = await import("./_db.js");
  const rows = await dbSelect<{ detail: { phone?: unknown } | null }>(
    "gh_events",
    `visit_id=eq.${encodeURIComponent(visitId)}&event=eq.client_contact&order=created_at.desc,id.desc&limit=1`,
  );
  return normalizeClientPhone(rows[0]?.detail?.phone);
}
