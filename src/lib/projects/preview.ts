import type { ProjectFile } from "@/lib/projects/paths";

function normaliseRef(ref: string): string {
  return ref.replace(/^\.?\/+/, "").split(/[?#]/)[0];
}

export function buildPreviewHtml(files: ProjectFile[]): { html: string; available: boolean; message: string } {
  const htmlFile =
    files.find((file) => /(^|\/)index\.html?$/i.test(file.path)) ??
    files.find((file) => /\.html?$/i.test(file.path));
  if (!htmlFile || htmlFile.encoding === "base64") {
    return {
      html: "",
      available: false,
      message: files.some((file) => /package\.json$/i.test(file.path))
        ? "This looks like a framework project. Static Live Preview needs an index.html — framework builds are not compiled here."
        : "A browser preview needs an index.html file. Source is still available in Files.",
    };
  }

  const byPath = new Map(files.map((file) => [normaliseRef(file.path).toLowerCase(), file]));
  const base = htmlFile.path.includes("/") ? htmlFile.path.slice(0, htmlFile.path.lastIndexOf("/") + 1) : "";

  const find = (ref: string) => {
    const norm = normaliseRef(ref).toLowerCase();
    const baseNorm = normaliseRef(base + ref).toLowerCase();
    const baseName = norm.split("/").pop() ?? "";
    return (
      byPath.get(norm) ??
      byPath.get(baseNorm) ??
      files.find((f) => normaliseRef(f.path).toLowerCase().split("/").pop() === baseName) ??
      (baseName.endsWith(".css") ? files.find((f) => f.path.toLowerCase().endsWith(".css")) : undefined) ??
      (baseName.endsWith(".js") ? files.find((f) => f.path.toLowerCase().endsWith(".js")) : undefined)
    );
  };

  let html = htmlFile.content;

  // Replace stylesheet <link> tags with inlined <style>
  html = html.replace(/<link\b([^>]*?)href=["']([^"']+\.css(?:[?#][^"']*)?)["']([^>]*)\/?>/gi, (full, _before: string, href: string) => {
    if (/^https?:\/\//i.test(href) || href.startsWith("//")) return full;
    const css = find(href);
    if (!css || css.encoding === "base64") return full;
    return `<style data-qorvyna-source="${normaliseRef(href)}">\n${css.content.replace(/<\/style/gi, "<\\/style")}\n</style>`;
  });

  // Replace script tags with inlined <script>
  html = html.replace(/<script\b([^>]*?)src=["']([^"']+\.(?:js|mjs|cjs|ts)(?:[?#][^"']*)?)["']([^>]*)>\s*<\/script>/gi, (full, before: string, src: string, after: string) => {
    if (/^https?:\/\//i.test(src) || src.startsWith("//")) return full;
    const js = find(src);
    if (!js || js.encoding === "base64") return full;
    const isModule = /type=["']module["']/i.test(before) || /type=["']module["']/i.test(after);
    const typeAttr = isModule ? ' type="module"' : "";
    return `<script${typeAttr} data-qorvyna-source="${normaliseRef(src)}">\n${js.content.replace(/<\/script/gi, "<\\/script")}\n</script>`;
  });

  // Replace image/asset references with base64/data URIs
  html = html.replace(/(?:src|href)=["']([^"']+\.(?:png|jpe?g|gif|webp|svg|ico|avif)(?:[?#][^"']*)?)["']/gi, (full, ref: string) => {
    if (/^https?:\/\//i.test(ref) || ref.startsWith("//") || ref.startsWith("data:")) return full;
    const asset = find(ref);
    if (!asset) return full;
    if (asset.encoding === "base64") {
      const ext = ref.split(".").pop()?.split("?")[0]?.toLowerCase() ?? "png";
      const mime = ext === "svg" ? "image/svg+xml" : ext === "ico" ? "image/x-icon" : `image/${ext === "jpg" ? "jpeg" : ext}`;
      return full.replace(ref, `data:${mime};base64,${asset.content}`);
    }
    if (/\.svg$/i.test(ref)) {
      return full.replace(ref, `data:image/svg+xml;charset=utf-8,${encodeURIComponent(asset.content)}`);
    }
    return full;
  });

  if (!/<meta\s+name=["']viewport/i.test(html)) {
    if (/<head\b[^>]*>/i.test(html)) {
      html = html.replace(/(<head\b[^>]*>)/i, '$1\n<meta name="viewport" content="width=device-width, initial-scale=1">');
    }
  }

  return { html, available: true, message: "Static HTML/CSS/JavaScript preview" };
}

// ---------------------------------------------------------------------------
// Editor issue detection (structure-aware, dependency-free so it can run inside
// the browser bundle). This replaces the old naive "< vs >" character count that
// produced false positives on ordinary JavaScript (arrow functions, comparisons)
// and could never localize the offending line. See review P1-3.
// ---------------------------------------------------------------------------

const HTML_VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

function lineOf(content: string, index: number): number {
  let line = 1;
  const limit = Math.max(0, Math.min(index, content.length));
  for (let i = 0; i < limit; i++) if (content.charCodeAt(i) === 10) line++;
  return line;
}

/** Mask JS/TS string/template/comment bodies so bracket scanning is not fooled
 * by their contents. Newlines are preserved so line numbers stay valid. */
function maskJsLiterals(code: string): string {
  const out: string[] = new Array(code.length);
  let i = 0;
  const fill = (from: number, to: number) => {
    for (let k = from; k < to && k < code.length; k++) out[k] = code[k] === "\n" ? "\n" : " ";
  };
  while (i < code.length) {
    const ch = code[i];
    const next = code[i + 1];
    if (ch === "/" && next === "/") {
      const end = code.indexOf("\n", i);
      const stop = end === -1 ? code.length : end;
      fill(i, stop);
      i = stop;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = code.indexOf("*/", i + 2);
      const stop = end === -1 ? code.length : end + 2;
      fill(i, stop);
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      let closed = false;
      while (j < code.length) {
        if (code[j] === "\\") { j += 2; continue; }
        if (code[j] === ch) { closed = true; j++; break; }
        if (code[j] === "\n" && ch !== "`") break;
        j++;
      }
      if (ch !== "`" && !closed) {
        const end = code.indexOf("\n", i);
        fill(i, end === -1 ? code.length : end);
        i = end === -1 ? code.length : end;
        continue;
      }
      fill(i, j);
      i = j;
      continue;
    }
    out[i] = ch;
    i++;
  }
  return out.join("");
}

function bracketName(open: string): string {
  return open === "{" ? "curly braces" : open === "(" ? "parentheses" : "square brackets";
}

/** Scan masked code for the first unbalanced bracket; returns its line. */
function firstUnbalancedLine(masked: string): { label: string; line: number } | null {
  const openers = "{[(";
  const closers: Record<string, string> = { "}": "{", "]": "[", ")": "(" };
  const stack: Array<{ ch: string; index: number }> = [];
  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i];
    if (openers.includes(ch)) {
      stack.push({ ch, index: i });
      continue;
    }
    if (closers[ch]) {
      const top = stack.pop();
      if (!top || top.ch !== closers[ch]) {
        return { label: bracketName(closers[ch]), line: lineOf(masked, i) };
      }
    }
  }
  if (stack.length) {
    const top = stack[stack.length - 1];
    return { label: bracketName(top.ch), line: lineOf(masked, top.index) };
  }
  return null;
}

/** Parser-based HTML structure check. Template/script/style/comment bodies are
 * not treated as markup, so JS comparisons and arrow functions never trip it. */
function htmlStructureIssues(html: string): string[] {
  const issues: string[] = [];
  const stack: Array<{ name: string; line: number }> = [];
  let i = 0;
  const n = html.length;
  while (i < n) {
    if (html.startsWith("<!--", i)) {
      const e = html.indexOf("-->", i + 4);
      i = e === -1 ? n : e + 3;
      continue;
    }
    if (html.startsWith("<!", i)) {
      const e = html.indexOf(">", i);
      i = e === -1 ? n : e + 1;
      continue;
    }
    if (html[i] === "<") {
      const gt = html.indexOf(">", i);
      if (gt === -1) {
        issues.push(`Unclosed tag starting at line ${lineOf(html, i)}.`);
        break;
      }
      const inner = html.slice(i + 1, gt).trim();
      i = gt + 1;
      if (inner.length === 0) continue;
      if (inner[0] === "/") {
        const name = inner.slice(1).trim().split(/\s/)[0].toLowerCase();
        let found = -1;
        for (let s = stack.length - 1; s >= 0; s--) {
          if (stack[s].name === name) { found = s; break; }
        }
        if (found !== -1) stack.length = found; // auto-close any inner tags
        continue;
      }
      const selfClose = /\/\s*$/.test(inner);
      const name = inner.split(/[\s/>]/)[0].toLowerCase();
      if (!name) continue;
      if (name === "script" || name === "style") {
        const closeTag = `</${name}>`;
        const closeIdx = html.toLowerCase().indexOf(closeTag, i);
        i = closeIdx === -1 ? n : closeIdx + closeTag.length;
        continue;
      }
      if (!selfClose && !HTML_VOID_ELEMENTS.has(name)) {
        stack.push({ name, line: lineOf(html, i) });
      }
      continue;
    }
    i++;
  }
  while (stack.length && issues.length < 3) {
    const t = stack.pop()!;
    issues.push(`Unclosed <${t.name}> opened at line ${t.line}.`);
  }
  return issues;
}

function jsonIssueDetail(content: string, error: unknown): string | null {
  const msg = error instanceof Error ? error.message : String(error);
  const posMatch = /position (\d+)/i.exec(msg);
  if (posMatch) return `JSON parse error near line ${lineOf(content, Number(posMatch[1]))}: ${msg}`;
  return `JSON parse error: ${msg}`;
}

export function detectEditorIssues(path: string, content: string): string[] {
  const issues: string[] = [];
  if (/\.html?$/i.test(path)) {
    issues.push(...htmlStructureIssues(content));
  } else if (/\.json$/i.test(path)) {
    if (content.trim().length) {
      try {
        JSON.parse(content);
      } catch (err) {
        const detail = jsonIssueDetail(content, err);
        if (detail) issues.push(detail);
      }
    }
  } else if (/\.(?:js|mjs|cjs|ts|tsx)$/i.test(path)) {
    const unbalanced = firstUnbalancedLine(maskJsLiterals(content));
    if (unbalanced) issues.push(`JavaScript ${unbalanced.label} look unbalanced (around line ${unbalanced.line}).`);
  }
  return issues.slice(0, 4);
}
