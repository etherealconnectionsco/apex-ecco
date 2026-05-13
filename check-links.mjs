#!/usr/bin/env node
/**
 * ECCO link integrity check — v5 (multi-target + cloud-tolerant)
 * ---------------------------------------------------------------
 * Merges:
 *   - SPA-canonical multi-target architecture (TARGETS array,
 *     per-target self-reference env var, base-dir-aware local
 *     path resolution, preconnect/dns-prefetch context-skip)
 *   - apex v4 cloud-block tolerance (CLOUD_BLOCK_TOLERANT_HOSTS/PATHS,
 *     tolerated status codes 401/403/451/999, browser UA, retries
 *     with backoff, 30s timeout, concurrency 4)
 *
 * v4 → v5 changes:
 *   + Multi-target: TARGETS array drives coverage. Each target =
 *     one HTML file; add an entry to bring a surface under integrity.
 *   + Per-target self-reference env var (chicken-and-egg skip for
 *     a doc citing its own canonical URL before it exists).
 *   + Full href/src extraction (was http-URL-only): catches local
 *     files (seal.jpg), mailto:, anchors (#section), absolute URLs.
 *   + Base-dir-aware local path resolution: master-context/index.html's
 *     relative seal.jpg resolves under master-context/, not apex root.
 *   + Preconnect/dns-prefetch context-skip by parsing <link> tags
 *     (the root-path 404 from these hint URLs is expected behavior).
 *
 * v4 behavior preserved verbatim:
 *   - 30s timeout, concurrency 4, retries (1500ms backoff)
 *   - Browser UA + full Accept headers
 *   - SKIP_PATTERNS (own-domain, fonts/scripts, login-walled)
 *   - TOLERATED_STATUS (401/403/451/999 anti-bot signal)
 *   - CLOUD_BLOCK_TOLERANT_HOSTS (federal/regulatory cloud-IP blocks)
 *   - CLOUD_BLOCK_TOLERANT_PATHS (sub-tree path-level cloud blocks)
 *
 * Doctrine: "Every claim verifiable. Every link live."
 * Live = reachable by a human in a browser. Not "reachable by every bot."
 *
 * Doctrinal note on the cloud-block whitelist (kept here on purpose,
 * not hidden): adding hosts is a pragmatic concession to a pattern we
 * did not create and cannot fix from a build runner. For those hosts,
 * "live" means reachable in a residential browser — verified by manual
 * spot-check at the time of whitelisting and on a quarterly review
 * cadence. The compromise is named in code so the next reader sees
 * exactly where doctrine yields to infrastructure reality.
 *
 * Rule for adding a host: confirmed cloud-IP block AND manual browser
 * verification at the time of addition.
 * ---------------------------------------------------------------
 */

import { readFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ═══════════════════════════════════════════════════════════
//  TARGETS — surfaces under integrity coverage
// ═══════════════════════════════════════════════════════════
// Each target = an HTML file. Add an entry to extend coverage.
//   path         relative to this script (apex root)
//   label        for log output
//   selfEnvVar   name of env var holding canonical URL for
//                self-reference skip (optional; null if N/A)
const TARGETS = [
  {
    path: 'index.html',
    label: 'apex',
    selfEnvVar: 'APEX_CANONICAL',
  },
  {
    path: 'master-context/index.html',
    label: 'master-context',
    selfEnvVar: 'MASTER_CONTEXT_CANONICAL',
  },
];

// ═══════════════════════════════════════════════════════════
//  TIMING & CONCURRENCY
// ═══════════════════════════════════════════════════════════
const TIMEOUT_MS = Number(process.env.LINK_CHECK_TIMEOUT_MS) || 30_000;
const CONCURRENCY = 4;
const RETRIES = 2;

// ═══════════════════════════════════════════════════════════
//  HTTP HEADERS — present as residential browser
// ═══════════════════════════════════════════════════════════
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const ACCEPT_HEADERS = {
  'User-Agent': BROWSER_UA,
  'Accept':
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,' +
    'image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
};

// ═══════════════════════════════════════════════════════════
//  TOLERANCE — anti-bot status codes + cloud-IP block whitelist
// ═══════════════════════════════════════════════════════════

// Anti-automation status codes — site loads for humans, refuses bots.
const TOLERATED_STATUS = new Set([401, 403, 451, 999]);

// URLs we never even attempt — own domain, font/script CDNs, login-walled.
// The own-domain skip is a coarse fallback; the per-target selfEnvVar
// handles canonical self-references more precisely. Both can apply.
const SKIP_PATTERNS = [
  /etherealconnectionsco\.com/,
  /fonts\.googleapis\.com/,
  /fonts\.gstatic\.com/,
  /www\.w3\.org/,
  /script\.google\.com/,
  /linkedin\.com/,
];

// Hosts confirmed (May 1–2 2026 build runs) to refuse AWS/Netlify traffic
// while loading normally in residential browsers. Conservative list — only
// add a host after a confirmed false positive AND a manual spot-check.
const CLOUD_BLOCK_TOLERANT_HOSTS = new Set([
  'fda.gov',           'www.fda.gov',
  'usda.gov',          'www.usda.gov',
  'fcc.gov',           'www.fcc.gov',
  'ama-assn.org',      'www.ama-assn.org',
  'epa.gov',           'www.epa.gov',
  'healthit.gov',      'www.healthit.gov',
  'nvlpubs.nist.gov',
  'usnews.com',        'www.usnews.com',
  // Returns persistent 500 to cloud runners; loads in residential browsers.
  // Same operational signature as the 4xx cloud-block pattern.
  'ilga.gov',          'www.ilga.gov',
]);

// Narrower than full-host: specific path patterns on hosts whose root
// works fine from cloud but where a particular sub-tree is blocked.
const CLOUD_BLOCK_TOLERANT_PATHS = [
  // FTC business-guidance blog: ftc.gov root works; this path 404s from cloud.
  /^https?:\/\/(www\.)?ftc\.gov\/business-guidance\/blog\//i,
  // DOJ realpage path observed cloud-blocked (404 to cloud, 200 to humans).
  /^https?:\/\/(www\.)?justice\.gov\/.*realpage/i,
  // NIST system/files PDFs — host nist.gov ok, this sub-tree blocks cloud.
  /^https?:\/\/(www\.)?nist\.gov\/system\/files\//i,
];

// ═══════════════════════════════════════════════════════════
//  EXTRACTION PATTERNS
// ═══════════════════════════════════════════════════════════
const HREF_RE = /(?:href|src)=["']([^"']+)["']/gi;
const LINK_TAG_RE = /<link\s+[^>]+>/gi;
const HINT_REL_RE = /\b(?:preconnect|dns-prefetch)\b/i;
const MAILTO_RE = /^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ANCHOR_RE = /^#/;
const ABS_URL_RE = /^https?:\/\//i;

// ═══════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════
function color(c, s) {
  const codes = { red: 31, green: 32, yellow: 33, cyan: 36, dim: 2, reset: 0 };
  return `\x1b[${codes[c]}m${s}\x1b[0m`;
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); }
  catch { return ''; }
}

function isCloudBlockTolerant(url) {
  if (CLOUD_BLOCK_TOLERANT_HOSTS.has(hostOf(url))) return true;
  return CLOUD_BLOCK_TOLERANT_PATHS.some((re) => re.test(url));
}

function matchesSkipPattern(url) {
  return SKIP_PATTERNS.some((p) => p.test(url));
}

// ═══════════════════════════════════════════════════════════
//  LOCAL FILE CHECK — base-dir-aware
// ═══════════════════════════════════════════════════════════
async function checkLocal(linkPath, baseDir) {
  // Strip query/hash. Resolve relative paths against the TARGET's
  // directory (so master-context/index.html's `seal.jpg` resolves to
  // master-context/seal.jpg). Absolute paths (starting with /) resolve
  // against the publish root (the script's directory).
  const cleaned = linkPath.split('#')[0].split('?')[0];
  if (!cleaned) return { ok: true, kind: 'anchor-only' };
  const fsPath = cleaned.startsWith('/')
    ? resolve(__dirname, '.' + cleaned)
    : resolve(baseDir, cleaned);
  try {
    await access(fsPath, constants.R_OK);
    return { ok: true, kind: 'local', path: fsPath };
  } catch {
    return { ok: false, kind: 'local-missing', path: fsPath };
  }
}

// ═══════════════════════════════════════════════════════════
//  REMOTE CHECK — with retries, tolerance classification
// ═══════════════════════════════════════════════════════════
async function checkRemote(url, attempt = 0) {
  const ctrl = new AbortController();
  const t = globalThis.setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: ctrl.signal,
      headers: ACCEPT_HEADERS,
    });
    const ok = res.status >= 200 && res.status < 400;
    const transient5xx = res.status >= 500 && res.status < 600;

    // Retry on transient 5xx
    if (transient5xx && attempt < RETRIES) {
      globalThis.clearTimeout(t);
      await sleep(1500);
      return checkRemote(url, attempt + 1);
    }

    // Tolerated by status code (anti-bot signal)?
    let tolerated = TOLERATED_STATUS.has(res.status);
    let toleratedReason = tolerated ? 'anti-bot status' : null;

    // Tolerated by cloud-block whitelist?
    if (!ok && !tolerated && isCloudBlockTolerant(url)) {
      tolerated = true;
      toleratedReason = 'cloud-block-tolerant';
    }

    return { ok, tolerated, toleratedReason, status: res.status, kind: 'remote' };
  } catch (err) {
    if (attempt < RETRIES) {
      await sleep(1500);
      return checkRemote(url, attempt + 1);
    }
    // Network error — tolerate if host is on the cloud-block whitelist.
    if (isCloudBlockTolerant(url)) {
      return {
        ok: false, tolerated: true, toleratedReason: 'cloud-block-tolerant',
        status: 0, error: err.message, kind: 'remote',
      };
    }
    return {
      ok: false, tolerated: false, toleratedReason: null,
      status: 0, error: err.message, kind: 'remote',
    };
  } finally {
    globalThis.clearTimeout(t);
  }
}

// ═══════════════════════════════════════════════════════════
//  CONCURRENCY POOL
// ═══════════════════════════════════════════════════════════
async function runWithConcurrency(items, fn, n) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

// ═══════════════════════════════════════════════════════════
//  PER-TARGET CHECK
// ═══════════════════════════════════════════════════════════
async function checkTarget(target) {
  const targetPath = resolve(__dirname, target.path);
  const baseDir = dirname(targetPath);
  const selfUrl = target.selfEnvVar
    ? (process.env[target.selfEnvVar] || '').replace(/\/$/, '')
    : '';

  console.log(color('cyan', `\n━━━ ${target.label} · ${target.path} ━━━`));

  let html;
  try {
    html = await readFile(targetPath, 'utf8');
  } catch (err) {
    console.error(color('red', `  ✗ cannot read ${targetPath}: ${err.message}`));
    return {
      label: target.label,
      passed: 0, skipped: 0, tolerated: 0,
      failures: [{ link: target.path, result: { error: err.message } }],
    };
  }

  // Extract candidate links from href/src attributes
  const links = new Set();
  let match;
  while ((match = HREF_RE.exec(html)) !== null) {
    links.add(match[1].trim());
  }

  // Identify preconnect/dns-prefetch hint URLs to skip
  const hintUrls = new Set();
  let linkTagMatch;
  while ((linkTagMatch = LINK_TAG_RE.exec(html)) !== null) {
    const tagText = linkTagMatch[0];
    const relMatch = tagText.match(/rel=["']([^"']+)["']/i);
    if (!relMatch || !HINT_REL_RE.test(relMatch[1])) continue;
    const hrefMatch = tagText.match(/href=["']([^"']+)["']/i);
    if (hrefMatch) hintUrls.add(hrefMatch[1].trim());
  }

  console.log(color('dim', `  → ${links.size} unique link${links.size === 1 ? '' : 's'} extracted`));
  if (hintUrls.size) console.log(color('dim', `  → ${hintUrls.size} preconnect/dns-prefetch hint${hintUrls.size === 1 ? '' : 's'} will be skipped`));
  if (selfUrl) console.log(color('dim', `  → self-reference URL: ${selfUrl}`));
  console.log();

  // First pass: classify each link, segregate immediate-pass/skip from remote-check
  const remoteQueue = [];
  const immediate = []; // { link, result?, kind?, label }

  for (const link of links) {
    if (hintUrls.has(link)) {
      immediate.push({ link, result: { ok: true, kind: 'preconnect-hint' }, label: 'preconnect' });
      continue;
    }
    if (selfUrl && link.startsWith(selfUrl)) {
      immediate.push({ link, result: { ok: true, kind: 'self-reference' }, label: 'self-ref' });
      continue;
    }
    if (MAILTO_RE.test(link)) {
      immediate.push({ link, result: { ok: true, kind: 'mailto' }, label: 'mailto' });
      continue;
    }
    if (ANCHOR_RE.test(link)) {
      immediate.push({ link, result: { ok: true, kind: 'anchor' }, label: 'anchor' });
      continue;
    }
    if (link.startsWith('data:')) {
      immediate.push({ link, result: { ok: true, kind: 'data-uri' }, label: 'data-uri' });
      continue;
    }
    if (ABS_URL_RE.test(link)) {
      // Apply SKIP_PATTERNS to remote URLs
      if (matchesSkipPattern(link)) {
        immediate.push({ link, result: { ok: true, kind: 'skip-pattern' }, label: 'skip-pat' });
        continue;
      }
      remoteQueue.push(link);
      continue;
    }
    // Local file reference — check filesystem (resolved next)
    immediate.push({ link, kind: 'local-pending', label: 'local' });
  }

  // Resolve local file checks (sequential; fast)
  for (const item of immediate) {
    if (item.kind === 'local-pending') {
      item.result = await checkLocal(item.link, baseDir);
      item.label = item.result.ok ? 'local' : 'MISSING';
    }
  }

  // Run remote checks with concurrency
  let remoteResults = [];
  if (remoteQueue.length) {
    process.stdout.write(color('dim', `  fetching ${remoteQueue.length} remote URL${remoteQueue.length === 1 ? '' : 's'}…`));
    remoteResults = await runWithConcurrency(remoteQueue, (url) => checkRemote(url), CONCURRENCY);
    process.stdout.write(color('dim', ' done\n'));
  }

  // Log all results
  let passed = 0, skipped = 0, tolerated = 0;
  const failures = [];

  for (const item of immediate) {
    const { link, result, label } = item;
    if (result.ok) {
      const isSkip = ['preconnect', 'self-ref', 'data-uri', 'skip-pat'].includes(label);
      if (isSkip) {
        skipped++;
        console.log(`  ${color('yellow', '○')} ${color('dim', label.padEnd(14))} ${link}`);
      } else {
        passed++;
        console.log(`  ${color('green', '✓')} ${color('dim', label.padEnd(14))} ${link}`);
      }
    } else {
      failures.push({ link, result });
      console.log(`  ${color('red', '✗')} ${color('red', label.padEnd(14))} ${link}`);
    }
  }
  for (let i = 0; i < remoteQueue.length; i++) {
    const link = remoteQueue[i];
    const result = remoteResults[i];
    const status = result.status || (result.error ? 'NETERR' : '?');
    const remoteLabel = `[${status}]`.padEnd(8);
    if (result.ok) {
      passed++;
      console.log(`  ${color('green', '✓')} ${color('dim', remoteLabel)} remote      ${link}`);
    } else if (result.tolerated) {
      tolerated++;
      const reason = result.toleratedReason || 'tolerated';
      console.log(`  ${color('yellow', '⚠')} ${color('yellow', remoteLabel)} tolerated   ${link} ${color('dim', `— ${reason}`)}`);
    } else {
      failures.push({ link, result });
      console.log(`  ${color('red', '✗')} ${color('red', remoteLabel)} BROKEN      ${link}`);
    }
  }

  return { label: target.label, passed, skipped, tolerated, failures };
}

// ═══════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════
async function main() {
  console.log(color('dim', `\n  ECCO link integrity check v5 · ${TARGETS.length} target${TARGETS.length === 1 ? '' : 's'}`));

  const results = [];
  for (const target of TARGETS) {
    results.push(await checkTarget(target));
  }

  console.log();
  console.log(color('cyan', '━━━ summary ━━━'));
  let totalFailures = 0;
  let totalTolerated = 0;
  for (const r of results) {
    totalFailures += r.failures.length;
    totalTolerated += r.tolerated;
    const status = r.failures.length === 0
      ? color('green', `✓ pass`)
      : color('red', `✗ ${r.failures.length} broken`);
    const tail = `(${r.passed} ok · ${r.skipped} skip${r.tolerated ? ` · ${r.tolerated} tolerated` : ''})`;
    console.log(`  ${r.label.padEnd(20)} ${status}  ${color('dim', tail)}`);
  }
  console.log();

  if (totalFailures === 0) {
    if (totalTolerated) {
      console.log(color('yellow', `  ⚠ ${totalTolerated} tolerated (live for humans; build passes)`));
    }
    console.log(color('green', `\n  doctrine intact. deploy clear.\n`));
    process.exit(0);
  } else {
    console.log(color('red', `  ✗ ${totalFailures} broken across ${results.filter(r => r.failures.length).length} target${results.filter(r => r.failures.length).length === 1 ? '' : 's'}`));
    for (const r of results) {
      if (!r.failures.length) continue;
      console.log(color('red', `\n  ${r.label}:`));
      for (const { link, result } of r.failures) {
        const status = result.status || (result.error ? 'NETERR' : 'missing');
        console.log(color('red', `    [${status}] ${link}`));
        if (result.error) console.log(color('dim', `      ${result.error}`));
        if (result.path) console.log(color('dim', `      ${result.path}`));
      }
    }
    console.log();
    process.exit(1);
  }
}

main().catch(err => {
  console.error(color('red', `✗ unexpected: ${err.stack || err.message}`));
  process.exit(3);
});
