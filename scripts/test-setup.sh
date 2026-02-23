#!/usr/bin/env bash
set -euo pipefail

# Integration smoke tests for `orca setup` detection behavior.
#
# Prerequisite:
#   bun run build
#
# This script intentionally runs the built CLI at dist/cli/index.js (not bun run)
# to mirror installed-user behavior.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$ROOT_DIR/dist/cli/index.js"

if [[ ! -x "$CLI" ]]; then
  echo "ERROR: $CLI is missing or not executable. Run: bun run build"
  exit 1
fi

run_case() {
  local case_name="$1"
  local extra_env="$2"

  local temp_home
  temp_home="$(mktemp -d)"

  echo "============================================================"
  echo "CASE: $case_name"
  echo "HOME: $temp_home"

  local output exit_code
  set +e
  output="$(env -i PATH="$PATH" HOME="$temp_home" ${extra_env} node "$CLI" setup --global --skip-project-config 2>&1)"
  exit_code=$?
  set -e

  echo "--- command output ---"
  echo "$output"

  echo "--- written config (~/.orca/config.js) ---"
  if [[ -f "$temp_home/.orca/config.js" ]]; then
    cat "$temp_home/.orca/config.js"
  else
    echo "(missing)"
  fi

  local status="PASS"
  if [[ "$case_name" == "neither executor" ]]; then
    if [[ $exit_code -ne 1 ]]; then
      status="FAIL (expected exit 1)"
    fi
  else
    if [[ $exit_code -ne 0 ]]; then
      status="FAIL (expected exit 0)"
    fi
  fi

  echo "--- exit code: $exit_code ---"
  echo "RESULT: $status"

  rm -rf "$temp_home"
  echo

  if [[ "$status" == FAIL* ]]; then
    return 1
  fi
}

run_case "neither executor" ""
run_case "codex only" "OPENAI_API_KEY=sk-fake"
run_case "claude only" "ANTHROPIC_API_KEY=sk-ant-fake"
run_case "both" "OPENAI_API_KEY=sk-fake ANTHROPIC_API_KEY=sk-ant-fake"

echo "All setup integration cases passed."
