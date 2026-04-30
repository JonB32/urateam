import { describe, it, expect } from "vitest";
import { runDetailView, type RunInfo } from "../views/run-detail.js";

const baseRun = (overrides: Partial<RunInfo> = {}): RunInfo => ({
  id: "run_abc",
  issueId: "BEC-1",
  issueTitle: "Test issue",
  pipelineKey: "auto-implement",
  repoUrl: "https://github.com/acme/repo",
  branch: null,
  status: "failed",
  startedAt: new Date("2026-04-29T00:00:00Z"),
  completedAt: new Date("2026-04-29T00:01:00Z"),
  prUrl: null,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  errorMessage: null,
  ...overrides,
});

describe("runDetailView retry control", () => {
  it("renders a <dialog> confirmation modal when run is failed and canRetry", () => {
    const html = runDetailView(baseRun({ status: "failed" }), [], [], 1, 0, true);
    expect(html).toContain("<dialog");
    expect(html).toContain('id="retry-confirm-run_abc"');
    // Trigger button opens dialog via data-attribute (no inline JS — CSP)
    expect(html).toContain('data-open-dialog="retry-confirm-run_abc"');
    // Modal contains the POST form action and a Cancel button
    expect(html).toContain("/runs/run_abc/retry");
    expect(html).toMatch(/Cancel/);
    expect(html).toMatch(/Confirm retry/i);
  });

  it("renders modal for retriable status too", () => {
    const html = runDetailView(baseRun({ status: "retriable" }), [], [], 1, 0, true);
    expect(html).toContain("<dialog");
  });

  it("does not render retry control for succeeded run", () => {
    const html = runDetailView(baseRun({ status: "succeeded" }), [], [], 1, 0, true);
    expect(html).not.toContain("<dialog");
    expect(html).not.toContain("/runs/run_abc/retry");
  });

  it("does not render retry control when canRetry=false even on failed run", () => {
    const html = runDetailView(baseRun({ status: "failed" }), [], [], 1, 0, false);
    expect(html).not.toContain("<dialog");
    expect(html).not.toContain("/runs/run_abc/retry");
  });

  it("escapes run id in dialog id and form action", () => {
    const html = runDetailView(
      baseRun({ id: "run with spaces" }),
      [],
      [],
      1,
      0,
      true,
    );
    // form action uses encodeURIComponent
    expect(html).toContain("/runs/run%20with%20spaces/retry");
  });
});
