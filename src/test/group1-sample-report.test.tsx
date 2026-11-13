// Group 1(d) — live run-through on 6f346a37: the homepage sample report
// read like a placeholder ("photos appear here" — as if photos were
// still in progress). The copy is now honest and finished: the sample
// shows the checklist, and a real report adds before/after photos.
import { describe, it, expect } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ReportShowcase from "@/components/ReportShowcase";

describe("sample report copy (group 1d)", () => {
  it("says the sample is complete instead of pointing at missing photos", () => {
    render(<ReportShowcase />);
    // Kitchen and Bathroom (the rooms without a photo) render after expanding.
    fireEvent.click(screen.getByRole("button", { name: /Show all rooms/ }));
    expect(
      screen.getAllByText("Sample checklist shown — a real report also has before and after photos for each room."),
    ).toHaveLength(2);
    expect(screen.queryByText(/photos appear here/)).not.toBeInTheDocument();
    expect(screen.queryByText(/in progress/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/hidden/i)).not.toBeInTheDocument();
    cleanup();
  });
});
