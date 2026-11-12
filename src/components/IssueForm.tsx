// The "Report an issue" form, shared by /report (awaiting view, open-issue
// follow-up, paid view) and the embedded report section on /visit. Defined
// at module level so typing never remounts it and loses focus. The uses
// differ only in the submit label and the helper text.
//
// The room picker lists only the report's REAL rooms plus "Other / not
// listed" — never a hardcoded room list (a hardcoded "Bathroom" next to
// the report's "Bathrooms" / "Bathroom 1" would let the client pick a
// room that isn't in the report).
import { Button } from "@/components/ui/button";

export type IssueFormProps = {
  rooms: string[];
  room: string;
  onRoom: (v: string) => void;
  text: string;
  onText: (v: string) => void;
  photoNote: string;
  onPhotoPick: (file: File | null) => void;
  busy: boolean;
  submitLabel: string;
  helper: string;
  onSubmit: () => void;
  onCancel: () => void;
};

export function IssueForm({ rooms, room, onRoom, text, onText, photoNote, onPhotoPick, busy, submitLabel, helper, onSubmit, onCancel }: IssueFormProps) {
  return (
    <div className="text-left">
      <label htmlFor="issue-room" className="block font-semibold mb-2">
        Which room?
      </label>
      <select
        id="issue-room"
        value={room}
        onChange={(e) => onRoom(e.target.value)}
        className="w-full rounded-xl border border-border bg-card p-3 text-sm mb-3"
      >
        <option value="">Choose a room…</option>
        {rooms.map((r) => (
          <option key={r} value={r}>{r}</option>
        ))}
        <option value="Other">Other / not listed</option>
      </select>
      <label htmlFor="issue-text" className="block font-semibold mb-2">
        What isn&apos;t right?
      </label>
      <textarea
        id="issue-text"
        value={text}
        onChange={(e) => onText(e.target.value)}
        rows={4}
        maxLength={500}
        placeholder="Tell us what we missed — the automatic charge is blocked for this visit."
        className="w-full rounded-xl border border-border bg-card p-3 text-sm mb-3"
      />
      <label htmlFor="issue-photo" className="block font-semibold mb-2">
        Add a photo <span className="font-normal text-muted-foreground">(optional)</span>
      </label>
      <input
        id="issue-photo"
        type="file"
        accept="image/*"
        onChange={(e) => onPhotoPick(e.target.files?.[0] ?? null)}
        className="w-full text-sm mb-1"
      />
      <p className="text-xs text-muted-foreground mb-2">
        Photos up to 1 MB each. If your photo is larger, take a screenshot of it first.
      </p>
      {photoNote && (
        <p className="text-xs text-muted-foreground mb-2">{photoNote}</p>
      )}
      <p className="text-xs text-muted-foreground mb-3">
        {helper}
      </p>
      <div className="flex flex-col sm:flex-row gap-3">
        <Button variant="hero" size="lg" disabled={busy || !text.trim()} onClick={onSubmit}>
          {busy ? "Sending…" : submitLabel}
        </Button>
        <Button variant="outline" size="lg" disabled={busy} onClick={onCancel}>
          Back
        </Button>
      </div>
    </div>
  );
}

export default IssueForm;
