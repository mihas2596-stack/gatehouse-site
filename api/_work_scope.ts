// One explicit work scope for new visits. Labels match the public inclusion list.
export type WorkRoom = { name: string; items: { label: string; done: boolean }[] };
export function buildWorkRooms(options: {
  bedrooms?: string; fullBaths?: string; halfBaths?: string; extraZones?: string;
  deep: boolean; addons?: { insideOven?: boolean; insideFridge?: boolean; insideCabinets?: boolean; interiorWindows?: number; pets?: boolean };
}): WorkRoom[] {
  const room = (name: string, labels: string[]): WorkRoom => ({ name, items: labels.map((label) => ({ label, done: false })) });
  const kitchen = ["Countertops wiped", "Backsplash wiped", "Sink scrubbed and fixtures shined", "Stovetop wiped", "Exterior of oven, fridge, dishwasher and microwave wiped", "Inside microwave wiped", "Cabinet fronts spot-cleaned", "Table and chairs wiped", "Light switches and door handles wiped", "Trash emptied and bag replaced", "Floor vacuumed", "Floor mopped"];
  if (options.deep || options.addons?.insideOven) kitchen.push("Inside oven cleaned");
  if (options.deep || options.addons?.insideFridge) kitchen.push("Inside fridge cleaned");
  if (options.deep || options.addons?.insideCabinets) kitchen.push("Inside cabinets cleaned");
  const baths = ["Toilet cleaned inside, outside and base", "Tub scrubbed", "Shower walls and door cleaned", "Sink and counter cleaned", "Faucets and fixtures shined", "Mirrors cleaned", "Towel bars and toilet paper holder wiped", "Cabinet fronts spot-cleaned", "Light switches and door handles wiped", "Trash emptied", "Floor vacuumed", "Floor mopped"];
  const beds = ["Reachable surfaces dusted", "Nightstands and dressers dusted", "Beds made (linens changed if left on bed)", "Mirrors cleaned", "Window sills dusted", "Light switches and door handles wiped", "Trash emptied", "Floor vacuumed or mopped"];
  const living = ["Reachable surfaces and shelves dusted", "TV stand dusted", "Couch cushions straightened", "Mirrors and glass tabletops cleaned", "Window sills dusted", "Light switches and door handles wiped", "Stair railings wiped", "Stairs vacuumed", "Trash emptied", "Floors vacuumed", "Floors mopped"];
  const rooms = [room("Kitchen", kitchen)];
  const repeat = (raw: string | undefined, singular: string, plural: string, labels: string[], optional = false) => {
    const parsed = Number.parseInt(raw ?? "", 10);
    const count = Number.isFinite(parsed) ? Math.max(0, Math.min(20, parsed)) : optional ? 0 : 1;
    if (!count && optional) return;
    for (let i = 1; i <= Math.max(1, count); i++) rooms.push(room(count > 1 ? `${singular} ${i}` : Number.isFinite(parsed) ? singular : plural, labels));
  };
  repeat(options.fullBaths, "Bathroom", "Bathrooms", baths);
  repeat(options.bedrooms, "Bedroom", "Bedrooms", beds);
  repeat(options.halfBaths, "Half bathroom", "Half bathrooms", baths.filter((t) => !/Tub|Shower/.test(t)), true);
  rooms.push(room("Living room", living));
  // B7: a one-letter zone is never a real room — drop it instead of
  // creating a room the cleaner can never finish (cf. booking 7898b53d,
  // where "Home off…" became single-letter rooms).
  for (const zone of (options.extraZones ?? "").split(",").map((s) => s.trim()).filter((s) => s.length >= 2).slice(0, 8)) rooms.push(room(zone.slice(0, 60), living));
  const extra: string[] = [];
  if ((options.addons?.interiorWindows ?? 0) > 0) extra.push(`Interior windows cleaned — ${Math.min(40, Math.floor(options.addons!.interiorWindows!))} windows`);
  if (options.addons?.pets) extra.push("Extra pet-hair work completed (pet waste is not included)");
  if (extra.length) rooms.push(room("Additional agreed work", extra));
  return rooms;
}
