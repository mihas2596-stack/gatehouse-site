// @vitest-environment node
import { describe, it, expect } from "vitest";
import { buildWorkRooms } from "../../api/_work_scope";

describe("promised work reaches the cleaner", () => {
  it("covers the 43 published standard tasks for one bedroom and bathroom", () => {
    const rooms = buildWorkRooms({ bedrooms: "1", fullBaths: "1", deep: false });
    expect(rooms.flatMap((r) => r.items)).toHaveLength(43);
    expect(rooms.flatMap((r) => r.items).map((i) => i.label)).toContain("Inside microwave wiped");
    expect(rooms.find((r) => r.name === "Bedroom")?.items.some((i) => i.label.includes("linens changed"))).toBe(true);
  });
  it("deep interiors and selected extras appear once, with exact window count", () => {
    const rooms = buildWorkRooms({ bedrooms: "3", fullBaths: "2", halfBaths: "1", deep: true, addons: { insideOven: true, insideFridge: true, insideCabinets: true, interiorWindows: 7, pets: true } });
    const labels = rooms.flatMap((r) => r.items).map((i) => i.label);
    expect(labels.filter((s) => s === "Inside oven cleaned")).toHaveLength(1);
    expect(labels).toContain("Interior windows cleaned — 7 windows");
    expect(rooms.filter((r) => r.name.startsWith("Bedroom"))).toHaveLength(3);
    expect(rooms.filter((r) => r.name.startsWith("Bathroom"))).toHaveLength(2);
    expect(rooms.find((r) => r.name === "Half bathroom")?.items.some((i) => /Tub|Shower/.test(i.label))).toBe(false);
  });
  it("B7: one-letter extra zones never become rooms", () => {
    const rooms = buildWorkRooms({ bedrooms: "1", fullBaths: "1", deep: false, extraZones: "H, Den, x, Home office" });
    const names = rooms.map((r) => r.name);
    expect(names).toContain("Den");
    expect(names).toContain("Home office");
    expect(names).not.toContain("H");
    expect(names).not.toContain("x");
  });
});
