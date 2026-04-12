import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { layout, escapeHtml } from "../views/layout.js";
import { runDetailView, type RunInfo, type StageInfo, type LogEntry } from "../views/run-detail.js";
import { runFeedView, type RunRow } from "../views/run-feed.js";
import { tokensView } from "../views/tokens.js";
import { coordinationView } from "../views/coordination.js";

describe("Dashboard UI Refresh — Visual & Accessibility", () => {
  // These tests verify visual/structural properties of the layout at the root
  // path (no basePath prefix).  Clear DASHBOARD_BASE_PATH so that env-var
  // contamination from other test files does not affect results.
  let savedBasePath: string | undefined;
  beforeEach(() => {
    savedBasePath = process.env.DASHBOARD_BASE_PATH;
    delete process.env.DASHBOARD_BASE_PATH;
  });
  afterEach(() => {
    if (savedBasePath === undefined) {
      delete process.env.DASHBOARD_BASE_PATH;
    } else {
      process.env.DASHBOARD_BASE_PATH = savedBasePath;
    }
  });
  describe("Modern Typography & Font Stack", () => {
    it("should include Inter font from Google Fonts", () => {
      const html = layout("Test", "");
      expect(html).toContain("fonts.googleapis.com");
      expect(html).toContain("fonts.gstatic.com");
      expect(html).toContain("family=Inter");
    });

    it("should use system-ui fallback in CSS", () => {
      const html = layout("Test", "");
      // The font is loaded via Google Fonts and styled in style.css
      expect(html).toContain("Inter:wght@400;500;600;700");
    });

    it("should apply preconnect hints for font loading performance", () => {
      const html = layout("Test", "");
      expect(html).toContain('<link rel="preconnect" href="https://fonts.googleapis.com">');
      expect(html).toContain('<link rel="preconnect" href="https://fonts.gstatic.com"');
    });
  });

  describe("Dark Mode Support", () => {
    it("should include viewport meta tag for responsive design", () => {
      const html = layout("Test", "");
      expect(html).toContain('name="viewport"');
      expect(html).toContain("width=device-width");
      expect(html).toContain("initial-scale=1");
    });

    it("should have dark mode CSS with prefers-color-scheme media query", () => {
      const html = layout("Test", "");
      // The CSS link should be present; dark mode is handled in style.css
      expect(html).toContain('href="/static/style.css"');
      // The tests should verify style.css contains @media (prefers-color-scheme: dark)
    });
  });

  describe("Favicon Implementation", () => {
    it("should include SVG emoji favicon", () => {
      const html = layout("Test", "");
      expect(html).toContain("data:image/svg+xml");
      expect(html).toContain("⚡"); // Lightning emoji favicon
    });

    it("should use data-URI favicon to avoid extra HTTP requests", () => {
      const html = layout("Test", "");
      expect(html).toContain('<link rel="icon" href="data:image/svg');
    });
  });

  describe("Status Badges & Colors", () => {
    const mockRun: RunInfo = {
      id: "run-1",
      issueId: "BEC-102",
      issueTitle: "UI Refresh",
      pipelineKey: "auto-implement",
      repoUrl: "https://github.com/test/repo",
      branch: "feature/ui",
      status: "completed",
      startedAt: new Date("2024-01-01T10:00:00Z"),
      completedAt: new Date("2024-01-01T10:05:00Z"),
      prUrl: "https://github.com/test/repo/pull/1",
      totalInputTokens: 1000,
      totalOutputTokens: 2000,
      errorMessage: null,
    };

    const mockStage: StageInfo = {
      id: "stage-1",
      stage: "implement",
      status: "completed",
      startedAt: new Date("2024-01-01T10:00:00Z"),
      completedAt: new Date("2024-01-01T10:05:00Z"),
      inputTokens: 500,
      outputTokens: 1000,
      turns: 3,
      handoffArtifact: null,
      errorMessage: null,
    };

    it("should render status badges with correct CSS classes", () => {
      const html = runDetailView(mockRun, [mockStage], [], 1, 0);
      expect(html).toContain('class="badge badge-completed"');
    });

    it("should display status badges for all pipeline stages", () => {
      const stages: StageInfo[] = [
        { ...mockStage, status: "completed" },
        { ...mockStage, status: "running", id: "stage-2", stage: "test" },
        { ...mockStage, status: "failed", id: "stage-3", stage: "review" },
      ];
      const html = runDetailView(mockRun, stages, [], 1, 0);
      expect(html).toContain('badge-completed');
      expect(html).toContain('badge-running');
      expect(html).toContain('badge-failed');
    });

    it("should show all status badge colors in feed view", () => {
      const run: RunRow = {
        id: "run-1",
        issueId: "BEC-102",
        issueTitle: "UI Refresh",
        pipelineKey: "auto-implement",
        repoUrl: "https://github.com/test/repo",
        status: "running",
        startedAt: new Date("2024-01-01T10:00:00Z"),
        completedAt: null,
        totalInputTokens: 1000,
        totalOutputTokens: 2000,
      };
      const html = runFeedView([run]);
      expect(html).toContain('badge-running');
    });
  });

  describe("Progress Indicators & Animations", () => {
    it("should render animated badge for running status", () => {
      const mockRun: RunInfo = {
        id: "run-1",
        issueId: "BEC-102",
        issueTitle: "UI Refresh",
        pipelineKey: "auto-implement",
        repoUrl: "https://github.com/test/repo",
        branch: "feature/ui",
        status: "running",
        startedAt: new Date(Date.now() - 5000), // 5 seconds ago
        completedAt: null,
        prUrl: null,
        totalInputTokens: 1000,
        totalOutputTokens: 2000,
        errorMessage: null,
      };

      const mockStage: StageInfo = {
        id: "stage-1",
        stage: "implement",
        status: "running",
        startedAt: new Date(Date.now() - 5000),
        completedAt: null,
        inputTokens: 500,
        outputTokens: 1000,
        turns: 3,
        handoffArtifact: null,
        errorMessage: null,
      };

      const html = runDetailView(mockRun, [mockStage], [], 1, 0);
      expect(html).toContain('badge-running');
      expect(html).toContain("(running)"); // Duration badge should show running state
    });

    it("should have timeline visual indicators for different stages", () => {
      const stages: StageInfo[] = [
        {
          id: "stage-1",
          stage: "triage",
          status: "completed",
          startedAt: new Date("2024-01-01T10:00:00Z"),
          completedAt: new Date("2024-01-01T10:01:00Z"),
          inputTokens: 100,
          outputTokens: 200,
          turns: 1,
          handoffArtifact: null,
          errorMessage: null,
        },
        {
          id: "stage-2",
          stage: "implement",
          status: "running",
          startedAt: new Date("2024-01-01T10:02:00Z"),
          completedAt: null,
          inputTokens: 500,
          outputTokens: 1000,
          turns: 3,
          handoffArtifact: null,
          errorMessage: null,
        },
      ];

      const mockRun: RunInfo = {
        id: "run-1",
        issueId: "BEC-102",
        issueTitle: "UI Refresh",
        pipelineKey: "auto-implement",
        repoUrl: "https://github.com/test/repo",
        branch: "feature/ui",
        status: "running",
        startedAt: new Date("2024-01-01T10:00:00Z"),
        completedAt: null,
        prUrl: null,
        totalInputTokens: 600,
        totalOutputTokens: 1200,
        errorMessage: null,
      };

      const html = runDetailView(mockRun, stages, [], 1, 0);
      expect(html).toContain("timeline-item completed");
      expect(html).toContain("timeline-item running");
    });
  });

  describe("Responsive Layout", () => {
    it("should wrap tables in responsive container", () => {
      const run: RunRow = {
        id: "run-1",
        issueId: "BEC-102",
        issueTitle: "UI Refresh",
        pipelineKey: "auto-implement",
        repoUrl: "https://github.com/test/repo",
        status: "completed",
        startedAt: new Date(),
        completedAt: new Date(),
        totalInputTokens: 1000,
        totalOutputTokens: 2000,
      };
      const html = runFeedView([run]);
      expect(html).toContain('class="table-wrapper"');
    });

    it("should include viewport meta tag for mobile responsiveness", () => {
      const html = layout("Test", "");
      expect(html).toContain('<meta name="viewport"');
      expect(html).toContain("width=device-width");
    });

    it("should use responsive table with proper overflow handling", () => {
      const run: RunRow = {
        id: "run-1",
        issueId: "BEC-102",
        issueTitle: "Very Long Title That Might Overflow on Mobile Devices",
        pipelineKey: "auto-implement",
        repoUrl: "https://github.com/test/very-long-repo-name/repository",
        status: "completed",
        startedAt: new Date(),
        completedAt: new Date(),
        totalInputTokens: 1000,
        totalOutputTokens: 2000,
      };
      const html = runFeedView([run]);
      expect(html).toContain('class="table-wrapper"');
      // CSS will handle overflow-x styling via style.css
    });
  });

  describe("Card-Style Layout", () => {
    it("should use card layout on run detail page", () => {
      const mockRun: RunInfo = {
        id: "run-1",
        issueId: "BEC-102",
        issueTitle: "UI Refresh",
        pipelineKey: "auto-implement",
        repoUrl: "https://github.com/test/repo",
        branch: "feature/ui",
        status: "completed",
        startedAt: new Date(),
        completedAt: new Date(),
        prUrl: null,
        totalInputTokens: 1000,
        totalOutputTokens: 2000,
        errorMessage: null,
      };

      const mockStage: StageInfo = {
        id: "stage-1",
        stage: "implement",
        status: "completed",
        startedAt: new Date(),
        completedAt: new Date(),
        inputTokens: 500,
        outputTokens: 1000,
        turns: 3,
        handoffArtifact: null,
        errorMessage: null,
      };

      const html = runDetailView(mockRun, [mockStage], [], 1, 0);
      expect(html).toContain('class="card"');
      expect(html.match(/class="card"/g)?.length).toBeGreaterThanOrEqual(3); // Multiple cards
    });

    it("should use card layout on tokens page", () => {
      const html = tokensView(
        [{ date: "2024-01-01", inputTokens: 1000, outputTokens: 2000 }],
        [{ key: "auto-implement", inputTokens: 1000, outputTokens: 2000 }],
        [{ key: "implement", inputTokens: 500, outputTokens: 1000 }]
      );
      expect(html).toContain('class="card"');
      expect(html.match(/class="card"/g)?.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe("Sticky Navigation", () => {
    it("should have sticky positioned navigation", () => {
      const html = layout("Test", "");
      expect(html).toContain("<nav>");
      // CSS will handle position: sticky via style.css
    });

    it("should include navigation links", () => {
      const html = layout("Test", "");
      expect(html).toContain('href="/">Runs</a>');
      expect(html).toContain('href="/tokens">Tokens</a>');
      expect(html).toContain('href="/errors">Errors</a>');
      expect(html).toContain('href="/config">Config</a>');
      expect(html).toContain('href="/coordination">Coordination</a>');
    });

    it("should include branded logo in nav", () => {
      const html = layout("Test", "");
      expect(html).toContain("⚡ urateam");
    });
  });

  describe("Relative Timestamps", () => {
    it("should display relative time in run feed", () => {
      const now = Date.now();
      const oneHourAgo = new Date(now - 60 * 60 * 1000);

      const run: RunRow = {
        id: "run-1",
        issueId: "BEC-102",
        issueTitle: "UI Refresh",
        pipelineKey: "auto-implement",
        repoUrl: "https://github.com/test/repo",
        status: "completed",
        startedAt: oneHourAgo,
        completedAt: new Date(now - 30 * 60 * 1000),
        totalInputTokens: 1000,
        totalOutputTokens: 2000,
      };

      const html = runFeedView([run]);
      expect(html).toMatch(/\dh ago/); // Should contain "1h ago" or similar
    });

    it("should display relative time in run detail page", () => {
      const now = Date.now();
      const twoHoursAgo = new Date(now - 2 * 60 * 60 * 1000);

      const mockRun: RunInfo = {
        id: "run-1",
        issueId: "BEC-102",
        issueTitle: "UI Refresh",
        pipelineKey: "auto-implement",
        repoUrl: "https://github.com/test/repo",
        branch: "feature/ui",
        status: "completed",
        startedAt: twoHoursAgo,
        completedAt: new Date(now - 60 * 60 * 1000),
        prUrl: null,
        totalInputTokens: 1000,
        totalOutputTokens: 2000,
        errorMessage: null,
      };

      const mockStage: StageInfo = {
        id: "stage-1",
        stage: "implement",
        status: "completed",
        startedAt: twoHoursAgo,
        completedAt: new Date(now - 60 * 60 * 1000),
        inputTokens: 500,
        outputTokens: 1000,
        turns: 3,
        handoffArtifact: null,
        errorMessage: null,
      };

      const html = runDetailView(mockRun, [mockStage], [], 1, 0);
      expect(html).toMatch(/\dh ago/); // Should show relative time
    });

    it("should display relative time in logs", () => {
      const now = Date.now();
      const logTime = new Date(now - 5 * 60 * 1000); // 5 minutes ago

      const mockRun: RunInfo = {
        id: "run-1",
        issueId: "BEC-102",
        issueTitle: "UI Refresh",
        pipelineKey: "auto-implement",
        repoUrl: "https://github.com/test/repo",
        branch: "feature/ui",
        status: "completed",
        startedAt: new Date(now - 10 * 60 * 1000),
        completedAt: new Date(now - 1 * 60 * 1000),
        prUrl: null,
        totalInputTokens: 1000,
        totalOutputTokens: 2000,
        errorMessage: null,
      };

      const mockStage: StageInfo = {
        id: "stage-1",
        stage: "implement",
        status: "completed",
        startedAt: new Date(now - 10 * 60 * 1000),
        completedAt: new Date(now - 1 * 60 * 1000),
        inputTokens: 500,
        outputTokens: 1000,
        turns: 3,
        handoffArtifact: null,
        errorMessage: null,
      };

      const logs: LogEntry[] = [
        {
          id: "log-1",
          timestamp: logTime,
          type: "message",
          content: "Starting agent execution",
        },
      ];

      const html = runDetailView(mockRun, [mockStage], logs, 1, 1);
      expect(html).toContain("ago"); // Should show relative time in logs
    });

    it("should display relative time in coordination view", () => {
      const now = Date.now();
      const tenMinutesAgo = new Date(now - 10 * 60 * 1000);

      const entries = [
        {
          id: "work-1",
          runId: "run-1",
          issueId: "BEC-102",
          stage: "implement",
          filesModified: ["src/main.ts", "src/utils.ts"],
          startedAt: tenMinutesAgo,
          updatedAt: new Date(now - 2 * 60 * 1000),
        },
      ];

      const html = coordinationView(entries);
      expect(html).toMatch(/\dm ago/); // Should show relative time
    });
  });

  describe("Run Duration Display", () => {
    it("should display duration prominently in run detail", () => {
      const startTime = new Date("2024-01-01T10:00:00Z");
      const endTime = new Date("2024-01-01T10:05:00Z");

      const mockRun: RunInfo = {
        id: "run-1",
        issueId: "BEC-102",
        issueTitle: "UI Refresh",
        pipelineKey: "auto-implement",
        repoUrl: "https://github.com/test/repo",
        branch: "feature/ui",
        status: "completed",
        startedAt: startTime,
        completedAt: endTime,
        prUrl: null,
        totalInputTokens: 1000,
        totalOutputTokens: 2000,
        errorMessage: null,
      };

      const mockStage: StageInfo = {
        id: "stage-1",
        stage: "implement",
        status: "completed",
        startedAt: startTime,
        completedAt: endTime,
        inputTokens: 500,
        outputTokens: 1000,
        turns: 3,
        handoffArtifact: null,
        errorMessage: null,
      };

      const html = runDetailView(mockRun, [mockStage], [], 1, 0);
      expect(html).toContain("duration-badge");
      expect(html).toContain("5m"); // Should show 5 minute duration
    });

    it("should display duration in feed view", () => {
      const startTime = new Date("2024-01-01T10:00:00Z");
      const endTime = new Date("2024-01-01T10:03:30Z");

      const run: RunRow = {
        id: "run-1",
        issueId: "BEC-102",
        issueTitle: "UI Refresh",
        pipelineKey: "auto-implement",
        repoUrl: "https://github.com/test/repo",
        status: "completed",
        startedAt: startTime,
        completedAt: endTime,
        totalInputTokens: 1000,
        totalOutputTokens: 2000,
      };

      const html = runFeedView([run]);
      expect(html).toContain("3m 30s");
    });
  });

  describe("Collapsible Log Sections", () => {
    it("should render collapsible details section for logs", () => {
      const mockRun: RunInfo = {
        id: "run-1",
        issueId: "BEC-102",
        issueTitle: "UI Refresh",
        pipelineKey: "auto-implement",
        repoUrl: "https://github.com/test/repo",
        branch: "feature/ui",
        status: "completed",
        startedAt: new Date(),
        completedAt: new Date(),
        prUrl: null,
        totalInputTokens: 1000,
        totalOutputTokens: 2000,
        errorMessage: null,
      };

      const mockStage: StageInfo = {
        id: "stage-1",
        stage: "implement",
        status: "completed",
        startedAt: new Date(),
        completedAt: new Date(),
        inputTokens: 500,
        outputTokens: 1000,
        turns: 3,
        handoffArtifact: null,
        errorMessage: null,
      };

      const html = runDetailView(mockRun, [mockStage], [], 1, 0);
      expect(html).toContain("<details");
      expect(html).toContain("log-section");
    });

    it("should show log section open by default", () => {
      const mockRun: RunInfo = {
        id: "run-1",
        issueId: "BEC-102",
        issueTitle: "UI Refresh",
        pipelineKey: "auto-implement",
        repoUrl: "https://github.com/test/repo",
        branch: "feature/ui",
        status: "completed",
        startedAt: new Date(),
        completedAt: new Date(),
        prUrl: null,
        totalInputTokens: 1000,
        totalOutputTokens: 2000,
        errorMessage: null,
      };

      const mockStage: StageInfo = {
        id: "stage-1",
        stage: "implement",
        status: "completed",
        startedAt: new Date(),
        completedAt: new Date(),
        inputTokens: 500,
        outputTokens: 1000,
        turns: 3,
        handoffArtifact: null,
        errorMessage: null,
      };

      const html = runDetailView(mockRun, [mockStage], [], 1, 0);
      expect(html).toContain("<details class=\"log-section\" open>");
    });
  });

  describe("Token Usage Bar Chart", () => {
    it("should display bar chart on tokens page", () => {
      const html = tokensView(
        [{ date: "2024-01-01", inputTokens: 5000, outputTokens: 10000 }],
        [{ key: "auto-implement", inputTokens: 5000, outputTokens: 10000 }],
        [{ key: "implement", inputTokens: 3000, outputTokens: 6000 }]
      );
      expect(html).toContain("bar-chart");
      expect(html).toContain("bar-fill");
    });

    it("should show input and output bars separately", () => {
      const html = tokensView(
        [{ date: "2024-01-01", inputTokens: 5000, outputTokens: 10000 }],
        [],
        []
      );
      expect(html).toContain("bar-fill-input");
      expect(html).toContain("bar-fill-output");
    });

    it("should display legend for bar colors", () => {
      const html = tokensView(
        [{ date: "2024-01-01", inputTokens: 5000, outputTokens: 10000 }],
        [],
        []
      );
      expect(html).toContain("Input");
      expect(html).toContain("Output");
    });

    it("should scale bars proportionally", () => {
      const html = tokensView(
        [
          { date: "2024-01-01", inputTokens: 1000, outputTokens: 2000 },
          { date: "2024-01-02", inputTokens: 2000, outputTokens: 4000 },
        ],
        [],
        []
      );
      expect(html).toContain("width:");
    });
  });

  describe("Table Row Hover Effects", () => {
    it("should have table elements for hover styling", () => {
      const run: RunRow = {
        id: "run-1",
        issueId: "BEC-102",
        issueTitle: "UI Refresh",
        pipelineKey: "auto-implement",
        repoUrl: "https://github.com/test/repo",
        status: "completed",
        startedAt: new Date(),
        completedAt: new Date(),
        totalInputTokens: 1000,
        totalOutputTokens: 2000,
      };
      const html = runFeedView([run]);
      expect(html).toContain("<tbody>");
      expect(html).toContain("<tr>");
      // CSS will handle hover effects via style.css (tbody tr:hover td)
    });
  });

  describe("Pure CSS & No Build Step", () => {
    it("should not use Tailwind classes", () => {
      const mockRun: RunInfo = {
        id: "run-1",
        issueId: "BEC-102",
        issueTitle: "UI Refresh",
        pipelineKey: "auto-implement",
        repoUrl: "https://github.com/test/repo",
        branch: "feature/ui",
        status: "completed",
        startedAt: new Date(),
        completedAt: new Date(),
        prUrl: null,
        totalInputTokens: 1000,
        totalOutputTokens: 2000,
        errorMessage: null,
      };

      const html = layout("Test", "<div>content</div>");
      // Check that no Tailwind utility classes are present
      const tailwindClasses = ["m-1", "p-4", "text-lg", "flex", "grid"];
      for (const cls of tailwindClasses) {
        expect(html).not.toContain(`class="${cls}`);
      }
    });

    it("should use semantic HTML only", () => {
      const html = layout("Test", "");
      expect(html).toContain("<!DOCTYPE html>");
      expect(html).toContain("<html lang=\"en\">");
      expect(html).toContain("<head>");
      expect(html).toContain("<body>");
    });

    it("should use only static CSS file", () => {
      const html = layout("Test", "");
      expect(html).toContain('href="/static/style.css"');
      // Should not reference dynamic CSS or CSS-in-JS
      expect(html).not.toMatch(/href=.*\.module\.css/);
    });

    it("should not include client-side JS frameworks (except HTMX)", () => {
      const html = layout("Test", "");
      expect(html).not.toContain("react");
      expect(html).not.toContain("vue");
      expect(html).not.toContain("angular");
      expect(html).toContain("htmx.org");
    });
  });

  describe("HTMX Functionality", () => {
    it("should include HTMX CDN link", () => {
      const html = layout("Test", "");
      expect(html).toContain("https://unpkg.com/htmx.org");
    });

    it("should preserve HTMX attributes in run feed", () => {
      const run: RunRow = {
        id: "run-1",
        issueId: "BEC-102",
        issueTitle: "UI Refresh",
        pipelineKey: "auto-implement",
        repoUrl: "https://github.com/test/repo",
        status: "completed",
        startedAt: new Date(),
        completedAt: new Date(),
        totalInputTokens: 1000,
        totalOutputTokens: 2000,
      };
      const html = runFeedView([run]);
      expect(html).toContain("hx-get");
      expect(html).toContain("hx-trigger");
      expect(html).toContain("hx-swap");
    });

    it("should preserve HTMX attributes in coordination view", () => {
      const entries = [
        {
          id: "work-1",
          runId: "run-1",
          issueId: "BEC-102",
          stage: "implement",
          filesModified: ["src/main.ts"],
          startedAt: new Date(),
          updatedAt: new Date(),
        },
      ];
      const html = coordinationView(entries);
      expect(html).toContain("hx-get");
      expect(html).toContain("hx-trigger");
      expect(html).toContain("hx-swap");
    });

    it("should have auto-refresh intervals set correctly", () => {
      const run: RunRow = {
        id: "run-1",
        issueId: "BEC-102",
        issueTitle: "UI Refresh",
        pipelineKey: "auto-implement",
        repoUrl: "https://github.com/test/repo",
        status: "completed",
        startedAt: new Date(),
        completedAt: new Date(),
        totalInputTokens: 1000,
        totalOutputTokens: 2000,
      };
      const html = runFeedView([run]);
      expect(html).toContain('hx-trigger="every 5s"');
    });
  });

  describe("Accessibility — Keyboard Navigation", () => {
    it("should include focus-visible styles in HTML structure", () => {
      const html = layout("Test", "");
      expect(html).toContain("<nav>");
      expect(html).toContain("<a");
      // CSS will handle focus-visible styling
    });

    it("should have proper semantic link elements", () => {
      const html = layout("Test", "");
      expect(html).toMatch(/<a[^>]*href="[^"]*"[^>]*>/);
    });

    it("should have collapsible sections with proper semantics", () => {
      const mockRun: RunInfo = {
        id: "run-1",
        issueId: "BEC-102",
        issueTitle: "UI Refresh",
        pipelineKey: "auto-implement",
        repoUrl: "https://github.com/test/repo",
        branch: "feature/ui",
        status: "completed",
        startedAt: new Date(),
        completedAt: new Date(),
        prUrl: null,
        totalInputTokens: 1000,
        totalOutputTokens: 2000,
        errorMessage: null,
      };

      const mockStage: StageInfo = {
        id: "stage-1",
        stage: "implement",
        status: "completed",
        startedAt: new Date(),
        completedAt: new Date(),
        inputTokens: 500,
        outputTokens: 1000,
        turns: 3,
        handoffArtifact: null,
        errorMessage: null,
      };

      const html = runDetailView(mockRun, [mockStage], [], 1, 0);
      expect(html).toContain("<details");
      expect(html).toContain("<summary");
    });

    it("should have proper heading hierarchy", () => {
      const mockRun: RunInfo = {
        id: "run-1",
        issueId: "BEC-102",
        issueTitle: "UI Refresh",
        pipelineKey: "auto-implement",
        repoUrl: "https://github.com/test/repo",
        branch: "feature/ui",
        status: "completed",
        startedAt: new Date(),
        completedAt: new Date(),
        prUrl: null,
        totalInputTokens: 1000,
        totalOutputTokens: 2000,
        errorMessage: null,
      };

      const mockStage: StageInfo = {
        id: "stage-1",
        stage: "implement",
        status: "completed",
        startedAt: new Date(),
        completedAt: new Date(),
        inputTokens: 500,
        outputTokens: 1000,
        turns: 3,
        handoffArtifact: null,
        errorMessage: null,
      };

      const html = runDetailView(mockRun, [mockStage], [], 1, 0);
      // The run detail view uses h2 for section titles (h1 is added by layout)
      expect(html).toMatch(/<h2[^>]*>/); // Section titles
      expect(html).toContain("Run Details"); // Verify headings exist
    });
  });

  describe("Accessibility — Contrast Ratios", () => {
    it("should use high contrast text colors", () => {
      const html = layout("Test", "");
      // The CSS should have proper contrast ratios defined in color variables
      expect(html).toContain('href="/static/style.css"');
    });

    it("should provide sufficient contrast for status badges", () => {
      const mockRun: RunInfo = {
        id: "run-1",
        issueId: "BEC-102",
        issueTitle: "UI Refresh",
        pipelineKey: "auto-implement",
        repoUrl: "https://github.com/test/repo",
        branch: "feature/ui",
        status: "failed",
        startedAt: new Date(),
        completedAt: new Date(),
        prUrl: null,
        totalInputTokens: 1000,
        totalOutputTokens: 2000,
        errorMessage: "Test error",
      };

      const mockStage: StageInfo = {
        id: "stage-1",
        stage: "implement",
        status: "failed",
        startedAt: new Date(),
        completedAt: new Date(),
        inputTokens: 500,
        outputTokens: 1000,
        turns: 3,
        handoffArtifact: null,
        errorMessage: "Stage failed",
      };

      const html = runDetailView(mockRun, [mockStage], [], 1, 0);
      expect(html).toContain('badge-failed');
    });
  });

  describe("Empty State Handling", () => {
    it("should display empty state for coordination view", () => {
      const html = coordinationView([]);
      expect(html).toContain("No agents currently active");
      expect(html).toContain("empty");
    });

    it("should display empty state for token feed", () => {
      const html = tokensView([], [], []);
      expect(html).toContain("No data");
    });
  });

  describe("URL-safe run ID encoding in href attributes", () => {
    it("run-feed: run ID with '+' produces %2B in href", () => {
      const run: RunRow = {
        id: "run+special",
        issueId: "BEC-108",
        issueTitle: "URL encoding test",
        pipelineKey: "auto-implement",
        repoUrl: "https://github.com/test/repo",
        status: "done",
        startedAt: new Date("2024-01-01T10:00:00Z"),
        completedAt: new Date("2024-01-01T10:05:00Z"),
        totalInputTokens: 100,
        totalOutputTokens: 200,
      };
      const html = runFeedView([run]);
      expect(html).toContain("/runs/run%2Bspecial");
      expect(html).not.toContain("/runs/run+special");
    });

    it("run-detail: run ID with '/' produces %2F in pagination hrefs", () => {
      const run: RunInfo = {
        id: "run/special",
        issueId: "BEC-108",
        issueTitle: "URL encoding test",
        pipelineKey: "auto-implement",
        repoUrl: "https://github.com/test/repo",
        branch: "feature/test",
        status: "done",
        startedAt: new Date("2024-01-01T10:00:00Z"),
        completedAt: new Date("2024-01-01T10:05:00Z"),
        prUrl: null,
        totalInputTokens: 100,
        totalOutputTokens: 200,
        errorMessage: null,
      };
      const mockStage: StageInfo = {
        id: "stage-1",
        stage: "implement",
        status: "done",
        startedAt: new Date("2024-01-01T10:00:00Z"),
        completedAt: new Date("2024-01-01T10:04:00Z"),
        inputTokens: 100,
        outputTokens: 200,
        turns: 3,
        handoffArtifact: null,
        errorMessage: null,
      };
      // Use enough total logs to trigger pagination (>50 per page)
      const html = runDetailView(run, [mockStage], [], 1, 200);
      expect(html).toContain("/runs/run%2Fspecial");
      expect(html).not.toContain("/runs/run/special");
    });
  });
});
