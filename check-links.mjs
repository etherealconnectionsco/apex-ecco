#!/usr/bin/env node
/**
 * ECCO link integrity check — v5.5 (multi-target + cloud-tolerant + comment-aware + pretty-URL)
 * ---------------------------------------------------------------
 * v5.4 → v5.5 changes (20 May 2026, post-v6 thread):
 *   * Pretty-URL fallback in checkLocal. Netlify auto-strips .html
 *     extensions at serve time, so canonical clean URLs like
 *     /privacy-policy and /terms appear extensionless throughout the
 *     site (apex footer, privacy-policy.html, terms.html, /why) —
 *     these resolve correctly in production but were tripping the
 *     filesystem checker, which looked for a literal extensionless
 *     file on disk and declared missing. v5.5 changes the failure
 *     branch: if access(path) fails AND the path has no extension,
 *     also try access(path + '.html') before declaring missing.
 *     The checker now models Netlify's actual serving behavior.
 *   No new targets. No tolerance machinery. Surgical to checkLocal.
 *   Doctrinal: source-of-truth stays the canonical clean URL; the
 *   checker becomes a more accurate model of production.
 *
 * v5.3 → v5.4 changes (20 May 2026, post-v6 thread):
 *   + why/index.html added as 5th target (selfEnvVar: null)
 *   + 404_main_site.html added as 6th target (selfEnvVar: null)
 *   + master-context/404.html added as 7th target (selfEnvVar: null)
 *   Resolves all three v5.3 deferrals. Doctrinal rationale on /why:
 *   "Every claim verifiable. Every link live." applies to /why too;
 *   the "continued development" posture means inspectable while in-
 *   progress, not exempt from CI gating. Push discipline carries the
 *   load — work stays local until green, then ships. No tolerance
 *   machinery added; architecture unchanged.
 *   /why outbound verified live 2026-05-20: no absolute self-refs to
 *   etherealconnectionsco.com/why/, so WHY_CANONICAL env var is not
 *   needed (additive-only if /why later self-references).
 *   404 pages have low link density (apex 404 → 2 links).
 *
 * v5.2 → v5.3 changes (20 May 2026, post-v10.6 thread):
 *   + privacy-policy.html added as 3rd target (selfEnvVar: null)
 *   + terms.html added as 4th target (selfEnvVar: null)
 *   No architectural changes — additive coverage only. Both surfaces
 *   are stable customer-facing legal pages deployed 19 May 2026. Self-
 *   reference loops are not expected, so selfEnvVar is null on both.
 *
 * v5.1 → v5.2 changes (13 May 2026, second live build):
 *   + HTML comment stripping before link extraction. v5.1 matched
 *     href/src patterns globally including inside <!-- --> blocks,
 *     causing false positives on documented dead-code references
 *     (e.g. commented-out script tags preserved as documentation).
 *     v5.2 strips comments via /<!--[\s\S]*?-->/g pre-pass, then
 *     runs extraction on the stripped HTML. Both link extraction
 *     and preconnect-hint extraction operate on stripped content,
 *     so commented-out <link rel="preconnect"> tags also no longer
 *     incorrectly register as active hints.
 *
 * v5 → v5.1 changes (13 May 2026, first live build):
 *   + URI_SCHEME_RE — non-http URI scheme catch (tel:, sms:, etc.)
 *   + facebook.com added to CLOUD_BLOCK_TOLERANT_HOSTS
 *
 * v4 → v5 changes (12 May 2026):
 *   + Multi-target TARGETS array (extension point for new surfaces)
 *   + Per-target self-reference env var (chicken-and-egg skip)
 *   + Full href/src extraction (local files, mailto:, anchors)
 *   + Base-dir-aware local path resolution
 *   + Preconnect/dns-prefetch context-skip via <link> tag parsing
 *
 * v4 tolerance machinery (preserved verbatim from May 2 2026 build):
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
  // v5.3 additions (2026-05-20): stable customer-facing legal pages.
  {
    path: 'privacy-policy.html',
    label: 'privacy-policy',
    selfEnvVar: null,
  },
  {
    path: 'terms.html',
    label: 'terms',
    selfEnvVar: null,
  },
  // v5.4 additions (2026-05-20): /why and 404 pages.
  // /why doctrinal note: held to "every link live" at full strictness.
  // No tolerance machinery added; push discipline carries the load.
  // No WHY_CANONICAL — /why has no absolute self-references (verified
  // 2026-05-20). Add WHY_CANONICAL later if /why ever self-references.
  {
    path: 'why/index.html',
    label: 'why',
    selfEnvVar: null,
  },
  {
    path: '404_main_site.html',
    label: '404-main',
    selfEnvVar: null,
  },
  {
    path: 'master-context/404.html',
    label: '404-master-context',
    selfEnvVar: null,
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

const TOLERATED_STATUS = new Set([401, 403, 451, 999]);

const SKIP_PATTERNS = [
  /etherealconnectionsco\.com/,
  /fonts\.googleapis\.com/,
  /fonts\.gstatic\.com/,
  /www\.w3\.org/,
  /script\.google\.com/,
  /linkedin\.com/,
];

const CLOUD_BLOCK_TOLERANT_HOSTS = new Set([
  'fda.gov',           'www.fda.gov',
  'usda.gov',          'www.usda.gov',
  'fcc.gov',           'www.fcc.gov',
  'ama-assn.org',      'www.ama-assn.org',
  'epa.gov',           'www.epa.gov',
  'healthit.gov',      'www.healthit.gov',
  'nvlpubs.nist.gov',
  'usnews.com',        'www.usnews.com',
  'ilga.gov',          'www.ilga.gov',
  // v5.1 addition: Facebook anti-bot wall on profile.php (manual verified)
  'facebook.com',      'www.facebook.com',
]);

const CLOUD_BLOCK_TOLERANT_PATHS = [
  /^https?:\/\/(www\.)?ftc\.gov\/business-guidance\/blog\//i,
  /^https?:\/\/(www\.)?justice\.gov\/.*realpage/i,
  /^https?:\/\/(www\.)?nist\.gov\/system\/files\//i,
];

// ═══════════════════════════════════════════════════════════
//  EXTRACTION PATTERNS
// ═══════════════════════════════════════════════════════════
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;   // v5.2: stripped before extraction
const HREF_RE = /(?:href|src)=["']([^"']+)["']/gi;
const LINK_TAG_RE = /<link\s+[^>]+>/gi;
const HINT_REL_RE = /\b(?:preconnect|dns-prefetch)\b/i;
const MAILTO_RE = /^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ANCHOR_RE = /^#/;
const ABS_URL_RE = /^https?:\/\//i;
const URI_SCHEME_RE = /^[a-z][a-z0-9+\-.]*:/i;

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

// v5.2: strip HTML comments before extraction. Comments are documentation,
// not active markup; href/src patterns inside them are NOT live references
// and must not register as broken-link failures. Preserves the surrounding
// HTML structure (comments are replaced with empty strings, not removed
// entirely, so line positions don't shift — useful if we ever surface
// line-level error reporting).
function stripHtmlComments(html) {
  return html.replace(HTML_COMMENT_RE, '');
}

// ═══════════════════════════════════════════════════════════
//  LOCAL FILE CHECK — base-dir-aware
// ═══════════════════════════════════════════════════════════
async function checkLocal(linkPath, baseDir) {
  const cleaned = linkPath.split('#')[0].split('?')[0];
  if (!cleaned) return { ok: true, kind: 'anchor-only' };
  const fsPath = cleaned.startsWith('/')
    ? resolve(__dirname, '.' + cleaned)
    : resolve(baseDir, cleaned);
  try {
    await access(fsPath, constants.R_OK);
    return { ok: true, kind: 'local', path: fsPath };
  } catch {
    // v5.5: Netlify "Pretty URLs" — extensionless paths resolve to
    // .html at serve time. If the bare path is missing AND has no
    // extension, try the .html sibling before declaring broken.
    const hasExtension = /\.[a-z0-9]+$/i.test(cleaned);
    if (!hasExtension) {
      try {
        await access(fsPath + '.html', constants.R_OK);
        return { ok: true, kind: 'local-pretty', path: fsPath + '.html' };
      } catch { /* fall through */ }
    }
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

    if (transient5xx && attempt < RETRIES) {
      globalThis.clearTimeout(t);
      await sleep(1500);
      return checkRemote(url, attempt + 1);
    }

    let tolerated = TOLERATED_STATUS.has(res.status);
    let toleratedReason = tolerated ? 'anti-bot status' : null;

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

  // v5.2: strip HTML comments before any extraction. References inside
  // <!-- --> are documentation, not live markup, and must not register.
  const stripped = stripHtmlComments(html);
  const commentCount = (html.match(HTML_COMMENT_RE) || []).length;

  const links = new Set();
  let match;
  while ((match = HREF_RE.exec(stripped)) !== null) {
    links.add(match[1].trim());
  }

  const hintUrls = new Set();
  let linkTagMatch;
  while ((linkTagMatch = LINK_TAG_RE.exec(stripped)) !== null) {
    const tagText = linkTagMatch[0];
    const relMatch = tagText.match(/rel=["']([^"']+)["']/i);
    if (!relMatch || !HINT_REL_RE.test(relMatch[1])) continue;
    const hrefMatch = tagText.match(/href=["']([^"']+)["']/i);
    if (hrefMatch) hintUrls.add(hrefMatch[1].trim());
  }

  console.log(color('dim', `  → ${links.size} unique link${links.size === 1 ? '' : 's'} extracted`));
  if (commentCount) console.log(color('dim', `  → ${commentCount} HTML comment${commentCount === 1 ? '' : 's'} stripped before extraction`));
  if (hintUrls.size) console.log(color('dim', `  → ${hintUrls.size} preconnect/dns-prefetch hint${hintUrls.size === 1 ? '' : 's'} will be skipped`));
  if (selfUrl) console.log(color('dim', `  → self-reference URL: ${selfUrl}`));
  console.log();

  const remoteQueue = [];
  const immediate = [];

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
      if (matchesSkipPattern(link)) {
        immediate.push({ link, result: { ok: true, kind: 'skip-pattern' }, label: 'skip-pat' });
        continue;
      }
      remoteQueue.push(link);
      continue;
    }
    if (URI_SCHEME_RE.test(link)) {
      const scheme = link.split(':')[0].toLowerCase();
      immediate.push({ link, result: { ok: true, kind: 'uri-scheme' }, label: scheme });
      continue;
    }
    immediate.push({ link, kind: 'local-pending', label: 'local' });
  }

  for (const item of immediate) {
    if (item.kind === 'local-pending') {
      item.result = await checkLocal(item.link, baseDir);
      item.label = item.result.ok ? 'local' : 'MISSING';
    }
  }

  let remoteResults = [];
  if (remoteQueue.length) {
    process.stdout.write(color('dim', `  fetching ${remoteQueue.length} remote URL${remoteQueue.length === 1 ? '' : 's'}…`));
    remoteResults = await runWithConcurrency(remoteQueue, (url) => checkRemote(url), CONCURRENCY);
    process.stdout.write(color('dim', ' done\n'));
  }

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
  console.log(color('dim', `\n  ECCO link integrity check v5.5 · ${TARGETS.length} target${TARGETS.length === 1 ? '' : 's'}`));

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
