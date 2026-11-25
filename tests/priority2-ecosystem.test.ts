import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isProviderDegraded,
  providerLatencyStats,
  recordProviderCall,
  resetProviderLatencyForTests,
} from "@/lib/ai/provider-latency";
import { classifyThreeWaySync } from "@/lib/server/github-sync";
import { invokeMcpConnector, listMcpConnectors } from "@/lib/server/mcp/registry";
import {
  computeBackupInventoryDigest,
  inspectFirebaseLifecycle,
  verifyBackupManifest,
} from "@/lib/server/firebase-lifecycle";

describe("Priority 2: Provider Latency Telemetry & Routing Health", () => {
  it("computes real sliding-window P50/P95 latency and degradation only from observed calls", () => {
    resetProviderLatencyForTests();
    expect(providerLatencyStats()).toEqual([]);

    for (const ms of [120, 140, 160, 180, 950]) {
      recordProviderCall("groq", "model-a", ms, true);
    }
    const all = providerLatencyStats();
    const snap = all.find((s) => s.provider === "groq" && s.model === "model-a");
    expect(snap).toBeDefined();
    expect(snap?.samples).toBe(5);
    expect(snap?.p50Ms).toBe(160);
    expect(snap?.p95Ms).toBe(950);
    expect(isProviderDegraded("groq", "model-a")).toBe(false);

    // High consecutive failure rate marks route degraded
    for (let i = 0; i < 6; i++) {
      recordProviderCall("cloudflare", "glm-4.7-flash", 400, false);
    }
    expect(isProviderDegraded("cloudflare", "glm-4.7-flash")).toBe(true);
    resetProviderLatencyForTests();
  });
});

describe("Priority 2: GitHub Safe 3-Way Sync Classification", () => {
  it("accurately classifies identical, modified_local, modified_remote, and conflict without silent overwrites", () => {
    const base = [
      { path: "index.html", content: "<h1>v1</h1>" },
      { path: "styles.css", content: "body { color: #fff; }" },
      { path: "conflict.js", content: "const x = 1;" },
    ];
    const local = [
      { path: "index.html", content: "<h1>v2-local</h1>" }, // modified_local
      { path: "styles.css", content: "body { color: #fff; }" }, // modified_remote
      { path: "conflict.js", content: "const x = 2;" }, // conflict
      { path: "local-only.txt", content: "draft" }, // added_local
    ];
    const remote = [
      { path: "index.html", content: "<h1>v1</h1>" },
      { path: "styles.css", content: "body { color: #000; }" },
      { path: "conflict.js", content: "const x = 3;" },
      { path: "remote-only.md", content: "# Docs" }, // added_remote
    ];

    const res = classifyThreeWaySync({ local, remote, base });
    expect(res.hasConflicts).toBe(true);
    expect(res.summary.modified_local).toBe(1);
    expect(res.summary.modified_remote).toBe(1);
    expect(res.summary.conflict).toBe(1);
    expect(res.summary.added_local).toBe(1);
    expect(res.summary.added_remote).toBe(1);
  });
});

describe("Priority 2: Governed MCP Registry & Ownership Isolation", () => {
  function makeMcpDb() {
    const projects = new Map<string, Record<string, unknown>>([
      ["proj_owned", { owner_id: "user_1", title: "My App", revision: 2 }],
      ["proj_other", { owner_id: "user_2", title: "Other Tenant App", revision: 1 }],
    ]);
    return {
      collection: (name: string) => ({
        where: (_field: string, _op: string, val: unknown) => ({
          get: async () => ({
            docs: [...projects.entries()]
              .filter(([, v]) => name === "projects" && v.owner_id === val)
              .map(([id, v]) => ({ id, data: () => v })),
          }),
        }),
        doc: (id: string) => ({
          get: async () => ({
            id,
            exists: name === "projects" && projects.has(id),
            data: () => (name === "projects" ? projects.get(id) : undefined),
          }),
          collection: () => ({
            get: async () => ({
              docs: [
                {
                  id: "f1",
                  data: () => ({ path: "index.html", content: "<h1>Hello</h1>", encoding: "utf8" }),
                },
              ],
            }),
          }),
        }),
      }),
    } as unknown as Parameters<typeof listMcpConnectors>[0];
  }

  it("reports unconfigured Google connectors honestly and blocks cross-tenant project reads", async () => {
    const db = makeMcpDb();
    const user1 = { uid: "user_1", email: "u1@okgs.info", emailVerified: true } as Parameters<typeof listMcpConnectors>[1];

    const list = await listMcpConnectors(db, user1);
    expect(list.find((c) => c.id === "workspace_projects")?.status).toBe("ready");
    expect(list.find((c) => c.id === "google_drive_mcp")?.status).toBe("not_configured");
    expect(list.find((c) => c.id === "gmail_mcp")?.status).toBe("not_configured");

    // Own project succeeds
    const ownRead = await invokeMcpConnector(db, user1, {
      connector: "workspace_projects",
      operation: "read_project_file",
      projectId: "proj_owned",
      path: "index.html",
    });
    expect(ownRead.ok).toBe(true);

    // Cross-tenant project read MUST be denied
    const crossRead = await invokeMcpConnector(db, user1, {
      connector: "workspace_projects",
      operation: "read_project_file",
      projectId: "proj_other",
      path: "index.html",
    });
    expect(crossRead.ok).toBe(false);
    expect(crossRead.error).toBe("PROJECT_NOT_FOUND");
  });
});

describe("Priority 2: Firebase Lifecycle & Staging Backup Manifest Verification", () => {
  it("validates SHA-256 staging restore manifests both in TypeScript and via scripts/verify-backup.mjs", async () => {
    const base = {
      manifestId: "drill_2026_11_25",
      projectId: "qorvyna-staging",
      exportedAt: "2026-11-25T10:00:00.000Z",
      collections: { users: 42, conversations: 128, projects: 19 },
    };
    const sha256 = computeBackupInventoryDigest(base);
    const validManifest = {
      ...base,
      targetEnvironment: "staging" as const,
      expectedSha256: sha256,
    };

    const res = verifyBackupManifest(validManifest);
    expect(res.valid).toBe(true);

    // Tampered count must fail closed
    const tampered = verifyBackupManifest({
      ...validManifest,
      collections: { ...base.collections, users: 999 },
    });
    expect(tampered.valid).toBe(false);
    expect(tampered.reason).toBe("MANIFEST_DIGEST_MISMATCH");

    // CLI script verification
    const dir = mkdtempSync(join(tmpdir(), "qorvyna-backup-"));
    try {
      const manifestPath = join(dir, "manifest.json");
      writeFileSync(manifestPath, JSON.stringify(validManifest, null, 2));
      const out = execFileSync("node", ["scripts/verify-backup.mjs", manifestPath], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      const parsed = JSON.parse(out);
      expect(parsed.valid).toBe(true);
      expect(parsed.sha256).toBe(sha256);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    // Bounded lifecycle probe
    const fakeDb = {
      collection: () => ({
        limit: () => ({
          get: async () => ({ docs: [] }),
        }),
        doc: () => ({
          get: async () => ({ exists: false, data: () => undefined }),
        }),
      }),
    } as unknown as Parameters<typeof inspectFirebaseLifecycle>[0];
    const snapshot = await inspectFirebaseLifecycle(fakeDb);
    expect(snapshot.collections.length).toBeGreaterThanOrEqual(4);
  });
});
