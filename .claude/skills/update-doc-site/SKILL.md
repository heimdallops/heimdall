---
name: update-doc-site
description: >
  Update the Heimdall Hugo documentation site in docs-site/ (Lotus Docs theme).
  Use when the user asks to add, edit, or restructure docs pages, landing page copy,
  branding, navigation, or deploy the doc site. Trigger for prompts about
  documentation, docs-site, Hugo content, Lotus Docs, or the public docs website.
---

# Update Doc Site

All work happens under `docs-site/`. Do not change CLI source, tests, or unrelated repo files unless the user explicitly asks.

## Site map

| Path | Purpose |
| ---- | ------- |
| `hugo.toml` | Site config, Lotus Docs params, menus, theme color |
| `data/landing.yaml` | Homepage sections (hero, feature grid) |
| `content/docs/` | Documentation pages (auto sidebar menu via `weight`) |
| `assets/images/logos/` | Header SVGs (`logo.svg`, `mark.svg`) and `heimdall-logo.png` |
| `assets/images/` | Images referenced from content/landing |
| `static/` | Favicons (`favicon-16x16.png`, `favicon-32x32.png`) |
| `image.png` | Source logo; regenerate favicons/assets when it changes |
| `Makefile` | `build`, `serve`, `deploy-dev`, `deploy-prod` (Wrangler Pages) |
| `archetypes/docs.md` | Template for new doc pages |

Theme: [Lotus Docs](https://lotusdocs.dev/) via Hugo module (`github.com/colinwilson/lotusdocs`). Requires **Hugo Extended** ≥ 0.140.0.

## Workflow

1. **Clarify scope** — content only, landing/branding, config/nav, or deploy.
2. **Read before writing** — open the page(s) being changed plus `docs-site/README.md`. For product facts, use repo root `README.md` and `CLAUDE.md`; do not invent shipped CLI behavior.
3. **Make minimal edits** — match existing tone, front matter, and section structure.
4. **Verify** — from `docs-site/`, run `make build`. Fix Hugo errors before finishing.
5. **Preview** (when useful) — `make serve` → http://localhost:1413/ and `/docs/`.
6. **Deploy** — only if the user asks: `make deploy-dev` or `make deploy-prod` (needs Wrangler + Cloudflare project). Override `PROJECT_DEV`, `PROJECT_PROD`, or `HUGO_BASEURL_PROD` as needed.

## Adding or editing documentation

Create pages under `content/docs/` (or nested dirs for sections).

**New page** — copy conventions from `archetypes/docs.md` and neighbors:

```yaml
---
title: Page Title
description: One-line summary for cards and SEO.
icon: article          # Material Symbols name (see lotusdocs.dev)
weight: 400            # lower = higher in sidebar; step by ~100
toc: true
draft: false           # omit or false for published pages
---
```

**New section** — add `content/docs/<section>/_index.md` (section landing) plus child `.md` files inside `<section>/`.

**Menu order** — controlled by front matter `weight` only (no manual sidebar config).

**Internal links** — use root-relative paths: `/docs/about/`, `/docs/guides/workflows/`.

### Content accuracy

- The CLI and workflow engine are **not fully released**. Label speculative YAML, commands, and APIs as *preview*, *illustrative*, or *planned* when they are not implemented in `src/`.
- Prefer facts from `README.md` / `CLAUDE.md` over chat inference.
- Code examples are welcome for layout demos; say when they are not runnable yet.

### Markdown and shortcodes

- Fenced blocks with language tags for Prism (`yaml`, `bash`, `typescript`, etc.).
- Lotus Docs `alert` shortcode: `{{< alert context="info" text="..." />}}` or inner content form.
- Goldmark `unsafe = true` is enabled; avoid raw HTML unless necessary.

## Landing page and branding

| Change | Edit |
| ------ | ---- |
| Hero title, CTAs, feature cards | `data/landing.yaml` |
| Accent / dark mode / fonts / social | `hugo.toml` → `[params]`, `[params.docs]` |
| Primary nav (Docs, GitHub) | `hugo.toml` → `[menu]` |
| Header logo | `assets/images/logos/logo.svg`, `mark.svg` |
| Hero / title image | `assets/images/logos/heimdall-logo.png` or `assets/images/` |
| Favicons | Regenerate from `image.png` into `static/favicon-*.png` |

Default brand: `themeColor = "cyan"`, `darkMode = true`. Available theme colors: `blue`, `green`, `red`, `yellow`, `emerald`, `cardinal`, `magenta`, `cyan`.

Production deploy may need a real canonical URL:

```bash
make deploy-prod HUGO_BASEURL_PROD=https://your-docs.example.com/
```

## Checklist before finishing

- [ ] Changes confined to `docs-site/` (unless user requested otherwise)
- [ ] New pages have `title`, `description`, `weight`, and sensible `icon`
- [ ] No false claims about shipped commands or schema
- [ ] `make build` succeeds
- [ ] `public/` and `resources/` not committed (gitignored build output)

## Avoid

- Editing generated `docs-site/public/` or `docs-site/resources/`
- Running `npm run quality` (that is for the CLI, not the doc site)
- Bundling doc-only changes with unrelated CLI refactors
- Adding Lotus Docs features (DocSearch, analytics, i18n) without a concrete request
- Committing or deploying unless the user asks

## Quick commands

```bash
cd docs-site
make serve          # local preview
make build          # production build → public/
make deploy-dev     # Cloudflare Pages (dev project)
make deploy-prod    # Cloudflare Pages (prod project)
```
