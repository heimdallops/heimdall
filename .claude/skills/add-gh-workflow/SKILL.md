---
name: heimdall-gh-workflow
description: Add or update Heimdall GitHub Actions workflows using the repository's release/publish patterns.
---

# Add GitHub Workflow

Use this skill when implementing or changing workflows in `.github/workflows/`.

## Checklist

1. Choose clear workflow filenames by purpose (`publish-to-npm.yml`, `publish-on-release.yml`, `build.yml`, `test.yml`).
2. Use `workflow_call` for reusable workflows and pass explicit inputs/secrets; avoid hidden defaults for critical refs.
3. Keep `ref` explicit for checkout in reusable workflows (`ref: ${{ inputs.ref }}`).
4. Validate critical publish inputs early (non-empty checks before expensive jobs).
5. Use `jq` for `package.json` reads/writes in shell steps; avoid ad hoc JSON parsing.
6. Prefer artifact reuse over rerunning the same generative commands across jobs.
7. If using artifact handoff, upload with `actions/upload-artifact@v5` and download with `actions/download-artifact@v5`.
8. Keep artifact names consistent across workflows (hardcoded string unless parameterization is truly needed).
9. Keep notifications non-blocking (`continue-on-error: true`) so Discord outages do not fail release/publish.
10. Use marketplace Discord action `tsickert/discord-webhook@v7.0.0` for notifications.
11. For multiline Discord text, use YAML block scalar (`|`) instead of `\n` escape sequences.
12. Workflows should be testable with `act`; add a Makefile command to run each workflow locally.
13. Store any `act` event payload files and local workflow test data under `.github/workflows/.act/`.
14. Ensure `act` artifact-server paths are configured when artifact upload/download actions are used.

## Output Rules

- Use `permissions` minimally; add `actions: write` only where artifact upload is required.
- Use latest stable versions of GitHub Actions unless the repository intentionally pins a different version for compatibility (for artifacts, pin to `actions/upload-artifact@v5` and `actions/download-artifact@v5`).
- Prefer deterministic workflow behavior over implicit context/fallbacks.
- Keep workflow names and job names aligned with actual steps performed.
- Reusable workflows should expose only inputs they actually need.

## Avoid

- Do not depend on `github.sha` fallbacks when a caller-provided `ref` is required.
- Do not fail the release because notification delivery failed.
- Do not use expression contexts unsupported in reusable call `with:` blocks (for example, relying on workflow-level `env` there).
- Do not duplicate build work in publish jobs when an artifact from build can be used.
