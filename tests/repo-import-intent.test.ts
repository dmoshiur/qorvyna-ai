// =============================================================================
// Issue 6 — repository URL recognition and import intent (pure helpers shared
// by the chat UI, the Agent tool and the server-side import).
// =============================================================================

import { describe, expect, it } from "vitest";
import {
  findRepoUrl,
  hasRepoImportIntent,
  isRepoImportRequest,
  parseRepoUrl,
} from "@/lib/repo-url";

describe("parseRepoUrl", () => {
  it("parses an https owner/repo URL and normalises the clone URL", () => {
    const parsed = parseRepoUrl("https://github.com/acme/widgets");
    expect(parsed).toEqual({
      owner: "acme",
      repo: "widgets",
      cloneUrl: "https://github.com/acme/widgets.git",
      htmlUrl: "https://github.com/acme/widgets",
    });
  });

  it("strips a trailing .git from both the match and the clone URL", () => {
    const parsed = parseRepoUrl("https://github.com/acme/widgets.git");
    expect(parsed?.repo).toBe("widgets");
    expect(parsed?.cloneUrl).toBe("https://github.com/acme/widgets.git");
  });

  it("accepts a URL embedded in prose and a URL with a trailing slash", () => {
    const inProse = parseRepoUrl("Please import this: https://github.com/acme/widgets/");
    expect(inProse?.owner).toBe("acme");
    const withGit = parseRepoUrl("clone https://github.com/acme/widgets.git for me");
    expect(withGit?.repo).toBe("widgets");
  });

  it("returns null for non-GitHub text, bare paths and other hosts", () => {
    expect(parseRepoUrl("no repo here")).toBeNull();
    expect(parseRepoUrl("https://gitlab.com/acme/widgets")).toBeNull();
    expect(parseRepoUrl("")).toBeNull();
  });
});

describe("findRepoUrl", () => {
  it("finds the first repo URL anywhere in the text", () => {
    expect(findRepoUrl("look at https://github.com/a/b then https://github.com/c/d")?.owner).toBe("a");
  });

  it("returns null when the text has no repo URL", () => {
    expect(findRepoUrl("just chatting")).toBeNull();
  });
});

describe("import intent", () => {
  it("recognises import/clone wording", () => {
    expect(hasRepoImportIntent("import this repo")).toBe(true);
    expect(hasRepoImportIntent("can you clone it for me")).toBe(true);
    expect(hasRepoImportIntent("how is the weather")).toBe(false);
  });

  it("is true only when both a URL and an import intent are present", () => {
    expect(isRepoImportRequest("import https://github.com/acme/widgets")).toBe(true);
    expect(isRepoImportRequest("https://github.com/acme/widgets")).toBe(false);
    expect(isRepoImportRequest("import my notes")).toBe(false);
  });
});
