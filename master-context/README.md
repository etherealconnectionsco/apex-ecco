# master-context

Source for ECCO's Master Context architecture document — Public Edition.
The Master Context is ECCO's canonical doctrinal architecture spec,
covering service tiers, vocabulary doctrine, integrity architecture,
vision frame, regulatory positioning, and the founder's position
statement on replicability and mission.

**Canonical:** [etherealconnectionsco.com/master-context](https://etherealconnectionsco.com/master-context)
**License:** [CC BY-NC-ND 4.0](LICENSE)
**Current version:** v1.0 (issued 7 May 2026, deployed 13 May 2026)
**Status:** Published · Public Edition · derived from internal v1.3

---

## Posture

Public-research repository. This is the **Public Edition** — derived
from the internal v1.3 specification, with operational pipeline detail,
named third-party engagements, runway-state notation, and competitive
intelligence held privately as non-public posture.

ECCO operates under a structural-replicability doctrine: the architecture
is intentionally inspectable. The work is defended by the founder's
continuing capacity to see the whole puzzle, not by uncopyability. See
§J of the Public Edition for the full canonical phrasing.

---

## Repository structure

```
.
├── index.html       — the rendered Public Edition (current version)
├── seal.jpg         — ECCO seal (referenced from index.html)
├── 404.html         — custom 404 matching the documentary aesthetic
├── netlify.toml     — deploy config (headers, caching, redirects)
├── check-links.mjs  — link integrity check
├── MASTER_CONTEXT_PUBLIC_v1_0.md  — source markdown of the spec
├── LICENSE          — CC BY-NC-ND 4.0
├── .gitignore       — standard exclusions
└── README.md        — this file
```

The `.md` source and the `index.html` rendering live alongside each
other. The `.md` is the authoritative text; the `.html` is the
deploy-rendered surface kindred in aesthetic to the SPA spec at
`spa.etherealconnectionsco.com`. When the spec text is updated, both
files are updated in the same commit.

---

## Deploy

This site is a static deploy. No build step beyond the link check.

### Netlify (recommended path)

1. New site → Import from Git → connect this repo.
2. Build settings: leave the publish directory as `.` (root). The
   `netlify.toml` provides the build command (`node check-links.mjs`),
   security headers, caching, and the self-reference env var.
3. The canonical URL is `etherealconnectionsco.com/master-context`
   (apex path). The Netlify project itself deploys to its assigned
   `.netlify.app` subdomain; the apex path is wired at the apex site's
   routing layer.

> **Apex routing note.** The apex site (`etherealconnectionsco.com`)
> is being updated. Until the apex routing for `/master-context` is
> live, the in-document canonical URL will not yet resolve. The
> Netlify `.netlify.app` URL serves the document directly during
> the transition.

### Local preview

```bash
# Any static server works:
python3 -m http.server 8000
# or:
npx serve .
```

Then open `http://localhost:8000/`.

---

## Integrity check

`check-links.mjs` is a self-contained Node script that validates every
`href=` and `src=` in `index.html`.

```bash
node check-links.mjs
```

It resolves local paths against the filesystem, fetches remote URLs
(HEAD with GET fallback), and exits non-zero on any failure. Mailto and
anchor-only links are passed through.

Environment:

- `LINK_CHECK_TIMEOUT_MS` (default 8000) — per-request timeout.
- `MASTER_CONTEXT_CANONICAL` (set in `netlify.toml`) — when set to the
  doc's canonical URL, the checker skips URLs matching this prefix.
  Prevents the chicken-and-egg failure during first deploy before the
  canonical URL is wired at apex. Both skip categories
  (`preconnect`/`dns-prefetch` hints and self-references) are logged
  as `○` in the output, so the deploy log shows exactly what was
  checked, what was skipped, and why.

Requires Node ≥ 18 (uses built-in `fetch`). Run it before every deploy.
Run it in CI to make link integrity verifiable from outside the firm.

---

## Editing this document

The Master Context is a reference work, not a living document — but it
is also not frozen. The internal v1.3 spec advances; the Public Edition
issues new versions when the doctrinal architecture changes in a way
that affects what is shared with the public.

Edits to the public edition follow these rules:

1. **Every revision logs in the LICENSE's "Version history" section**
   when license metadata changes, and in this README's "Current version"
   line when the published edition advances.
2. **Pre-deploy gate:** run `node check-links.mjs` and verify pass.
3. **Vocabulary changes** affecting the §B.2 doctrine require a grep
   audit across all files in this repo and a corresponding update to
   the master `ECCO_ECOSYSTEM_INDEX.md` (held internally).
4. **License changes** are logged in both this repository's `LICENSE`
   file and in this README; the in-document license metadata (header
   properties row and footer line in `index.html`) is updated in the
   same revision.

Per the ECCO Deploy Playbook v1, every revision passes the §1
pre-push checklist before commit.

---

## Stewardship

Steward: J. W. Hearne · Ethereal Connections Co. · Denver, Colorado.
Contact: `jeremiah@etherealconnectionsco.com`

---

## License & use

Published under CC BY-NC-ND 4.0. See `LICENSE` for full terms.

**You may:** read, link to, cite, and share for non-commercial purposes
with attribution to Ethereal Connections Co.

**You may not:** repackage, rebrand, fork-and-resell, incorporate into
paid products, paid courses, paid newsletters, or any commercial
offering without prior written permission.

ECCO operates this repository under a public-research posture. Other
ECCO surfaces (commercial offerings, sales tools, revenue
infrastructure, internal operational specifications) are intentionally
closed. The visibility of this repository is editorial, not an
invitation to extraction.

For commercial licensing, partnership, or any use beyond the terms
above:

**jeremiah@etherealconnectionsco.com**

---

## Doctrine in active service

- *Provenance over performance.*
- *Infrastructure over influence.*
- *Doctrine over excuse.*

---

Ethereal Connections Co. · Denver, CO · Founded 2025
etherealconnectionsco.com · *Infrastructure over influence.*
