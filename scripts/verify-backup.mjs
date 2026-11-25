#!/usr/bin/env node
// =============================================================================
// QORVYNA AI — Offline / Staging Backup Manifest Verifier (by OKGS).
//
// Usage:
//   node scripts/verify-backup.mjs <path-to-manifest.json>
//
// Validates that a staging restore manifest contains non-empty collection counts
// and matches its canonical SHA-256 inventory digest before an operator records
// a recovery drill as verified. Never fabricates a cloud export.
// =============================================================================

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const file = process.argv[2];
if (!file) {
  console.error("Usage: node scripts/verify-backup.mjs <manifest.json>");
  process.exit(2);
}

let raw;
try {
  raw = JSON.parse(readFileSync(file, "utf8"));
} catch (err) {
  console.error("Failed to parse manifest JSON:", err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const { manifestId, projectId, exportedAt, targetEnvironment, collections, expectedSha256 } = raw ?? {};
if (
  typeof manifestId !== "string" ||
  typeof projectId !== "string" ||
  typeof exportedAt !== "string" ||
  !["staging", "local_dr", "isolated_restore"].includes(targetEnvironment) ||
  !collections ||
  typeof collections !== "object" ||
  typeof expectedSha256 !== "string"
) {
  console.error("MANIFEST_SCHEMA_INVALID");
  process.exit(1);
}

const keys = Object.keys(collections).sort();
if (keys.length === 0) {
  console.error("MANIFEST_EMPTY_COLLECTIONS");
  process.exit(1);
}

const ordered = keys.map((k) => `${k}:${collections[k]}`).join("|");
const payload = `${manifestId}\n${projectId}\n${exportedAt}\n${ordered}`;
const computed = createHash("sha256").update(payload, "utf8").digest("hex");

if (computed.toLowerCase() !== expectedSha256.toLowerCase()) {
  console.error(`MANIFEST_DIGEST_MISMATCH: expected ${expectedSha256}, computed ${computed}`);
  process.exit(1);
}

console.log(JSON.stringify({ valid: true, manifestId, targetEnvironment, collections: keys.length, sha256: computed }, null, 2));
