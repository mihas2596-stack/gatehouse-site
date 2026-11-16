// The "Report an issue" form, shared by /report (awaiting view, open-issue
// follow-up, paid view) and the embedded report section on /visit. Defined
// at module level so typing never remounts it and loses focus. The uses
// differ only in the submit label and the helper text.
//
// 16.11.2026 (spec 1.2/3.1): several rooms at once (checkboxes over the
// report's REAL rooms plus "Other / not listed" — never a hardcoded room
// list, so the client cannot pick a room that isn't in the report). A
// short description is enough ("The kitchen floor is still sticky.");
// photos stay optional.
import { Button } from "@/components/ui/button";

export type IssueFormProps = {
  rooms: string[];
  roomsSelected: string[];
  onRooms: (v: string[]) => void;
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

export function IssueForm({ rooms, roomsSelected, onRooms, text, onText, photoNote, onPhotoPick, busy, submitLabel, helper, onSubmit, onCancel }: IssueFormProps) {
  const toggleRoom = (r: string) => {
    onRooms(roomsSelected.includes(r) ? roomsSelected.filter((x) => x !== r) : [...roomsSelected, r]);
  };
  return (
    <div className="text-left">
      <fieldset className="mb-3">
        <legend className="block font-semibold mb-2">
          Which areas need attention?
        </legend>
        <div className="flex flex-wrap gap-2">
          {rooms.map((r) => (
            <label key={r} className="inline-flex min-h-[44px] cursor-pointer items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-sm font-medium">
              <input
                type="checkbox"
                checked={roomsSelected.includes(r)}
                onChange={() => toggleRoom(r)}
                className="h-5 w-5 accent-primary"
              />
              {r}
            </label>
          ))}
          <label className="inline-flex min-h-[44px] cursor-pointer items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-sm font-medium">
            <input
              type="checkbox"
              checked={roomsSelected.includes("Other")}
              onChange={() => toggleRoom("Other")}
              className="h-5 w-5 accent-primary"
            />
            Other / not listed
          </label>
        </div>
      </fieldset>
      <label htmlFor="issue-text" className="block font-semibold mb-2">
        What did you notice?
      </label>
      <textarea
        id="issue-text"
        value={text}
        onChange={(e) => onText(e.target.value)}
        rows={4}
        maxLength={500}
        placeholder="A short description is enough. For example, ‘The kitchen floor is still sticky.’"
        className="w-full rounded-xl border border-border bg-card p-3 text-sm mb-3"
      />
      <label htmlFor="issue-photo" className="block font-semibold mb-2">
        Photos <span className="font-normal text-muted-foreground">(optional)</span>
      </label>
      <input
        id="issue-photo"
        type="file"
        accept="image/*"
        onChange={(e) => onPhotoPick(e.target.files?.[0] ?? null)}
        className="w-full text-sm mb-1"
      />
      <p className="text-xs text-muted-foreground mb-2">
        Photos are compressed on your phone before sending (up to 15 MB each).
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
