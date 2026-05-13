#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════
//  check-links.mjs
//  Link integrity check for the ECCO Master Context (Public Edition)
//
//  Per ECCO Deploy Playbook §3.2, this script is the SPA-canonical
//  link checker adapted with a Master-Context-prefixed env var.
//
//  Run locally: node check-links.mjs
//  Run in CI:  exit code 0 = pass, non-zero = fail.
//
//  Strategy:
//   1. Parse index.html for all href= and src= attributes.
//   2. Resolve relative paths against the local filesystem; check
//      that target file exists.
//   3. Resolve absolute http(s) URLs and fetch HEAD; require 2xx
//      or 3xx response. Allow timeout configurable via env.
//   4. Mailto: links are passed through (format-validated only).
//   5. Anchor-only (#section) links are passed (would require DOM
//      to verify and overkills the integrity check).
//   6. Skip categories (logged as skipped, not failed):
//      - rel="preconnect" and rel="dns-prefetch" link tags
//        (connection hints, not resources — root-path 404 is
//        expected behavior for these and not an integrity issue)
//      - URLs matching env var MASTER_CONTEXT_CANONICAL
//        (self-references — a doc that references its own
//        canonical URL would otherwise create a chicken-and-egg
//        failure on first deploy before the canonical URL exists)
//
//  Exit: zero if all links resolve; non-zero with summary on
//  failure. Designed to be CI-callable without configuration.
// ═══════════════════════════════════════════════════════════

import { readFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGET = process.argv[2] || resolve(__dirname, 'index.html');
const TIMEOUT_MS = Number(process.env.LINK_CHECK_TIMEOUT_MS) || 8000;

const HREF_RE = /(?:href|src)=["']([^"']+)["']/gi;
const LINK_TAG_RE = /<link\s+[^>]+>/gi;
const HINT_REL_RE = /\b(?:preconnect|dns-prefetch)\b/i;
const MAILTO_RE = /^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ANCHOR_RE = /^#/;
const ABS_URL_RE = /^https?:\/\//i;
const SELF_URL = (process.env.MASTER_CONTEXT_CANONICAL || '').replace(/\/$/, '');

function color(c, s) {
  const codes = { red: 31, green: 32, yellow: 33, blue: 34, dim: 2, reset: 0 };
  return `\x1b[${codes[c]}m${s}\x1b[0m`;
}

async function checkLocal(path) {
  // Strip query/hash, resolve relative to deploy folder
  const cleaned = path.split('#')[0].split('?')[0];
  if (!cleaned) return { ok: true, kind: 'anchor-only' };
  const fsPath = resolve(__dirname, cleaned);
  try {
    await access(fsPath, constants.R_OK);
    return { ok: true, kind: 'local', path: fsPath };
  } catch {
    return { ok: false, kind: 'local-missing', path: fsPath };
  }
}

async function checkRemote(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let res = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'master-context-link-check/1.0 (+etherealconnectionsco.com)' }
    });
    // Some servers reject HEAD; retry with GET
    if (res.status === 405 || res.status === 403) {
      res = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'User-Agent': 'master-context-link-check/1.0 (+etherealconnectionsco.com)' }
      });
    }
    clearTimeout(timer);
    return { ok: res.status >= 200 && res.status < 400, status: res.status, kind: 'remote' };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, kind: 'remote-error', error: err.message };
  }
}

async function main() {
  let html;
  try {
    html = await readFile(TARGET, 'utf8');
  } catch (err) {
    console.error(color('red', `✗ cannot read ${TARGET}: ${err.message}`));
    process.exit(2);
  }

  const links = new Set();
  let match;
  while ((match = HREF_RE.exec(html)) !== null) {
    links.add(match[1].trim());
  }

  // Pre-pass: identify preconnect/dns-prefetch hint URLs to skip
  const hintUrls = new Set();
  let linkTagMatch;
  while ((linkTagMatch = LINK_TAG_RE.exec(html)) !== null) {
    const tagText = linkTagMatch[0];
    const relMatch = tagText.match(/rel=["']([^"']+)["']/i);
    if (!relMatch || !HINT_REL_RE.test(relMatch[1])) continue;
    const hrefMatch = tagText.match(/href=["']([^"']+)["']/i);
    if (hrefMatch) hintUrls.add(hrefMatch[1].trim());
  }

  console.log(color('dim', `→ ${TARGET}`));
  console.log(color('dim', `→ ${links.size} unique link${links.size === 1 ? '' : 's'} extracted`));
  if (hintUrls.size) console.log(color('dim', `→ ${hintUrls.size} preconnect/dns-prefetch hint${hintUrls.size === 1 ? '' : 's'} will be skipped`));
  if (SELF_URL) console.log(color('dim', `→ self-reference URL: ${SELF_URL} (URLs matching this prefix will be skipped)`));
  console.log();

  const failures = [];
  let passed = 0;
  let skipped = 0;

  for (const link of links) {
    let result;
    let label;

    // Skip preconnect/dns-prefetch hints (connection hints, not resources)
    if (hintUrls.has(link)) {
      result = { ok: true, kind: 'preconnect-hint' };
      label = 'preconnect';
      skipped++;
      console.log(`  ${color('yellow', '○')} ${color('dim', label.padEnd(14))} ${link}`);
      continue;
    }

    // Skip self-references (the doc citing its own canonical URL)
    if (SELF_URL && link.startsWith(SELF_URL)) {
      result = { ok: true, kind: 'self-reference' };
      label = 'self-ref';
      skipped++;
      console.log(`  ${color('yellow', '○')} ${color('dim', label.padEnd(14))} ${link}`);
      continue;
    }

    if (MAILTO_RE.test(link)) {
      result = { ok: true, kind: 'mailto' };
      label = 'mailto';
    } else if (ANCHOR_RE.test(link)) {
      result = { ok: true, kind: 'anchor' };
      label = 'anchor';
    } else if (ABS_URL_RE.test(link)) {
      result = await checkRemote(link);
      label = `remote ${result.status || result.error || '?'}`;
    } else if (link.startsWith('data:')) {
      result = { ok: true, kind: 'data-uri' };
      label = 'data-uri';
      skipped++;
    } else {
      result = await checkLocal(link);
      label = result.ok ? 'local' : 'MISSING';
    }

    if (result.ok) {
      passed++;
      console.log(`  ${color('green', '✓')} ${color('dim', label.padEnd(14))} ${link}`);
    } else {
      failures.push({ link, result });
      console.log(`  ${color('red', '✗')} ${color('red', label.padEnd(14))} ${link}`);
    }
  }

  console.log();
  if (failures.length === 0) {
    console.log(color('green', `✓ all ${passed} links pass · ${skipped} skipped`));
    process.exit(0);
  } else {
    console.log(color('red', `✗ ${failures.length} link${failures.length === 1 ? '' : 's'} failed · ${passed} passed`));
    for (const { link, result } of failures) {
      console.log(color('red', `  • ${link}`));
      if (result.error) console.log(color('dim', `      ${result.error}`));
      if (result.path) console.log(color('dim', `      ${result.path}`));
    }
    process.exit(1);
  }
}

main().catch(err => {
  console.error(color('red', `✗ unexpected: ${err.stack || err.message}`));
  process.exit(3);
});
