/** Shared with the client through its pure re-export. Keep API imports in api/. */
export const photoBlocked = (zones: string | null | undefined, room: string): boolean =>
  (zones ?? "").split(",").some((zone) => zone.trim().toLowerCase() === room.trim().toLowerCase());
