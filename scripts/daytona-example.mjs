#!/usr/bin/env node
// =============================================================================
// QORVYNA AI — Daytona Cloud Sandbox example (standalone smoke test).
//
//   node scripts/daytona-example.mjs
//   DAYTONA_TARGET=eu node scripts/daytona-example.mjs
//
// Creates an ephemeral sandbox on Daytona Cloud, runs Python code and a shell
// command inside it, uploads a workspace file, then deletes the sandbox — the
// same lifecycle the app uses (src/lib/server/daytona.ts).
//
// Credentials: DAYTONA_API_KEY (required; get one at https://app.daytona.io).
// Optional: DAYTONA_TARGET (region, e.g. "us" or "eu"),
//           DAYTONA_API_URL (custom endpoint, server only).
//
// SDK 2.x note: `create`/`get`/`delete` moved off the root client — they live
// on `daytona.v0` (the Daytona v0 platform). This script uses the root client
// and falls back exactly like the app's openDaytonaSdk() helper, so it works
// with @daytona/sdk 2.x and still honours 0.x-style mocks.
// =============================================================================

import { Daytona } from "@daytona/sdk";

const apiKey = (process.env.DAYTONA_API_KEY ?? "").trim();
if (!apiKey) {
  console.error(
    "DAYTONA_API_KEY is not set. Get an API key at https://app.daytona.io\n" +
      "and run:  DAYTONA_API_KEY=dtn_... node scripts/daytona-example.mjs",
  );
  process.exit(1);
}
const target = (process.env.DAYTONA_TARGET ?? "").trim();
const apiUrl = (process.env.DAYTONA_API_URL ?? "").trim();

// Resolve the sandbox-management client across SDK 2.x (`daytona.v0`) and
// anything that still exposes `create` at the root (0.x-shaped instances).
function openDaytonaSdk() {
  const daytona = new Daytona({
    apiKey,
    ...(target ? { target } : {}),
    ...(apiUrl ? { apiUrl } : {}),
  });
  const root = daytona;
  const client = Reflect.has(daytona, "create") ? root : daytona.v0;
  return {
    client,
    close: () => (typeof daytona.close === "function" ? daytona.close().catch(() => {}) : Promise.resolve()),
  };
}

const { client, close } = openDaytonaSdk();
let sandbox = null;
try {
  console.log("Creating an ephemeral Python sandbox…");
  sandbox = await client.create(
    { language: "python", ephemeral: true, autoStopInterval: 15 },
    { timeout: 45 },
  );
  console.log(`Sandbox ready: ${sandbox.id ?? "(no id)"}`);

  // 1) Run code inside the sandbox (Python; codeRun auto-detects it).
  const response = await sandbox.process.codeRun('print("Hello World")');
  console.log(`codeRun  → exit ${response.exitCode}: ${response.result.trim()}`);

  // 2) Run a shell command inside the same sandbox.
  const exec = await sandbox.process.executeCommand("echo sandboxed at $(pwd)");
  console.log(`shell    → exit ${exec.exitCode}: ${exec.result.trim()}`);

  // 3) Upload a file into the sandbox workspace and read it back.
  if (typeof sandbox.fs?.uploadFiles === "function") {
    await sandbox.fs.uploadFiles([
      { source: Buffer.from("hello from QORVYNA\n"), destination: "hello.txt" },
    ]);
    const cat = await sandbox.process.executeCommand("cat hello.txt");
    console.log(`file     → exit ${cat.exitCode}: ${cat.result.trim()}`);
  }
  console.log("Daytona sandbox example finished successfully.");
} catch (error) {
  console.error(`Daytona sandbox example failed: ${error?.message ?? error}`);
  process.exitCode = 1;
} finally {
  if (sandbox && typeof client.delete === "function") {
    await client.delete(sandbox, 15).catch(() => {});
    console.log("Sandbox deleted.");
  } else if (sandbox && typeof sandbox.delete === "function") {
    await sandbox.delete(15).catch(() => {});
    console.log("Sandbox deleted.");
  }
  await close();
}
