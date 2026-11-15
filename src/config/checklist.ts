// Room-by-room checklist — single source for /whats-included.
// Room names and task labels match the cleaner work scope in
// api/_work_scope.ts (buildWorkRooms): "Bathroom"/"Bedroom" are the
// singular room names (numbered Bathroom 1, Bedroom 1, … when there are
// several); "Half bathroom" has no tub/shower tasks; "Additional agreed
// work" holds the add-on tasks; the "Inside … cleaned" tasks apply on
// deep cleans or as add-ons.
export const CHECKLIST = [
  {
    room: "Kitchen",
    tasks: [
      "Countertops wiped",
      "Backsplash wiped",
      "Sink scrubbed and fixtures shined",
      "Stovetop wiped",
      "Exterior of oven, fridge, dishwasher and microwave wiped",
      "Inside microwave wiped",
      "Cabinet fronts spot-cleaned",
      "Table and chairs wiped",
      "Light switches and door handles wiped",
      "Trash emptied and bag replaced",
      "Floor vacuumed",
      "Floor mopped",
      "Inside oven cleaned (deep clean, or as an add-on)",
      "Inside fridge cleaned (deep clean, or as an add-on)",
      "Inside cabinets cleaned (deep clean, or as an add-on)",
    ],
  },
  {
    room: "Bathroom",
    tasks: [
      "Toilet cleaned inside, outside and base",
      "Tub scrubbed",
      "Shower walls and door cleaned",
      "Sink and counter cleaned",
      "Faucets and fixtures shined",
      "Mirrors cleaned",
      "Towel bars and toilet paper holder wiped",
      "Cabinet fronts spot-cleaned",
      "Light switches and door handles wiped",
      "Trash emptied",
      "Floor vacuumed",
      "Floor mopped",
    ],
  },
  {
    room: "Half bathroom",
    tasks: [
      "Toilet cleaned inside, outside and base",
      "Sink and counter cleaned",
      "Faucets and fixtures shined",
      "Mirrors cleaned",
      "Towel bars and toilet paper holder wiped",
      "Cabinet fronts spot-cleaned",
      "Light switches and door handles wiped",
      "Trash emptied",
      "Floor vacuumed",
      "Floor mopped",
    ],
  },
  {
    room: "Bedroom",
    tasks: [
      "Reachable surfaces dusted",
      "Nightstands and dressers dusted",
      "Beds made (linens changed if left on bed)",
      "Mirrors cleaned",
      "Window sills dusted",
      "Light switches and door handles wiped",
      "Trash emptied",
      "Floor vacuumed or mopped",
    ],
  },
  {
    room: "Living room",
    tasks: [
      "Reachable surfaces and shelves dusted",
      "TV stand dusted",
      "Couch cushions straightened",
      "Mirrors and glass tabletops cleaned",
      "Window sills dusted",
      "Light switches and door handles wiped",
      "Stair railings wiped",
      "Stairs vacuumed",
      "Trash emptied",
      "Floors vacuumed",
      "Floors mopped",
    ],
  },
  {
    room: "Additional agreed work",
    tasks: [
      "Interior windows cleaned (add-on, per window)",
      "Extra pet-hair work completed (pet waste is not included)",
    ],
  },
] as const;

export const NOT_INCLUDED = [
  "Exterior windows — we clean interior windows only (available as an add-on).",
  "Walls — we don't wash walls; we do wipe light switches and door handles.",
  "Laundry — we don't wash, dry or fold laundry; we do make beds with the linens left on the bed.",
  "Dishes — we don't wash dishes; we do wipe the sink and clean the countertops.",
  "Pet waste — we don't handle pet waste or litter boxes.",
  "Biohazards — we don't handle blood, mold or other hazardous materials.",
];
