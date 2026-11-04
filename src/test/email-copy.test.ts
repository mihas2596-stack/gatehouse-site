import { describe, expect, it } from "vitest";
import { emailArrivalWindow, emailDate, emailDocument, paymentEmailCopy, reportEmail } from "../../api/_email_copy";
import { cleanerJobMessage } from "../lib/cleanerMessage";

describe("customer email clarity", () => {
  it("formats a date without changing the requested day and labels Atlanta arrival windows", () => {
    expect(emailDate("2027-01-15")).toBe("Friday, January 15, 2027");
    expect(emailDate("2027-02-30")).toBe("2027-02-30");
    expect(emailArrivalWindow("midday")).toBe("11 AM–2 PM ET");
    expect(emailArrivalWindow("flexible")).toContain("agree an arrival window");
  });

  it("keeps quote lines separate, escapes customer text and offers one main action", () => {
    const html = emailDocument({ firstName: '<img src=x>', heading: "Request received",
      paragraphs: ["Date: Friday\nPrice: $189", "First paragraph\n\nNext paragraph"],
      action: { url: 'https://example.com/?a=1&b="2"', label: "View my visit" },
    });
    expect(html).toContain("Date: Friday<br>Price: $189");
    expect(html).toContain("&lt;img src=x&gt;");
    expect(html).not.toContain("<img");
    expect(html).toContain("?a=1&amp;b=&quot;2&quot;");
    expect(html.match(/<table /g)).toHaveLength(1);
  });

  it("states immediate approval payment, the send-based 24-hour clock and the permanent issue block", () => {
    const text = paymentEmailCopy("$189");
    expect(text).toContain("Due today: $0");
    expect(text).toContain("charges your card $189 immediately");
    expect(text).toContain("24 hours after we send the report");
    expect(text).toContain("closing the issue does not restart it");
    expect(paymentEmailCopy("—")).toContain("the agreed visit amount");
    expect(paymentEmailCopy("—")).not.toContain("—");
  });

  it("a reissued report after a complaint never announces an automatic payment deadline", () => {
    const common = { firstName: "Jane", amount: "$189", deadline: "Friday, 3 PM", link: "https://example.com/visit" };
    const blocked = reportEmail({ ...common, autoChargeBlocked: true });
    expect(blocked.text).toContain("charges your card $189 immediately");
    expect(blocked.text).toContain("Automatic charging is blocked for this visit");
    expect(blocked.text).not.toContain("Review by");
    expect(blocked.text).not.toContain("charged automatically 24 hours");
    const normal = reportEmail({ ...common, autoChargeBlocked: false });
    expect(normal.text).toContain("24 hours after we send the report");
    expect(normal.text).toContain("Review by Friday, 3 PM (Atlanta time)");
  });

  it("the manual cleaner message explains entry, room restrictions and when to finish", () => {
    const text = cleanerJobMessage({ visit_date: "2027-01-15", window: "morning", address: "123 Test St" }, "https://example.com/job");
    expect(text).toContain("Jan 15, 2027 · 7–11 AM ET");
    expect(text).toContain("Check the entry instructions");
    expect(text).toContain("no-photo rooms");
    expect(text).toContain('changes are saved, tap "Finish & send report"');
    expect(text).toContain("Keep this job link private");
  });
});
