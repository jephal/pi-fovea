// Defense in depth for model-facing text and overflow artifacts. Sensitive
// files are excluded before extraction; these patterns cover accidental inline
// credentials in otherwise legitimate source/signatures without claiming to be
// a full secret scanner.

import { constants, lstatSync, mkdirSync, openSync, closeSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REDACTED = "[REDACTED]";

export const redactSensitiveText = (input: string): string => input
  .replace(/-----BEGIN (?:[A-Z0-9 ]* )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]* )?PRIVATE KEY-----/g, REDACTED)
  .replace(/\b(?:ghp|github_pat|glpat|xox[baprs])_[A-Za-z0-9_-]{12,}\b/g, REDACTED)
  .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, REDACTED)
  .replace(/\b((?:api[_-]?key|access[_-]?token|auth(?:orization)?|client[_-]?secret|password|secret|token)\s*(?:=|:))\s*(?:["']?)[^\s,"'`)}\]]{8,}/gi, `$1 ${REDACTED}`);

/**
 * Stronger value-level scrubbing for durable facts. Extraction often stores a
 * string literal without its surrounding `API_KEY =` context, so persistence
 * must also recognize credential-bearing URLs and common standalone API keys.
 */
export const redactSensitiveValue = (input: string): string => redactSensitiveText(input)
  .replace(/\b(?:sk|rk)-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g, REDACTED)
  .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, REDACTED)
  .replace(/\bAKIA[0-9A-Z]{16}\b/g, REDACTED)
  .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REDACTED}@`)
  .replace(/([?&](?:api[_-]?key|access[_-]?token|auth(?:orization)?|client[_-]?secret|password|secret|token)=)[^&#\s]+/gi, `$1${REDACTED}`);

/** Recursively copy JSON-compatible cache payloads while redacting strings. */
export const redactSensitiveCacheValue = <T>(value: T): T => {
  if (typeof value === "string") return redactSensitiveValue(value) as T;
  if (Array.isArray(value)) return value.map(redactSensitiveCacheValue) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => [redactSensitiveValue(key), redactSensitiveCacheValue(entry)])) as T;
  }
  return value;
};

const overflowDir = (): string => {
  const dir = join(tmpdir(), "pi-fovea-overflow");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info = lstatSync(dir);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("fovea overflow directory is unsafe");
  chmodSync(dir, 0o700);
  return dir;
};

/** A path under a process-private directory, never directly in world tmp. */
export const privateOverflowPath = (name: string): string => join(overflowDir(), name);

/** O_NOFOLLOW + 0600 closes the artifact symlink and disclosure gap. */
export const writePrivateArtifact = (path: string, contents: string): void => {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, redactSensitiveText(contents), "utf8"); } finally { closeSync(fd); }
  chmodSync(path, 0o600);
};
