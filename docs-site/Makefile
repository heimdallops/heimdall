# Heimdall docs site – build and deploy (Cloudflare Pages via Wrangler)

HUGO ?= hugo
WRANGLER ?= wrangler

# Override for production canonical URLs, e.g. https://docs.example.com/
HUGO_BASEURL ?= /

PROJECT_DEV ?= heimdall-docs-dev
PROJECT_PROD ?= heimdall-docs-prod

.PHONY: build deploy-dev deploy-prod

build:
	$(HUGO) --minify --baseURL "$(HUGO_BASEURL)"

deploy-dev: build
	$(WRANGLER) pages deploy public --project-name=$(PROJECT_DEV)

deploy-prod:
	$(MAKE) build HUGO_BASEURL="$(or $(HUGO_BASEURL_PROD),$(HUGO_BASEURL))"
	$(WRANGLER) pages deploy public --project-name=$(PROJECT_PROD)
