// Structure-aware editor issue detection (review P1-3).
//
// The old check counted raw "<" vs ">" characters and cried wolf on ordinary
// JavaScript. These tests prove the new parser-based checks do not produce false
// positives and still catch real problems with line numbers.
import { describe, expect, it } from "vitest";
import { detectEditorIssues } from "@/lib/projects/preview";

describe("detectEditorIssues", () => {
  it("does not flag balanced HTML that embeds JS with < and =>", () => {
    const html = `<!doctype html>
<html lang="en">
<head><title>Test</title></head>
<body>
<button onclick="handle()">Click</button>
<script>
  const bigger = (a) => (a > 5 ? "x<y" : "z");
  if (n < 10) console.log(bigger(n));
</script>
</body>
</html>`;
    expect(detectEditorIssues("index.html", html)).toEqual([]);
  });

  it("reports an unclosed tag with its line number", () => {
    const html = `<div>\n  <span>unclosed\n`;
    const issues = detectEditorIssues("page.html", html);
    expect(issues.some((i) => i.includes("Unclosed <span>") && i.includes("line 2"))).toBe(true);
  });

  it("reports a JSON parse error mentioning JSON", () => {
    const json = `{\n  "a": 1,\n  "b": `;
    const issues = detectEditorIssues("data.json", json);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]).toMatch(/JSON parse error/);
  });

  it("ignores braces that only appear inside string literals", () => {
    const js = `const s = "}}}}{{{";\nfunction f() { return 1; }`;
    expect(detectEditorIssues("main.js", js)).toEqual([]);
  });

  it("flags genuinely unbalanced JS braces with a line", () => {
    const js = `function f() {\n  return 1;\n`;
    const issues = detectEditorIssues("main.js", js);
    expect(issues.some((i) => i.includes("curly braces") && i.includes("line"))).toBe(true);
  });

  it("flags unbalanced parentheses taken from inside a comment", () => {
    // The only "(" is inside a line comment, so masked scanning finds balance.
    const js = `// note: (this is just a comment)\nconst x = 1;`;
    expect(detectEditorIssues("note.js", js)).toEqual([]);
  });
});
