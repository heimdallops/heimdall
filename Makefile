.DEFAULT_GOAL := quality
.PHONY: github-run-init-secrets github-run-publish-on-release github-run-publish-binaries

%:
	npm run $(subst -,:,$@)

ACT ?= act
ACT_VERSION ?= 0.1.1
ACT_RELEASE_TAG ?= $(ACT_VERSION)
ACT_RELEASE_URL ?= https://github.com/heimdallops/heimdall/releases/tag/$(ACT_RELEASE_TAG)
ACT_SECRET_FILE ?= .github/.secrets
ACT_ARTIFACT_DIR ?= .github/workflows/.act/.act-artifacts
ACT_RELEASE_EVENT_FILE ?= .github/workflows/.act/.act-release-event.json

#
# act does not set github.token. actions/checkout needs a PAT — either add
#   GITHUB_TOKEN=ghp_...
# to .github/.secrets, or install GitHub CLI and run `gh auth login` so this picks up your token:
ACT_GITHUB_TOKEN ?= $(shell gh auth token 2>/dev/null)

# Map GitHub-hosted runner labels to Docker images (required for matrix jobs in reusable workflows).
# macos-latest/macos-13 cannot run macOS in Docker; map all runners to the same Linux image so the
# workflow structure can be validated locally even though the resulting binaries won't be native.
ACT_RUNNER_MAP ?= \
	-P ubuntu-latest=catthehacker/ubuntu:act-latest \
	-P ubuntu-24.04-arm=catthehacker/ubuntu:act-latest \
	-P macos-13=catthehacker/ubuntu:act-latest \
	-P macos-latest=catthehacker/ubuntu:act-latest \
	-P windows-latest=catthehacker/ubuntu:act-latest

# Map the GitHub repo to the local working tree so act uses local code instead
# of fetching from the remote. This makes uncommitted changes visible in the
# workflow without needing a push first.
ACT_LOCAL_REPO ?= --local-repository heimdallops/heimdall=.

# Restrict the matrix to Linux x64 only for faster local debug runs.
# Override to test other targets: ACT_MATRIX="target=linux-arm64"
ACT_MATRIX ?= --matrix target:linux-x64

github-run-init-secrets:
	@if [ -f "$(ACT_SECRET_FILE)" ]; then \
		echo "$(ACT_SECRET_FILE) already exists — delete it first to regenerate." >&2; \
		exit 1; \
	fi
	@printf 'NPM_TOKEN: '; read -r NPM_TOKEN; \
	printf 'DISCORD_WEBHOOK_URL: '; read -r DISCORD_WEBHOOK_URL; \
	printf 'NPM_TOKEN=%s\nDISCORD_WEBHOOK_URL=%s\n' "$$NPM_TOKEN" "$$DISCORD_WEBHOOK_URL" > "$(ACT_SECRET_FILE)"; \
	echo "Created $(ACT_SECRET_FILE)."

github-run-publish-on-release:
	@test -f "$(ACT_SECRET_FILE)" || $(MAKE) github-run-init-secrets
	@mkdir -p "$(ACT_ARTIFACT_DIR)"
	@printf '{\n  "release": {\n    "tag_name": "%s",\n    "html_url": "%s"\n  }\n}\n' "$(ACT_RELEASE_TAG)" "$(ACT_RELEASE_URL)" > "$(ACT_RELEASE_EVENT_FILE)"
	@$(ACT) release \
		-W .github/workflows/publish-on-release.yml \
		$(ACT_RUNNER_MAP) \
		--artifact-server-path "$(ACT_ARTIFACT_DIR)" \
		--eventpath "$(ACT_RELEASE_EVENT_FILE)" \
		--secret-file "$(ACT_SECRET_FILE)" \
		$(if $(strip $(ACT_GITHUB_TOKEN)),-s GITHUB_TOKEN="$(ACT_GITHUB_TOKEN)") \
		--var DRY_RUN=true

# Run only the publish-binaries workflow locally with act.
# All platform runners are mapped to the same Linux Docker image so the workflow graph is validated,
# but the resulting binaries will be Linux x64 regardless of matrix target.
github-run-publish-binaries:
	@mkdir -p "$(ACT_ARTIFACT_DIR)"
	@printf '{\n  "release": {\n    "tag_name": "%s",\n    "html_url": "%s"\n  }\n}\n' "$(ACT_RELEASE_TAG)" "$(ACT_RELEASE_URL)" > "$(ACT_RELEASE_EVENT_FILE)"
	@$(ACT) workflow_call \
		-W .github/workflows/publish-binaries.yml \
		$(ACT_RUNNER_MAP) \
		$(ACT_LOCAL_REPO) \
		$(ACT_MATRIX) \
		--artifact-server-path "$(ACT_ARTIFACT_DIR)" \
		--input ref=main \
		--input release_tag=$(ACT_RELEASE_TAG) \
		--input dry_run=true \
		$(if $(strip $(ACT_GITHUB_TOKEN)),-s GITHUB_TOKEN="$(ACT_GITHUB_TOKEN)")
