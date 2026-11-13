// Group 1(a) — live run-through on 6f346a37: the client /visit page showed
// NO rooms while the owner report and the cleaner checklist did. The API
// now returns the stored work-scope room names (rowRoomNames) and the
// client page renders them as "Rooms we'll clean".
// @vitest-environment node
import { describe, it, expect } from "vitest";
import { rowRoomNames } from "../../api/visit";

describe("rowRoomNames (visit rooms for the client page)", () => {
  it("returns the stored checklist room names in order", () => {
    expect(
      rowRoomNames({
        id: "v1", booking_id: "b1", status: "confirmed", amount_cents: 149, cleaner_name: null,
        report_sent_at: null, report_bounced: false, access_notes: null, no_photo_zones: null,
        checklist: {
          rooms: [
            { name: "Kitchen" }, { name: "Bathroom" }, { name: "Bedroom 1" },
            { name: "Bedroom 2" }, { name: "Half bathroom" }, { name: "Living room" },
          ],
        },
      } as never),
    ).toEqual(["Kitchen", "Bathroom", "Bedroom 1", "Bedroom 2", "Half bathroom", "Living room"]);
  });

  it("accepts a JSON-string checklist", () => {
    expect(
      rowRoomNames({
        id: "v1", booking_id: "b1", status: "confirmed", amount_cents: 149, cleaner_name: null,
        report_sent_at: null, report_bounced: false, access_notes: null, no_photo_zones: null,
        checklist: JSON.stringify({ rooms: [{ name: "Kitchen" }, { name: "Bathroom" }] }),
      } as never),
    ).toEqual(["Kitchen", "Bathroom"]);
  });

  it("returns [] for a visit booked before the work scope was stored", () => {
    expect(
      rowRoomNames({
        id: "v1", booking_id: "b1", status: "confirmed", amount_cents: 149, cleaner_name: null,
        report_sent_at: null, report_bounced: false, access_notes: null, no_photo_zones: null,
        checklist: null,
      } as never),
    ).toEqual([]);
    expect(
      rowRoomNames({
        id: "v1", booking_id: "b1", status: "confirmed", amount_cents: 149, cleaner_name: null,
        report_sent_at: null, report_bounced: false, access_notes: null, no_photo_zones: null,
        checklist: "{not json",
      } as never),
    ).toEqual([]);
    expect(
      rowRoomNames({
        id: "v1", booking_id: "b1", status: "confirmed", amount_cents: 149, cleaner_name: null,
        report_sent_at: null, report_bounced: false, access_notes: null, no_photo_zones: null,
        checklist: { rooms: [{ name: "Kitchen" }, { name: "" }, { name: "  " }, {}] },
      } as never),
    ).toEqual(["Kitchen"]);
    expect(rowRoomNames(null)).toEqual([]);
  });
});
