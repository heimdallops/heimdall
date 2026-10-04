#!/usr/bin/env bash
# Smoke-test a standalone (SEA) heimdall binary.
#
# Runs the binary from a temp dir outside the repo, so it can't fall back on the
# repo's node_modules.
#
# Usage: scripts/smoke-test-sea.sh <path-to-binary>

set -euo pipefail

[ $# -eq 1 ] || { echo "usage: $0 <path-to-binary>" >&2; exit 2; }

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
binary="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
# Relative require: on Windows, node can't read Git Bash's /c/... style paths.
expected_version="$(cd "$repo_dir" && node -p "require('./package.json').version")"

fail() { echo "smoke test failed: $*" >&2; exit 1; }

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT
cp "${repo_dir}/test/fixtures/sea/bash.yaml" "$work_dir/"
cd "$work_dir"

# no_sea_warning <stderr-file>
no_sea_warning() {
  if grep -q 'ExperimentalWarning' "$1"; then
    cat "$1" >&2
    fail "binary printed the SEA ExperimentalWarning"
  fi
}

echo "--version"
version="$("$binary" --version 2>stderr.txt)" || { cat stderr.txt >&2; fail "--version exited non-zero"; }
no_sea_warning stderr.txt
[ "$version" = "$expected_version" ] || fail "--version printed '$version', expected '$expected_version'"

echo "run bash.yaml"
output="$("$binary" run bash.yaml 2>stderr.txt)" || { echo "$output"; cat stderr.txt >&2; fail "run bash.yaml exited non-zero"; }
no_sea_warning stderr.txt
grep -q 'sea-smoke-ok' <<<"$output" || { echo "$output"; fail "bash node output missing 'sea-smoke-ok'"; }

echo "smoke test passed"
