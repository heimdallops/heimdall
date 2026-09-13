# Heimdall documentation site

Static documentation built with [Hugo](https://gohugo.io/) and the [Lotus Docs](https://lotusdocs.dev/) theme.

## Requirements

- Hugo Extended ≥ 0.140.0
- Go ≥ 1.21 (for Hugo modules)

## Local development

```bash
cd docs-site
hugo server -D
```

Open [http://localhost:1313](http://localhost:1313) for the landing page and [http://localhost:1313/docs/](http://localhost:1313/docs/) for documentation.

## Build

```bash
hugo --minify
```

Output is written to `public/`.

## Deploy (Cloudflare Pages)

Requires [Wrangler](https://developers.cloudflare.com/workers/wrangler/) and a Cloudflare Pages project.

```bash
make deploy-dev    # deploy to heimdall-docs-dev
make deploy-prod   # deploy to heimdall-docs-prod
```

Override project names or production `baseURL`:

```bash
make deploy-prod PROJECT_PROD=my-docs HUGO_BASEURL_PROD=https://docs.example.com/
```

## Branding

- Logo and favicons: `image.png` (source), `assets/images/logos/`, `static/favicon-*.png`
- Header SVG wordmark: `assets/images/logos/logo.svg` and `mark.svg`
- Accent color: `cyan` via `[params.docs].themeColor` in `hugo.toml`
