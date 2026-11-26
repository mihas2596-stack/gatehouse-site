import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import Quote from "@/pages/Quote";
import ThankYou from "@/pages/ThankYou";

vi.mock("@/components/SEO", () => ({ default: () => null }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.removeItem("gh_last_bt");
});

function request(beds: number, response: object, ok = true) {
  const fetchMock = vi.fn(async () => ({ ok, json: async () => response }));
  vi.stubGlobal("fetch", fetchMock);
  Element.prototype.scrollIntoView = vi.fn();
  render(<MemoryRouter initialEntries={["/quote"]}><Routes>
    <Route path="/quote" element={<Quote />} />
    <Route path="/thank-you" element={<ThankYou />} />
  </Routes></MemoryRouter>);
  fireEvent.change(screen.getByLabelText(/ZIP code/), { target: { value: "30518" } });
  fireEvent.change(screen.getByLabelText("Bedrooms"), { target: { value: String(beds) } });
  fireEvent.click(screen.getByRole("button", { name: "Continue to visit details" }));
  for (const [label, value] of [["Your name *", "Example Client"], ["Phone *", "7705550100"], ["Email *", "client@example.com"], ["Street address *", "123 Example St"], ["City *", "Sugar Hill"], ["Preferred date *", "2099-12-01"]]) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  }
  fireEvent.click(screen.getByRole("radio", { name: /I’ll be home/ }));
  fireEvent.click(screen.getByLabelText(/I agree to photos/));
  fireEvent.click(screen.getByRole("button", { name: "Review my request" }));
  fireEvent.click(screen.getByLabelText(/I agree to the Terms/));
  fireEvent.click(screen.getByRole("button", { name: beds > 5 ? "Request my custom quote" : "Continue to Stripe — $0 today" }));
  return fetchMock;
}

it("completes an unpriced request without fetching a payment status or restoring an unrelated visit", async () => {
  sessionStorage.setItem("gh_last_bt", "older-booking");
  const fetchMock = request(6, { ok: true, needs_custom_quote: true, bt: "custom-quote" });
  expect(await screen.findByRole("heading", { name: "Custom quote requested" })).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("button", { name: /Stripe/ })).toBeNull();
});

it("gives the owner contact when an earlier duplicate confirmation could not be sent", async () => {
  sessionStorage.setItem("gh_last_bt", "older-booking");
  const fetchMock = request(3, { ok: true, duplicate: true, customerEmailSent: false });
  expect(await screen.findByRole("heading", { name: "We already have your request" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Email Gatehouse" })).toHaveAttribute("href", "mailto:hello@gatehousehomecleaning.com");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("brings a server-rejected date back onto the editable page", async () => {
  request(3, { ok: false, errors: { date: "Please choose a later date." } }, false);
  expect(await screen.findByRole("heading", { name: "Your visit" })).toBeInTheDocument();
  expect(screen.getByLabelText("Preferred date *")).toHaveAttribute("aria-invalid", "true");
  expect(screen.getByLabelText("Preferred date *")).toHaveFocus();
  expect(screen.getByRole("alert", { name: "" })).toHaveTextContent("Please choose a later date.");
});
