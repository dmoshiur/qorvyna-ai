import { describe, expect, it } from "vitest";
import type { ProjectFile } from "@/lib/projects/paths";
import {
  computeUnifiedFileDiff,
  executeWorkspaceCommand,
  tokenizeWorkspaceCommand,
  type TerminalProjectAdapter,
} from "@/lib/terminal/engine";

function makeInMemoryAdapter(initialFiles: ProjectFile[] = []) {
  let revision = 1;
  let files = [...initialFiles];

  const adapter: TerminalProjectAdapter = {
    getState: async () => ({
      projectId: "proj_ws_1",
      title: "Demo Workspace",
      revision,
      uid: "user_terminal_owner",
      files,
    }),
    upsertFile: async (path, content, expectedRevision) => {
      if (expectedRevision !== revision) throw new Error("REVISION_CONFLICT");
      revision += 1;
      const idx = files.findIndex((f) => f.path === path);
      const entry: ProjectFile = { path, content, encoding: "utf8", language: "text" };
      if (idx >= 0) files[idx] = entry;
      else files.push(entry);
      return { revision };
    },
    renameFile: async (from, to, expectedRevision) => {
      if (expectedRevision !== revision) throw new Error("REVISION_CONFLICT");
      const target = files.find((f) => f.path === from);
      if (!target) throw new Error("NOT_FOUND");
      revision += 1;
      files = files.map((f) => (f.path === from ? { ...f, path: to } : f));
    },
    deleteFile: async (path, expectedRevision) => {
      if (expectedRevision !== revision) throw new Error("REVISION_CONFLICT");
      revision += 1;
      files = files.filter((f) => f.path !== path);
    },
  };
  return { adapter, getFiles: () => files, getRevision: () => revision };
}

describe("Priority 3: Built-in AI Terminal (qsh) & Governed Coding Workspace", () => {
  it("blocks shell injection metacharacters, subshells, pipes, and redirections", () => {
    for (const bad of [
      "ls; cat /etc/passwd",
      "ls && whoami",
      "ls || pwd",
      "cat index.html | grep h1",
      "js `process.exit()`",
      "js $( uname -a )",
      "write a.txt hi > /tmp/out",
    ]) {
      const tok = tokenizeWorkspaceCommand(bad);
      expect(tok.ok).toBe(false);
    }
  });

  it("executes real project inspection, build validation, CAS mutations, and HITL-gated delete", async () => {
    const { adapter, getFiles } = makeInMemoryAdapter([
      {
        path: "index.html",
        content: '<!DOCTYPE html><html><head><link rel="stylesheet" href="styles.css"/></head><body><h1>Hello OKGS</h1></body></html>',
        encoding: "utf8",
        language: "html",
      },
      {
        path: "styles.css",
        content: "body { background: #000; color: #fff; }",
        encoding: "utf8",
        language: "css",
      },
    ]);

    const lsRes = await executeWorkspaceCommand("ls", adapter);
    expect(lsRes.exitCode).toBe(0);
    expect(lsRes.stdout).toContain("index.html");

    const grepRes = await executeWorkspaceCommand("grep OKGS", adapter);
    expect(grepRes.exitCode).toBe(0);
    expect(grepRes.stdout).toContain("index.html:1:");

    const valRes = await executeWorkspaceCommand("validate", adapter);
    expect(valRes.exitCode).toBe(0);
    expect(valRes.stdout).toContain("Blocking: NO");

    // env never exposes host process.env secrets
    process.env.TEST_SUPER_SECRET_TOKEN = "should_never_leak";
    const envRes = await executeWorkspaceCommand("env", adapter);
    expect(envRes.stdout).toContain("QORVYNA_HOST_ENV_EXPOSED=false");
    expect(envRes.stdout).not.toContain("should_never_leak");
    delete process.env.TEST_SUPER_SECRET_TOKEN;

    // Write + rename
    const writeRes = await executeWorkspaceCommand('write calc.js "console.log(6 * 7)"', adapter);
    expect(writeRes.exitCode).toBe(0);
    expect(writeRes.mutatedProject).toBe(true);

    const runRes = await executeWorkspaceCommand("run calc.js", adapter);
    expect(runRes.exitCode).toBe(0);
    expect(runRes.stdout.trim()).toBe("42");

    // rm without confirmDestructive MUST pause for HITL confirmation without deleting
    const rmBlocked = await executeWorkspaceCommand("rm calc.js", adapter);
    expect(rmBlocked.exitCode).toBe(2);
    expect(rmBlocked.requiresConfirmation?.targetPath).toBe("calc.js");
    expect(getFiles().some((f) => f.path === "calc.js")).toBe(true);

    // rm with explicit HITL confirmation deletes cleanly
    const rmApproved = await executeWorkspaceCommand("rm calc.js", adapter, {
      confirmDestructive: true,
    });
    expect(rmApproved.exitCode).toBe(0);
    expect(getFiles().some((f) => f.path === "calc.js")).toBe(false);
  });

  it("isolates the JS VM against process/eval escapes, infinite loops, and honest unsupported OS binaries", async () => {
    const { adapter } = makeInMemoryAdapter([
      { path: "notes.txt", content: "QORVYNA", encoding: "utf8", language: "text" },
    ]);

    // process is undefined in VM
    const procCheck = await executeWorkspaceCommand("js typeof process", adapter);
    expect(procCheck.exitCode).toBe(0);
    expect(procCheck.stdout.trim()).toBe("undefined");

    // eval() / dynamic code generation is disabled
    const evalCheck = await executeWorkspaceCommand('js eval("1+1")', adapter);
    expect(evalCheck.exitCode).toBe(1);

    // Infinite loop terminates cleanly at ~350ms timeout
    const loopCheck = await executeWorkspaceCommand("js while(true){}", adapter);
    expect(loopCheck.exitCode).toBe(1);
    expect(loopCheck.stderr.toLowerCase()).toContain("timed out");

    // Unsupported OS binary fails honestly with exitCode 126
    const npmCheck = await executeWorkspaceCommand("npm install express", adapter);
    expect(npmCheck.exitCode).toBe(126);
    expect(npmCheck.stderr).toContain("COMMAND_NOT_PERMITTED_IN_SANDBOX");
  });

  it("computes accurate unified file diffs for added, modified, and unchanged files", () => {
    const added = computeUnifiedFileDiff("new.js", undefined, "const a = 1;\n");
    expect(added.changeType).toBe("added");
    expect(added.addedLines).toBe(2);

    const mod = computeUnifiedFileDiff("app.js", "const a = 1;\n", "const a = 2;\n");
    expect(mod.changeType).toBe("modified");
    expect(mod.addedLines).toBe(1);
    expect(mod.removedLines).toBe(1);

    const same = computeUnifiedFileDiff("app.js", "same", "same");
    expect(same.changeType).toBe("unchanged");
  });

  it("initializes a project with files at the workspace root (no /docs or /web) and resolves that root", async () => {
    const { adapter } = makeInMemoryAdapter([
      { path: "index.html", content: "<h1>Root project</h1>", encoding: "utf8", language: "html" },
      { path: "learn.html", content: "<h1>Learn</h1>", encoding: "utf8", language: "html" },
    ]);

    // A fresh agent-generated project with index.html at the root must never
    // hit PROJECT_INIT_ERROR: init resolves the actual workspace root.
    const lsRes = await executeWorkspaceCommand("ls", adapter);
    expect(lsRes.exitCode).toBe(0);
    expect(lsRes.stdout).toContain("index.html");
    expect(lsRes.stdout).toContain("learn.html");
    expect(lsRes.stderr).not.toContain("PROJECT_INIT_ERROR");

    const pwdRes = await executeWorkspaceCommand("pwd", adapter);
    expect(pwdRes.stdout.trim()).toBe("/workspace/projects/proj_ws_1");

    const envRes = await executeWorkspaceCommand("env", adapter);
    expect(envRes.stdout).toContain("QORVYNA_PROJECT_ROOT=/workspace/projects/proj_ws_1");
    expect(envRes.stdout).toContain("QORVYNA_PROJECT_FS_ROOT=projects/proj_ws_1/files");

    const catRes = await executeWorkspaceCommand("cat index.html", adapter);
    expect(catRes.exitCode).toBe(0);
    expect(catRes.stdout).toContain("Root project");
  });

  it("runs compound && input sequentially and renders one labeled combined output", async () => {
    const { adapter } = makeInMemoryAdapter([
      { path: "index.html", content: "<h1>Root project</h1>", encoding: "utf8", language: "html" },
    ]);

    const res = await executeWorkspaceCommand("ls && cat index.html", adapter);
    expect(res.exitCode).toBe(0);
    expect(res.program).toBe("compound");
    expect(res.stdout).toContain("[1/2] $ ls");
    expect(res.stdout).toContain("[2/2] $ cat index.html");
    expect(res.stdout).toContain("index.html");
    expect(res.stdout).toContain("Root project");
  });

  it("refuses only the non-permitted part of a compound chain and stops", async () => {
    const { adapter } = makeInMemoryAdapter([
      { path: "index.html", content: "<h1>Root project</h1>", encoding: "utf8", language: "html" },
    ]);

    // ls runs; curl is refused; pwd after it must never run.
    const res = await executeWorkspaceCommand("ls && curl --version && pwd", adapter);
    expect(res.exitCode).toBe(126);
    expect(res.stdout).toContain("[1/3] $ ls");
    expect(res.stdout).toContain("index.html");
    expect(res.stdout).not.toContain("[3/3]");
    expect(res.stdout).not.toContain("/workspace/projects");
    expect(res.stderr).toContain("[2/3]");
    expect(res.stderr).toContain("COMMAND_NOT_PERMITTED_IN_SANDBOX");
    expect(res.stderr).toContain("curl");
  });

  it("stops a compound chain at a path-escape rejection", async () => {
    const { adapter } = makeInMemoryAdapter([
      { path: "index.html", content: "<h1>Root project</h1>", encoding: "utf8", language: "html" },
    ]);

    const res = await executeWorkspaceCommand("cat index.html && cat ../secret && pwd", adapter);
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("[1/3] $ cat index.html");
    expect(res.stdout).toContain("Root project");
    expect(res.stdout).not.toContain("[3/3]");
    expect(res.stderr).toContain("[2/3]");
    expect(res.stderr).toContain("PATH_ESCAPE_BLOCKED");
    expect(res.stderr).toContain("'..'");
  });

  it("refuses a compound part with unsupported shell metacharacters", async () => {
    const { adapter } = makeInMemoryAdapter([
      { path: "index.html", content: "<h1>Root project</h1>", encoding: "utf8", language: "html" },
    ]);

    const res = await executeWorkspaceCommand("ls; cat index.html | grep h1", adapter);
    expect(res.exitCode).toBe(2);
    expect(res.stdout).toContain("[1/2] $ ls");
    expect(res.stderr).toContain("[2/2]");
    expect(res.stderr).toContain("SHELL_METACHAR_BLOCKED");
  });

  it("names the exact offending segment on path escape attempts", async () => {
    const { adapter } = makeInMemoryAdapter([
      { path: "index.html", content: "<h1>Root project</h1>", encoding: "utf8", language: "html" },
    ]);

    const res = await executeWorkspaceCommand("cat ../../etc/passwd", adapter);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("PATH_ESCAPE_BLOCKED");
    expect(res.stderr).toContain("'..'");
    expect(res.stderr).toContain("Run 'help' for the project layout.");
  });

  it("help documents root resolution and governed compound input", async () => {
    const { adapter } = makeInMemoryAdapter([]);
    const res = await executeWorkspaceCommand("help", adapter);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("/docs and /web are optional conventions");
    expect(res.stdout).toContain("Compound input");
  });
});
