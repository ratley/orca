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
  local cli_args="$3"
  local expected_config_path="$4"
  local expected_exit="$5"

  local temp_home
  temp_home="$(mktemp -d)"

  echo "============================================================"
  echo "CASE: $case_name"
  echo "HOME: $temp_home"

  local output exit_code
  set +e
  output="$(env -i PATH="$PATH" HOME="$temp_home" ${extra_env} node "$CLI" setup ${cli_args} --skip-project-config 2>&1)"
  exit_code=$?
  set -e

  echo "--- command output ---"
  echo "$output"

  echo "--- written config ($expected_config_path) ---"
  if [[ -f "$temp_home/$expected_config_path" ]]; then
    cat "$temp_home/$expected_config_path"
  else
    echo "(missing)"
  fi

  local status="PASS"
  if [[ $exit_code -ne "$expected_exit" ]]; then
    status="FAIL (expected exit $expected_exit)"
  fi

  if [[ ! -f "$temp_home/$expected_config_path" ]]; then
    status="FAIL (expected config at $expected_config_path)"
  fi

  echo "--- exit code: $exit_code ---"
  echo "RESULT: $status"

  rm -rf "$temp_home"
  echo

  if [[ "$status" == FAIL* ]]; then
    return 1
  fi
}

run_case "neither executor" "" "--global" ".orca/config.js" "1"
run_case "codex only" "OPENAI_API_KEY=sk-fake" "--global" ".orca/config.js" "0"
run_case "claude only" "ANTHROPIC_API_KEY=sk-ant-fake" "--global" ".orca/config.js" "0"
run_case "both" "OPENAI_API_KEY=sk-fake ANTHROPIC_API_KEY=sk-ant-fake" "--global" ".orca/config.js" "0"
run_case "ts config output" "OPENAI_API_KEY=sk-fake" "--global --ts" ".orca/config.ts" "0"

run_project_case() {
  local temp_home
  temp_home="$(mktemp -d)"
  local temp_project
  temp_project="$(mktemp -d)"

  echo "============================================================"
  echo "CASE: project ts config output"
  echo "HOME: $temp_home"
  echo "PROJECT: $temp_project"

  local output exit_code
  set +e
  output="$(cd "$temp_project" && env -i PATH="$PATH" HOME="$temp_home" OPENAI_API_KEY=sk-fake node "$CLI" setup --project --ts --skip-project-config 2>&1)"
  exit_code=$?
  set -e

  echo "--- command output ---"
  echo "$output"

  local status="PASS"
  if [[ $exit_code -ne 0 ]]; then
    status="FAIL (expected exit 0)"
  fi

  if [[ ! -f "$temp_project/orca.config.ts" ]]; then
    status="FAIL (expected config at ./orca.config.ts)"
  else
    echo "--- written config (./orca.config.ts) ---"
    cat "$temp_project/orca.config.ts"
  fi

  echo "--- exit code: $exit_code ---"
  echo "RESULT: $status"

  rm -rf "$temp_home" "$temp_project"
  echo

  if [[ "$status" == FAIL* ]]; then
    return 1
  fi
}

run_project_case

echo "All setup integration cases passed."
