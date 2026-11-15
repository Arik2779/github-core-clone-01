// Shared helpers for the forge: deterministic time, opaque global ids, base64 and
// a small line diff. Nothing here reads the wall clock or Math.random: the trial
// time comes from MAKEFUN_TRIAL_NOW, parsed once at startup.

/** The trial's fixed now: an RFC 3339 instant, or epoch milliseconds. */
export function parseTrialNow(raw: string | undefined): { epochSec: number; iso: string } {
  const fallback = { epochSec: 1735689600, iso: '2026-01-01T00:00:00Z' };
  if (raw === undefined || raw === '') return fallback;
  const asMillis = Number(raw);
  if (Number.isFinite(asMillis) && /^\d+$/.test(raw.trim())) {
    const epochSec = Math.floor(asMillis / 1000);
    return { epochSec, iso: new Date(epochSec * 1000).toISOString().replace('.000Z', 'Z') };
  }
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return fallback;
  const epochSec = Math.floor(ms / 1000);
  return { epochSec, iso: new Date(epochSec * 1000).toISOString().replace('.000Z', 'Z') };
}

/** ISO 8601 (UTC) for an epoch second. */
export function isoOfEpoch(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString().replace('.000Z', 'Z');
}

/** Base64 (standard alphabet) of a UTF-8 string. */
export function b64encodeText(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/** Base64 of raw bytes. */
export function b64encodeBytes(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/** Decode standard base64, ignoring whitespace/newlines folded into it. */
export function b64decodeText(content: string): Buffer {
  return Buffer.from(content.replace(/[\r\n\t ]+/g, ''), 'base64');
}

/**
 * An opaque Relay-style global id: base64 of `<Kind>:<part>:<part>`. It is never the
 * plain database id or number, and it decodes back to the same object.
 */
export function globalId(kind: string, ...parts: readonly (string | number)[]): string {
  return b64encodeText([kind, ...parts.map(String)].join(':'));
}

/** Decode a global id, or null when it is not one of ours. */
export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id.replace(/[\r\n\t ]+/g, ''), 'base64').toString('utf8');
    const segments = text.split(':');
    if (segments.length < 2) return null;
    const kind = segments[0]!;
    if (kind === '' || /[^A-Za-z]/.test(kind)) return null;
    return { kind, parts: segments.slice(1) };
  } catch {
    return null;
  }
}

/** A line count diff between two texts: {added, deleted} in lines, via LCS. */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  const n = oldLines.length;
  const m = newLines.length;
  if (n === 0) return { additions: m, deletions: 0 };
  if (m === 0) return { additions: 0, deletions: n };
  // LCS length via a two-row DP; files here are small (a few KiB at most).
  let prev = new Array<number>(m + 1).fill(0);
  let cur = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    cur[0] = 0;
    for (let j = 1; j <= m; j += 1) {
      cur[j] = oldLines[i - 1] === newLines[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  const lcs = prev[m];
  return { additions: m - lcs, deletions: n - lcs };
}

/** Lowercase 40-hex test for an object id. */
export const HEX40 = /^[0-9a-f]{40}$/;
export function isOid(value: string): boolean {
  return HEX40.test(value);
}

/** Split a path into segments, dropping empty ones. */
export function pathSegments(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '');
}

/** A name the REST/GitHub surface accepts (owner, repo, branch, label). */
export function isValidName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value);
}
