import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ReportContent } from "../components/ReportContent";

describe("ReportContent excluded rooms (C04)", () => {
  it("names rooms the client asked not to photograph, and skips rooms that do have photos", () => {
    render(
      <ReportContent
        photoItems={[{ url: "/x.jpg", room: "Kitchen", kind: "after" }]}
        checklist={null}
        excludedRooms={["Bedroom", "Kitchen"]}
        renderPhoto={(p) => <img src={p.url} alt={p.room ?? ""} />}
      />,
    );
    expect(screen.getByText("Not photographed")).toBeTruthy();
    expect(screen.getByText(/You asked us not to photograph: Bedroom/)).toBeTruthy();
    expect(screen.queryByText(/Kitchen\./)).toBeNull();
  });
});
