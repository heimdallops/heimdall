.PHONY: act-publish-npm-dry github-run-check-secret-file github-run-publish-npm

# Ref passed to the workflow (branch, tag, or SHA). Default: current HEAD.
ACT_REF ?= $(shell git rev-parse HEAD)
ACT_VERSION ?= $(shell jq -r '.version' package.json)
ACT_SECRET_FILE ?= .github/.secrets

# act does not set github.token. actions/checkout needs a PAT — either add
#   GITHUB_TOKEN=ghp_...
# to .github/.secrets, or install GitHub CLI and run `gh auth login` so this picks up your token:
ACT_GITHUB_TOKEN ?= $(shell gh auth token 2>/dev/null)

github-run-check-secret-file:
	@test -f "$(ACT_SECRET_FILE)" || (echo "Missing $(ACT_SECRET_FILE) — create it for act (see Makefile header)." >&2 && exit 1)

github-run-publish-npm: github-run-check-secret-file
	act workflow_dispatch -W .github/workflows/publish-to-npm.yml --input "ref=$(ACT_REF)" --input "version=$(ACT_VERSION)" --input "dry_run=true" --secret-file "$(ACT_SECRET_FILE)" $(if $(strip $(ACT_GITHUB_TOKEN)),-s GITHUB_TOKEN="$(ACT_GITHUB_TOKEN)")
