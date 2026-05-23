import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { layout, escapeHtml, getBasePath } from "../views/layout.js";
import { DASHBOARD_CSP } from "../csp.js";

describe("layout", () => {
  const originalEnv = process.env.DASHBOARD_BASE_PATH;

  afterEach(() => {
    delete process.env.DASHBOARD_BASE_PATH;
    if (originalEnv) {
      process.env.DASHBOARD_BASE_PATH = originalEnv;
    }
  });

  describe("basePath computation", () => {
    it("should use DASHBOARD_BASE_PATH environment variable", () => {
      process.env.DASHBOARD_BASE_PATH = "/ateam";
      expect(getBasePath()).toBe("/ateam");
    });

    it("should strip trailing slashes from DASHBOARD_BASE_PATH", () => {
      process.env.DASHBOARD_BASE_PATH = "/ateam/";
      expect(getBasePath()).toBe("/ateam");
    });

    it("should strip multiple trailing slashes", () => {
      process.env.DASHBOARD_BASE_PATH = "/ateam///";
      expect(getBasePath()).toBe("/ateam");
    });

    it("should be empty string when DASHBOARD_BASE_PATH is not set", () => {
      delete process.env.DASHBOARD_BASE_PATH;
      expect(getBasePath()).toBe("");
    });

    it("should be empty string when DASHBOARD_BASE_PATH is only slashes", () => {
      process.env.DASHBOARD_BASE_PATH = "///";
      expect(getBasePath()).toBe("");
    });
  });

  describe("HTML generation", () => {
    beforeEach(() => {
      // Mock a simple basePath for consistent tests
      process.env.DASHBOARD_BASE_PATH = "/ateam";
    });

    it("should generate valid HTML structure", () => {
      const html = layout("Test Page", "<p>Content</p>");
      expect(html).toContain("<!DOCTYPE html>");
      expect(html).toContain("<html lang=\"en\">");
      expect(html).toContain("</html>");
    });

    it("should include page title with escaped content", () => {
      const html = layout("Test & Title", "content");
      expect(html).toContain("<title>Test &amp; Title - urateam</title>");
    });

    it("should include static CSS link with basePath", () => {
      process.env.DASHBOARD_BASE_PATH = "/ateam";
      const html = layout("Test", "");
      expect(html).toContain("<link rel=\"stylesheet\" href=\"/ateam/static/style.css\">");
    });

    it("should include HTMX script", () => {
      const html = layout("Test", "");
      expect(html).toContain('<script src="https://unpkg.com/htmx.org@2.0.0"></script>');
      // Companion: the dialog-trigger script must also load (deferred,
      // same-origin) so retry-confirm modal opens under CSP `script-src 'self'`.
      expect(html).toContain('/static/dialog.js" defer');
    });

    it("should include navigation links with basePath", () => {
      process.env.DASHBOARD_BASE_PATH = "/ateam";
      const html = layout("Test", "");

      // Runs href omits trailing slash so it matches Hono's mount-prefix
      // routing — `/ateam/` 404s but `/ateam` matches the runs router's `/`.
      expect(html).toContain('<a href="/ateam">Runs</a>');
      expect(html).toContain('<a href="/ateam/tokens">Tokens</a>');
      expect(html).toContain('<a href="/ateam/errors">Errors</a>');
      expect(html).toContain('<a href="/ateam/config">Config</a>');
      expect(html).toContain('<a href="/ateam/coordination">Coordination</a>');
    });

    it("should include navigation links without basePath when not set", () => {
      delete process.env.DASHBOARD_BASE_PATH;
      const html = layout("Test", "");

      expect(html).toContain('<a href="/">Runs</a>');
      expect(html).toContain('<a href="/tokens">Tokens</a>');
      expect(html).toContain('<a href="/errors">Errors</a>');
      expect(html).toContain('<a href="/config">Config</a>');
      expect(html).toContain('<a href="/coordination">Coordination</a>');
    });

    it("should include page content", () => {
      const content = "<p>Test content here</p>";
      const html = layout("Test", content);
      expect(html).toContain(content);
    });

    it("should include viewport meta tag for responsive design", () => {
      const html = layout("Test", "");
      expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    });

    it("should escape special characters in page title", () => {
      const html = layout("<script>alert('xss')</script>", "");
      expect(html).toContain("&lt;script&gt;");
      expect(html).not.toContain("<script>alert");
    });
  });

  describe("escapeHtml function", () => {
    it("should escape ampersands", () => {
      expect(escapeHtml("A & B")).toBe("A &amp; B");
    });

    it("should escape less-than signs", () => {
      expect(escapeHtml("A < B")).toBe("A &lt; B");
    });

    it("should escape greater-than signs", () => {
      expect(escapeHtml("A > B")).toBe("A &gt; B");
    });

    it("should escape double quotes", () => {
      expect(escapeHtml('Say "Hello"')).toBe("Say &quot;Hello&quot;");
    });

    it("should escape single quotes", () => {
      expect(escapeHtml("It's fine")).toBe("It&#039;s fine");
    });

    it("should escape multiple special characters", () => {
      expect(escapeHtml('<script>alert("xss")</script>')).toBe(
        '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
      );
    });

    it("should handle empty string", () => {
      expect(escapeHtml("")).toBe("");
    });

    it("should handle string without special characters", () => {
      expect(escapeHtml("Hello World")).toBe("Hello World");
    });

    it("should escape in the correct order (ampersand first)", () => {
      // If we don't escape ampersand first, we might double-escape
      expect(escapeHtml("&lt;")).toBe("&amp;lt;");
    });
  });

  describe("Content-Security-Policy meta tag", () => {
    it("should embed the full DASHBOARD_CSP constant in the meta tag", () => {
      const html = layout("Test", "");
      expect(html).toContain('http-equiv="Content-Security-Policy"');
      expect(html).toContain(DASHBOARD_CSP);
    });

    it("should retain script-src restriction to self and unpkg.com", () => {
      expect(DASHBOARD_CSP).toContain("script-src 'self' https://unpkg.com");
      expect(DASHBOARD_CSP).not.toContain("script-src 'unsafe-inline'");
    });
  });

  describe("CSS and asset loading", () => {
    it("should use relative path for CSS when basePath is empty", () => {
      delete process.env.DASHBOARD_BASE_PATH;
      const html = layout("Test", "");
      expect(html).toContain('href="/static/style.css"');
      expect(html).toContain('src="/static/dialog.js"');
    });

    it("should use correct path for CSS with basePath /ateam", () => {
      process.env.DASHBOARD_BASE_PATH = "/ateam";
      const html = layout("Test", "");
      expect(html).toContain('href="/ateam/static/style.css"');
      expect(html).toContain('src="/ateam/static/dialog.js"');
    });

    it("should use correct path for CSS with custom basePath", () => {
      process.env.DASHBOARD_BASE_PATH = "/myapp";
      const html = layout("Test", "");
      expect(html).toContain('href="/myapp/static/style.css"');
      expect(html).toContain('src="/myapp/static/dialog.js"');
    });
  });
});
