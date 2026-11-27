import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createMock, codeRunMock, executeCommandMock, uploadFilesMock, deleteMock, closeMock, daytonaInitSpy } =
  vi.hoisted(() => ({
    createMock: vi.fn(),
    codeRunMock: vi.fn(),
    executeCommandMock: vi.fn(),
    uploadFilesMock: vi.fn(),
    deleteMock: vi.fn(),
    closeMock: vi.fn(),
    daytonaInitSpy: vi.fn(),
  }));

vi.mock("@daytona/sdk", () => ({
  Daytona: class MockDaytona {
    v0: {
      create: typeof createMock;
      delete: typeof deleteMock;
    };
    constructor(config: unknown) {
      daytonaInitSpy(config);
      this.v0 = {
        create: createMock,
        delete: deleteMock,
      };
    }
    close() {
      return closeMock();
    }
  },
}));

vi.mock("@/lib/firebase/admin", async () => {
  const { sharedFirestoreStub, makeAdminModule } = await import("./helpers/firestore-stub");
  const mod = makeAdminModule(sharedFirestoreStub());
  return {
    ...mod,
    adminConfigured: () => true,
  };
});

const getApiSessionUserMock = vi.fn();
vi.mock("@/lib/firebase/device-session", () => ({
  getApiSessionUser: (...args: unknown[]) => getApiSessionUserMock(...args),
}));

import { sharedFirestoreStub } from "./helpers/firestore-stub";
import {
  decryptDaytonaKey,
  encryptDaytonaKey,
  getDaytonaStatus,
  migrateLegacyDaytonaUserKey,
  runDaytonaCode,
  saveDaytonaSystemConnection,
} from "../src/lib/server/daytona";
import { GET as daytonaGet, POST as daytonaPost } from "../src/app/api/daytona/route";
import { toolRegistry } from "../src/lib/ai/tools/registry";
import "../src/lib/ai/tools/index";

const stub = sharedFirestoreStub();
const SYNTHETIC_KEY = "dtn_synthetic_test_key_000000009876";

/** Seed the caller as super admin so admin-only Daytona lifecycle is allowed. */
function grantSuperAdmin(uid: string) {
  stub._state.docs.set(`admin_role_assignments/${uid}`, { role_id: "super_admin" });
}

beforeEach(() => {
  process.env.PROVIDER_SECRET_KEY = "test-secret-encryption-key-for-daytona-32c";
  delete process.env.DAYTONA_API_KEY;
  stub._state.docs.clear();
  daytonaInitSpy.mockReset();
  createMock.mockReset();
  codeRunMock.mockReset();
  executeCommandMock.mockReset();
  uploadFilesMock.mockReset();
  deleteMock.mockReset();
  closeMock.mockReset();

  deleteMock.mockResolvedValue(undefined);
  closeMock.mockResolvedValue(undefined);
  uploadFilesMock.mockResolvedValue(undefined);
  createMock.mockResolvedValue({
    id: "sbx_test_123",
    process: {
      codeRun: codeRunMock,
      executeCommand: executeCommandMock,
    },
    fs: {
      uploadFiles: uploadFilesMock,
    },
  });

  getApiSessionUserMock.mockReset();
  getApiSessionUserMock.mockResolvedValue({
    uid: "user-1",
    email: "u@example.com",
    emailVerified: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function adminRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/daytona", {
    method: "POST",
    headers: { Origin: "http://localhost:3000", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Daytona Cloud Sandbox (@daytona/sdk) integration", () => {
  it("encrypts Daytona API keys at rest and exposes only masked metadata", async () => {
    const cipher = encryptDaytonaKey(SYNTHETIC_KEY);
    expect(cipher).not.toContain(SYNTHETIC_KEY);
    expect(decryptDaytonaKey(cipher)).toBe(SYNTHETIC_KEY);

    const saved = await saveDaytonaSystemConnection("admin-1", {
      apiKey: SYNTHETIC_KEY,
      target: "us",
    });
    expect(saved).toEqual({
      configured: true,
      encryptionAvailable: true,
      source: "system",
      keyLast4: "9876",
      keyMask: "dtn_***9876",
      target: "us",
      sdk: "@daytona/sdk",
    });

    const getRes = await daytonaGet(new NextRequest("http://localhost:3000/api/daytona"));
    expect(getRes.status).toBe(200);
    const body = await getRes.json();
    expect(body.keyMask).toBe("dtn_***9876");
    expect(JSON.stringify(body)).not.toContain(SYNTHETIC_KEY);
  });

  it("runs TypeScript code via @daytona/sdk sandbox.process.codeRun, scrubs secrets, and cleans up sandbox", async () => {
    await saveDaytonaSystemConnection("admin-1", { apiKey: SYNTHETIC_KEY, target: "us" });
    codeRunMock.mockResolvedValue({
      exitCode: 0,
      result: `Hello World! Key=${SYNTHETIC_KEY}`,
      artifacts: { stdout: `Hello World! Key=${SYNTHETIC_KEY}` },
    });

    const res = await runDaytonaCode({
      code: 'console.log("Hello World!");',
      language: "typescript",
      projectFiles: [{ path: "src/app.ts", content: "export const x = 1;" }],
    });

    expect(daytonaInitSpy).toHaveBeenCalledWith({ apiKey: SYNTHETIC_KEY, target: "us" });
    expect(createMock).toHaveBeenCalledWith(
      { language: "typescript", ephemeral: true, autoStopInterval: 15 },
      { timeout: 45 },
    );
    expect(uploadFilesMock).toHaveBeenCalledTimes(1);
    expect(codeRunMock).toHaveBeenCalledWith('console.log("Hello World!");', undefined, 30);
    expect(res.exitCode).toBe(0);
    expect(res.sandboxId).toBe("sbx_test_123");
    // Active Daytona API key must never leak in output
    expect(res.result).not.toContain(SYNTHETIC_KEY);
    expect(res.stdout).toContain("[REDACTED_DAYTONA_KEY]");
    expect(deleteMock).toHaveBeenCalledTimes(1);
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it("executes /api/daytona POST configure + exec as admin and gates daytona.code_run tool behind approval", async () => {
    grantSuperAdmin("user-1");

    const cfgRes = await daytonaPost(
      adminRequest({ action: "configure", apiKey: SYNTHETIC_KEY, target: "eu" }),
    );
    expect(cfgRes.status).toBe(200);
    expect((await getDaytonaStatus()).target).toBe("eu");

    executeCommandMock.mockResolvedValue({
      exitCode: 0,
      result: "index.html\nstyles.css\n",
    });

    const execReq = adminRequest({ action: "exec", command: "ls -1" });
    const execRes = await daytonaPost(execReq);
    expect(execRes.status).toBe(200);
    const execData = await execRes.json();
    expect(execData.result.exitCode).toBe(0);
    expect(execData.result.result).toContain("index.html");

    // Registered AI tool daytona.code_run requires approval
    const spec = toolRegistry.get("daytona.code_run");
    expect(spec?.approvalRequired).toBe(true);
    const ctx = { db: stub, uid: "user-1", email: "u@example.com", requestId: "req-dtn" };
    const denied = await toolRegistry.call(
      ctx,
      "daytona.code_run",
      { code: "console.log(1)", language: "typescript" },
      async () => true,
    );
    expect(denied.ok).toBe(false);
    expect(denied.error).toBe("APPROVAL_REQUIRED");

    codeRunMock.mockResolvedValue({ exitCode: 0, result: "42\n" });
    const approved = await toolRegistry.call(
      { ...ctx, approvalId: "valid-approval" },
      "daytona.code_run",
      { code: "console.log(42)", language: "typescript" },
      async () => true,
      async () => true,
    );
    expect(approved.ok).toBe(true);
    expect(approved.data?.result).toBe("42\n");
  });

  it("rejects Daytona configuration from non-admin users", async () => {
    getApiSessionUserMock.mockResolvedValue({
      uid: "user-2",
      email: "regular@example.com",
      emailVerified: true,
    });

    const cfgRes = await daytonaPost(
      adminRequest({ action: "configure", apiKey: SYNTHETIC_KEY, target: "eu" }),
    );
    expect(cfgRes.status).toBe(403);

    const disconnectRes = await daytonaPost(adminRequest({ action: "disconnect" }));
    expect(disconnectRes.status).toBe(403);

    const migrateRes = await daytonaPost(adminRequest({ action: "migrate_legacy" }));
    expect(migrateRes.status).toBe(403);

    // Execution still resolves against system/env config only.
    const status = await getDaytonaStatus();
    expect(status.configured).toBe(false);
    expect(status.source).toBe("none");
  });

  it("migrates legacy per-user keys into the single shared system key and purges them", async () => {
    const older = encryptDaytonaKey("dtn_old_user_key_0000000000001111");
    const newest = encryptDaytonaKey(SYNTHETIC_KEY);
    stub._state.docs.set("daytona_connections/user-a", {
      user_id: "user-a",
      api_key_encrypted: older,
      target: "",
      updated_at: 1,
    });
    stub._state.docs.set("daytona_connections/user-b", {
      user_id: "user-b",
      api_key_encrypted: newest,
      target: "eu",
      updated_at: 2,
    });

    const { status, migrated } = await migrateLegacyDaytonaUserKey("admin-1");
    expect(migrated).toBe(true);
    expect(status.configured).toBe(true);
    expect(status.source).toBe("system");
    expect(status.target).toBe("eu");

    // The one system key replaced every per-user key.
    const remaining = [...stub._state.docs.keys()].filter((k) => k.startsWith("daytona_connections/"));
    expect(remaining).toEqual([]);

    // Sandbox execution now works for any authenticated user via the system key.
    codeRunMock.mockResolvedValue({ exitCode: 0, result: "ok" });
    const res = await runDaytonaCode({ code: "console.log('ok');" });
    expect(res.exitCode).toBe(0);
    expect(daytonaInitSpy).toHaveBeenCalledWith({ apiKey: SYNTHETIC_KEY, target: "eu" });
  });

  it("falls back to env DAYTONA_API_KEY when no system key is configured", async () => {
    process.env.DAYTONA_API_KEY = SYNTHETIC_KEY;
    process.env.DAYTONA_TARGET = "us";

    const status = await getDaytonaStatus();
    expect(status.configured).toBe(true);
    expect(status.source).toBe("env");

    codeRunMock.mockResolvedValue({ exitCode: 0, result: "ok" });
    const res = await runDaytonaCode({ code: "console.log('ok');" });
    expect(res.exitCode).toBe(0);
    expect(daytonaInitSpy).toHaveBeenCalledWith({ apiKey: SYNTHETIC_KEY, target: "us" });
  });
});
