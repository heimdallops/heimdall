.DEFAULT_GOAL := quality
.PHONY: github-run-check-secret-file github-run-publish-npm github-run-publish-on-release

%:
	npm run $(subst -,:,$@)

# Ref passed to the workflow (branch, tag, or SHA). Default: current HEAD.
ACT_REF ?= $(shell git rev-parse HEAD)
ACT_VERSION ?= $(shell jq -r '.version' package.json)
ACT_RELEASE_TAG ?= $(ACT_VERSION)
ACT_RELEASE_URL ?= https://github.com/heimdallops/heimdall/releases/tag/$(ACT_RELEASE_TAG)
ACT_SECRET_FILE ?= .github/.secrets
ACT_ARTIFACT_DIR ?= .github/workflows/.act/.act-artifacts
ACT_RELEASE_EVENT_FILE ?= .github/workflows/.act/.act-release-event.json

# act does not set github.token. actions/checkout needs a PAT — either add
#   GITHUB_TOKEN=ghp_...
# to .github/.secrets, or install GitHub CLI and run `gh auth login` so this picks up your token:
ACT_GITHUB_TOKEN ?= $(shell gh auth token 2>/dev/null)

# Map GitHub-hosted runner labels to Docker images (required for matrix jobs in reusable workflows).
# macos-latest cannot run macOS in Docker; map it to the same Linux image so tests still execute.
ACT_RUNNER_MAP ?= -P ubuntu-latest=catthehacker/ubuntu:act-latest -P macos-latest=catthehacker/ubuntu:act-latest

github-run-check-secret-file:
	@test -f "$(ACT_SECRET_FILE)" || (echo "Missing $(ACT_SECRET_FILE) — create it for act (see Makefile header)." >&2 && exit 1)
	@mkdir -p "$(ACT_ARTIFACT_DIR)"

github-run-publish-npm: github-run-check-secret-file
	act workflow_dispatch -W .github/workflows/publish-to-npm.yml $(ACT_RUNNER_MAP) --artifact-server-path "$(ACT_ARTIFACT_DIR)" --input "ref=$(ACT_REF)" --input "version=$(ACT_VERSION)" --input "dry_run=true" --secret-file "$(ACT_SECRET_FILE)" $(if $(strip $(ACT_GITHUB_TOKEN)),-s GITHUB_TOKEN="$(ACT_GITHUB_TOKEN)")

github-run-publish-on-release: github-run-check-secret-file
	@printf '{\n  "release": {\n    "tag_name": "%s",\n    "html_url": "%s"\n  }\n}\n' "$(ACT_RELEASE_TAG)" "$(ACT_RELEASE_URL)" > "$(ACT_RELEASE_EVENT_FILE)"
	act release -W .github/workflows/publish-on-release.yml $(ACT_RUNNER_MAP) --artifact-server-path "$(ACT_ARTIFACT_DIR)" --eventpath "$(ACT_RELEASE_EVENT_FILE)" --secret-file "$(ACT_SECRET_FILE)" $(if $(strip $(ACT_GITHUB_TOKEN)),-s GITHUB_TOKEN="$(ACT_GITHUB_TOKEN)")
  
.DEFAULT_GOAL := quality

%:
	npm run $(subst -,:,$@)
