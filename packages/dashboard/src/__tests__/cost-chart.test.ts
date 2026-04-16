import { describe, it, expect } from "vitest";
import type { DailyRow } from "@urateam/core";
import { renderCostChart } from "../views/cost.js";

describe("renderCostChart", () => {
  it("returns empty string for fewer than 2 data points", () => {
    expect(renderCostChart([])).toBe("");
    expect(renderCostChart([{ date: "2026-04-01", runs: 1, prsMerged: 1, dollars: 1, timeSavedHours: 1 }])).toBe("");
  });

  it("emits an SVG polyline with one point per day", () => {
    const byDay: DailyRow[] = [
      { date: "2026-04-01", runs: 1, prsMerged: 1, dollars: 10, timeSavedHours: 4 },
      { date: "2026-04-02", runs: 2, prsMerged: 2, dollars: 20, timeSavedHours: 8 },
      { date: "2026-04-03", runs: 1, prsMerged: 1, dollars: 5, timeSavedHours: 4 },
    ];
    const html = renderCostChart(byDay);
    expect(html).toContain("<svg");
    expect(html).toContain("<polyline");
    // 3 points → 3 "x,y" pairs in the points attribute
    const pointsMatch = html.match(/points="([^"]+)"/);
    expect(pointsMatch).not.toBeNull();
    const points = pointsMatch![1].trim().split(" ");
    expect(points).toHaveLength(3);
    // first and last dates rendered as header labels
    expect(html).toContain("2026-04-01");
    expect(html).toContain("2026-04-03");
    // total + peak labels
    expect(html).toContain("Total: $35.00");
    expect(html).toContain("peak: $20.00");
  });

  it("handles a flat-zero series without divide-by-zero", () => {
    const byDay: DailyRow[] = [
      { date: "2026-04-01", runs: 0, prsMerged: 0, dollars: 0, timeSavedHours: 0 },
      { date: "2026-04-02", runs: 0, prsMerged: 0, dollars: 0, timeSavedHours: 0 },
    ];
    const html = renderCostChart(byDay);
    expect(html).toContain("<polyline");
    // No NaN anywhere
    expect(html).not.toMatch(/NaN/);
  });

  it("escapes HTML-sensitive date labels", () => {
    // Dates are YYYY-MM-DD from the server so no real injection risk, but the
    // renderer should still pass dates through escapeHtml to stay defensive.
    const byDay: DailyRow[] = [
      { date: "<script>", runs: 1, prsMerged: 1, dollars: 1, timeSavedHours: 1 },
      { date: "2026-04-02", runs: 1, prsMerged: 1, dollars: 1, timeSavedHours: 1 },
    ];
    const html = renderCostChart(byDay);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
