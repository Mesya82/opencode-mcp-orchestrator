#!/usr/bin/env bash

set -Eeuo pipefail

RELEASE_DIR="${RELEASE_DIR:-/release}"
PORT="${E2E_HTTP_PORT:-8123}"

export PATH="$HOME/.local/bin:$HOME/.claude/bin:$HOME/.claude/local/bin:$HOME/.opencode/bin:$HOME/bin:$PATH"

fail() {
  echo
  echo "ERROR: $*" >&2
  exit 1
}

echo "========================================"
echo "OpenCode MCP Orchestrator E2E"
echo "========================================"

echo
echo "=== VERIFY RELEASE PAYLOAD ==="

test -d "$RELEASE_DIR" || \
  fail "release directory missing: $RELEASE_DIR"

test -f "$RELEASE_DIR/install.sh" || \
  fail "install.sh missing"

test -f "$RELEASE_DIR/SHA256SUMS" || \
  fail "SHA256SUMS missing"

ARCHIVE="$(
  awk '{print $2}' \
    "$RELEASE_DIR/SHA256SUMS" \
  | sed 's/^\*//' \
  | grep '^opencode-mcp-orchestrator-.*\.tar\.gz$' \
  | head -n 1
)"

test -n "$ARCHIVE" || \
  fail "release archive not found in SHA256SUMS"

VERSION="${ARCHIVE#opencode-mcp-orchestrator-}"
VERSION="${VERSION%.tar.gz}"

echo "Release version:"
echo "  $VERSION"

test -f "$RELEASE_DIR/$ARCHIVE" || \
  fail "release archive missing: $ARCHIVE"

echo
echo "=== BUBBLEWRAP VERSION ==="

BWRAP_VERSION="$(
  /usr/bin/bwrap --version
)"

echo "Bubblewrap:"
echo "  $BWRAP_VERSION"

test "$BWRAP_VERSION" = "bubblewrap 0.12.0" || \
  fail "expected bubblewrap 0.12.0 at /usr/bin/bwrap, got: $BWRAP_VERSION"

echo BWRAP_0_12_0_OK

echo
echo "=== BUBBLEWRAP PREFLIGHT ==="

# Nested namespaces must already be enabled by the disposable container
# runtime (see tests/e2e/local.sh); no privileged/capability escalation here.
/usr/bin/bwrap --die-with-parent --new-session --unshare-net --unshare-pid --unshare-ipc --unshare-uts --ro-bind /usr /usr --symlink usr/bin /bin --symlink usr/lib /lib --symlink usr/lib64 /lib64 --proc /proc --dev /dev --tmpfs /tmp --clearenv /bin/sh -c true
echo NESTED_BWRAP_NETLESS_OK

echo
echo "=== LINKED WORKTREE REAL BWRAP ==="

LINKED_LOG="/tmp/linked-worktree-bwrap-e2e.log"

RUN_LINKED_BWRAP_TESTS=1 \
  node \
    --test \
    --test-reporter=tap \
    /e2e/tests/unit/linked-git-worktree.test.mjs \
    >"$LINKED_LOG" \
    2>&1

LINKED_STATUS=$?

cat "$LINKED_LOG"

test "$LINKED_STATUS" -eq 0 || \
  fail "linked worktree real bwrap test exited $LINKED_STATUS"

if grep -Eq \
  "^not ok" \
  "$LINKED_LOG"; then
  fail "linked worktree real bwrap test reported a failing case"
fi

grep -Fq \
  "linked git real bubblewrap enforcement (RW and RO)" \
  "$LINKED_LOG" || \
  fail "linked worktree real bwrap enforcement case missing from output"

if grep -F \
  "linked git real bubblewrap enforcement (RW and RO)" \
  "$LINKED_LOG" \
  | grep -qi \
    "# SKIP"; then
  fail "linked worktree real bwrap enforcement case was skipped"
fi

grep -Fq \
  "deterministic relative gitdir + commondir fixture resolves and mounts" \
  "$LINKED_LOG" || \
  fail "deterministic relative gitdir case missing from output"

if grep -F \
  "deterministic relative gitdir + commondir fixture resolves and mounts" \
  "$LINKED_LOG" \
  | grep -qi \
    "# SKIP"; then
  fail "deterministic relative gitdir case was skipped"
fi

SKIP_COUNT="$(
  grep -ci \
    "^ok.*# SKIP" \
    "$LINKED_LOG" || true
)"
SKIP_COUNT="$(printf '%s' "$SKIP_COUNT" | tr -d '[:space:]')"
test -n "$SKIP_COUNT" || SKIP_COUNT=0

test "$SKIP_COUNT" -le 1 || \
  fail "unexpected skips in linked worktree test: $SKIP_COUNT"

if test "$SKIP_COUNT" -eq 1; then
  grep -qi \
    "relative-paths" \
    "$LINKED_LOG" || \
    fail "only the relative-paths case may skip on old Bookworm Git"
fi

echo LINKED_WORKTREE_BWRAP_E2E_OK

echo
echo "=== INSTALL LATEST CLIENTS ==="

echo
echo "Installing latest Codex CLI..."

curl -fsSL \
  https://chatgpt.com/codex/install.sh \
  | sh

echo
echo "Installing latest Claude Code..."

curl -fsSL \
  https://claude.ai/install.sh \
  | bash

echo
echo "Installing latest OpenCode..."

curl -fsSL \
  https://opencode.ai/install \
  | bash

export PATH="$HOME/.local/bin:$HOME/.claude/bin:$HOME/.claude/local/bin:$HOME/.opencode/bin:$HOME/bin:$PATH"

hash -r

echo
echo "=== CLIENT VERSIONS ==="

command -v codex || \
  fail "codex not found after installation"

command -v claude || \
  fail "claude not found after installation"

command -v opencode || \
  fail "opencode not found after installation"

echo
echo "Codex:"
codex --version

echo
echo "Claude Code:"
claude --version

echo
echo "OpenCode:"
opencode --version

echo
echo "=== START LOCAL RELEASE SERVER ==="

HTTP_LOG="/tmp/e2e-release-http.log"

python3 \
  -m http.server \
  "$PORT" \
  --bind 127.0.0.1 \
  --directory "$RELEASE_DIR" \
  >"$HTTP_LOG" \
  2>&1 &

HTTP_PID=$!

cleanup() {
  kill "$HTTP_PID" \
    >/dev/null 2>&1 \
    || true
}

trap cleanup EXIT

RELEASE_BASE="http://127.0.0.1:$PORT"

for attempt in $(seq 1 30); do
  if curl -fsS \
    "$RELEASE_BASE/SHA256SUMS" \
    >/dev/null
  then
    break
  fi

  sleep 0.2
done

curl -fsS \
  "$RELEASE_BASE/SHA256SUMS" \
  >/dev/null || \
  fail "local release server did not start"

echo "Release base:"
echo "  $RELEASE_BASE"

CONFIG_HOME="$HOME/.config"
DATA_HOME="$HOME/.local/share"

export XDG_CONFIG_HOME="$CONFIG_HOME"
export XDG_DATA_HOME="$DATA_HOME"
export XDG_STATE_HOME="$HOME/.local/state"
export XDG_CACHE_HOME="$HOME/.cache"
export CODEX_HOME="$HOME/.codex"

mkdir -p \
  "$XDG_CONFIG_HOME" \
  "$XDG_DATA_HOME" \
  "$XDG_STATE_HOME" \
  "$XDG_CACHE_HOME" \
  "$CODEX_HOME"

CONFIG="$XDG_CONFIG_HOME/opencode-mcp-orchestrator/config.json"

STATE="$XDG_CONFIG_HOME/opencode-mcp-orchestrator/managed-files.json"

APP_DATA="$XDG_DATA_HOME/opencode-mcp-orchestrator"

SERVER="$APP_DATA/current/libexec/mcp-server.mjs"

mkdir -p \
  "$(dirname "$CONFIG")"

write_config() {
  node - "$CONFIG" "$@" <<'NODE'
const fs = require("fs")

const path =
  process.argv[2]

const integrations =
  process.argv.slice(3)

const config = {
  version: 1,

  models: {
    scout:
      "opencode/muse-spark-1.3-contributor-free",

    worker:
      "opencode/muse-spark-1.3-contributor-free",

    runner:
      "opencode/muse-spark-1.3-contributor-free",
  },

  stepLimits: {
    profile: "standard",
  },

  integrations,
}

fs.writeFileSync(
  path,
  JSON.stringify(
    config,
    null,
    2,
  ) + "\n",
)

console.log(
  `Requested integrations: ${integrations.join(", ")}`
)
NODE
}

install_current_config() {
  label="$1"

  INSTALLER="/tmp/orchestrator-install-$label.sh"
  LOG="/tmp/orchestrator-install-$label.log"

  echo
  echo "----------------------------------------"
  echo "Install stage: $label"
  echo "----------------------------------------"

  curl -fsSL \
    "$RELEASE_BASE/install.sh" \
    -o "$INSTALLER"

  chmod +x \
    "$INSTALLER"

  OPENCODE_MCP_ORCHESTRATOR_RELEASE_BASE="$RELEASE_BASE" \
    "$INSTALLER" \
      --config "$CONFIG" \
      --non-interactive \
      2>&1 \
      | tee "$LOG"

  LAST_LOG="$LOG"

  grep -Fq \
    "DOCTOR_HEALTHY" \
    "$LOG" || \
    fail "installation doctor did not report healthy"

  assert_agent_step_limits
}

assert_agent_step_limits() {
  for specification in \
    "scout:16:12" \
    "worker:32:25" \
    "runner:40:32" \
    "runner-writable:40:32"
  do
    role="${specification%%:*}"
    remainder="${specification#*:}"
    limit="${remainder%%:*}"
    cutoff="${remainder##*:}"
    agent="$XDG_CONFIG_HOME/opencode/agents/opencode-orchestrator-$role.md"

    grep -Fqx \
      "steps: $limit" \
      "$agent" || \
      fail "$role frontmatter step limit was not rendered"

    grep -Fq \
      "at most $limit model steps" \
      "$agent" || \
      fail "$role step-budget guidance was not rendered"

    grep -Fq \
      "by step $cutoff of $limit" \
      "$agent" || \
      fail "$role synthesis reserve was not rendered"
  done

  echo AGENT_STEP_LIMITS_OK
}

assert_state() {
  expected="$1"

  test -f "$STATE" || \
    fail "managed state missing"

  actual="$(
    node - "$STATE" <<'NODE'
const fs = require("fs")

const state =
  JSON.parse(
    fs.readFileSync(
      process.argv[2],
      "utf8",
    ),
  )

process.stdout.write(
  Object.keys(
    state.integrations ?? {},
  )
    .sort()
    .join(",")
)
NODE
  )"

  echo "Managed integrations:"
  echo "  $actual"

  test "$actual" = "$expected" || \
    fail "expected managed integrations '$expected', got '$actual'"
}

assert_codex_present() {
  output="$(
    codex mcp get \
      opencode-agents \
      2>&1
  )"

  printf '%s\n' \
    "$output"

  printf '%s\n' \
    "$output" \
    | grep -Fq "$SERVER" || \
    fail "Codex registration does not reference packaged MCP server"

  test -f \
    "$HOME/.agents/skills/orchestrate/SKILL.md" || \
    fail "Codex skill missing"

  echo CODEX_PRESENT
}

assert_codex_absent() {
  if codex mcp get \
    opencode-agents \
    >/dev/null 2>&1
  then
    fail "Codex MCP registration unexpectedly exists"
  fi

  test ! -e \
    "$HOME/.agents/skills/orchestrate/SKILL.md" || \
    fail "Codex skill unexpectedly exists"

  echo CODEX_ABSENT
}

assert_claude_present() {
  output="$(
    claude mcp get \
      opencode-agents \
      2>&1
  )"

  printf '%s\n' \
    "$output"

  printf '%s\n' \
    "$output" \
    | grep -Fq "$SERVER" || \
    fail "Claude registration does not reference packaged MCP server"

  test -f \
    "$HOME/.claude/skills/orchestrate/SKILL.md" || \
    fail "Claude skill missing"

  echo CLAUDE_PRESENT
}

assert_claude_absent() {
  if claude mcp get \
    opencode-agents \
    >/dev/null 2>&1
  then
    fail "Claude MCP registration unexpectedly exists"
  fi

  test ! -e \
    "$HOME/.claude/skills/orchestrate/SKILL.md" || \
    fail "Claude skill unexpectedly exists"

  echo CLAUDE_ABSENT
}

probe_mcp() {
  test -f "$SERVER" || \
    fail "MCP server missing: $SERVER"

  node \
    /e2e/mcp-probe.mjs \
    "$SERVER"
}

probe_wait_refresh() {
  node \
    /e2e/session-wait-refresh-probe.mjs \
    "$SERVER"
}

assert_single_install_layout() {
  test -d "$APP_DATA/current" || \
    fail "current install directory missing"

  test ! -L "$APP_DATA/current" || \
    fail "current must be a real directory, not a symlink"

  test ! -e "$APP_DATA/versions" || \
    fail "legacy versions directory exists"

  test -f "$SERVER" || \
    fail "installed MCP server missing"

  test -f "$APP_DATA/install-manifest.json" || \
    fail "install manifest missing"

  echo SINGLE_INSTALL_LAYOUT_OK
}

echo
echo "========================================"
echo "STAGE 1: CODEX ONLY"
echo "========================================"

write_config \
  codex

install_current_config \
  codex-only

assert_single_install_layout
assert_codex_present
assert_claude_absent
assert_state \
  "codex"

probe_mcp

echo STAGE_1_CODEX_ONLY_PASS

echo
echo "========================================"
echo "STAGE 2: CLAUDE ONLY"
echo "========================================"

write_config \
  claude

install_current_config \
  claude-only

assert_single_install_layout

grep -Fq \
  "Existing installation detected." \
  "$LAST_LOG" || \
  fail "replacement installation detection missing"

grep -Fq \
  "UNINSTALL_FOR_UPDATE_COMPLETE" \
  "$LAST_LOG" || \
  fail "replacement cleanup marker missing"

assert_codex_absent
assert_claude_present
assert_state \
  "claude"

probe_mcp

echo STAGE_2_CLAUDE_ONLY_PASS

echo
echo "========================================"
echo "STAGE 3: BOTH"
echo "========================================"

write_config \
  codex \
  claude

install_current_config \
  both

assert_single_install_layout
assert_codex_present
assert_claude_present
assert_state \
  "claude,codex"

probe_mcp

probe_wait_refresh

echo STAGE_3_BOTH_PASS

echo
echo "========================================"
echo "STAGE 4: BOTH AGAIN / CLEAN REPLACEMENT"
echo "========================================"

write_config \
  codex \
  claude

install_current_config \
  both-again

assert_single_install_layout

grep -Fq \
  "Existing installation detected." \
  "$LAST_LOG" || \
  fail "same-release replacement detection missing"

grep -Fq \
  "UNINSTALL_FOR_UPDATE_COMPLETE" \
  "$LAST_LOG" || \
  fail "same-release replacement cleanup missing"

assert_codex_present
assert_claude_present
assert_state \
  "claude,codex"

probe_mcp

echo STAGE_4_REPLACEMENT_REINSTALL_PASS

echo
echo "========================================"
echo "UNINSTALL"
echo "========================================"

CONFIG_BEFORE_UNINSTALL="$(
  cat "$CONFIG"
)"

node \
  "$APP_DATA/current/libexec/uninstall.mjs"

assert_codex_absent
assert_claude_absent

test ! -e "$APP_DATA" || \
  fail "application payload remains after uninstall"

test ! -e "$STATE" || \
  fail "managed ownership state remains after uninstall"

for managed_path in \
  "$XDG_CONFIG_HOME/opencode/agents/opencode-orchestrator-scout.md" \
  "$XDG_CONFIG_HOME/opencode/agents/opencode-orchestrator-worker.md" \
  "$XDG_CONFIG_HOME/opencode/agents/opencode-orchestrator-runner.md" \
  "$XDG_CONFIG_HOME/opencode/agents/opencode-orchestrator-runner-writable.md" \
  "$XDG_CONFIG_HOME/opencode/plugins/opencode-mcp-orchestrator/index.ts"
do
  test ! -e "$managed_path" || \
    fail "managed OpenCode file remains after uninstall: $managed_path"
done

echo OPENCODE_BACKEND_ABSENT

test -f "$CONFIG" || \
  fail "configuration should be preserved by default"

CONFIG_AFTER_UNINSTALL="$(
  cat "$CONFIG"
)"

test \
  "$CONFIG_BEFORE_UNINSTALL" = "$CONFIG_AFTER_UNINSTALL" || \
  fail "preserved configuration changed during uninstall"

echo CONFIG_PRESERVED

echo
echo "========================================"
echo "LEGACY v0.1.2 -> CURRENT RELEASE MIGRATION"
echo "========================================"

LEGACY_BASE="https://github.com/Mesya82/opencode-mcp-orchestrator/releases/download/v0.1.2"
LEGACY_INSTALLER="/tmp/opencode-orchestrator-legacy-v0.1.2.sh"

curl -fsSL \
  "$LEGACY_BASE/install.sh" \
  -o "$LEGACY_INSTALLER"

chmod +x \
  "$LEGACY_INSTALLER"

CONFIG_BEFORE_LEGACY_MIGRATION="$(
  cat "$CONFIG"
)"

OPENCODE_MCP_ORCHESTRATOR_RELEASE_BASE="$LEGACY_BASE" \
  "$LEGACY_INSTALLER" \
    --config "$CONFIG" \
    --non-interactive

test -L "$APP_DATA/current" || \
  fail "legacy v0.1.2 current path is not a symlink"

test "$(
  readlink "$APP_DATA/current"
)" = "versions/0.1.2" || \
  fail "unexpected legacy v0.1.2 current target"

test -d "$APP_DATA/versions/0.1.2" || \
  fail "legacy v0.1.2 payload directory missing"

assert_codex_present
assert_claude_present
assert_state \
  "claude,codex"

probe_mcp

echo LEGACY_V0_1_2_INSTALL_PROVEN

echo
echo "Migrating legacy v0.1.2 installation to candidate release..."

install_current_config \
  legacy-migration

assert_single_install_layout

test ! -e "$APP_DATA/versions" || \
  fail "legacy versions directory survived migration"

assert_codex_present
assert_claude_present
assert_state \
  "claude,codex"

probe_mcp

CONFIG_AFTER_LEGACY_MIGRATION="$(
  cat "$CONFIG"
)"

test \
  "$CONFIG_BEFORE_LEGACY_MIGRATION" = "$CONFIG_AFTER_LEGACY_MIGRATION" || \
  fail "configuration changed during legacy migration"

grep -Fq \
  "Existing installation detected." \
  "$LAST_LOG" || \
  fail "legacy migration did not detect existing installation"

grep -Fq \
  "UNINSTALL_FOR_UPDATE_COMPLETE" \
  "$LAST_LOG" || \
  fail "legacy migration did not perform replacement cleanup"

echo LEGACY_V0_1_2_TO_SINGLE_INSTALL_PROVEN

echo
echo "========================================"
echo "FINAL UNINSTALL AFTER LEGACY MIGRATION"
echo "========================================"

CONFIG_BEFORE_FINAL_UNINSTALL="$(
  cat "$CONFIG"
)"

node \
  "$APP_DATA/current/libexec/uninstall.mjs"

assert_codex_absent
assert_claude_absent

test ! -e "$APP_DATA" || \
  fail "application payload remains after final uninstall"

test ! -e "$STATE" || \
  fail "managed ownership state remains after final uninstall"

test -f "$CONFIG" || \
  fail "configuration should remain after final uninstall"

CONFIG_AFTER_FINAL_UNINSTALL="$(
  cat "$CONFIG"
)"

test \
  "$CONFIG_BEFORE_FINAL_UNINSTALL" = "$CONFIG_AFTER_FINAL_UNINSTALL" || \
  fail "configuration changed during final uninstall"

echo FINAL_LEGACY_MIGRATION_CLEANUP_OK

echo
echo "========================================"
echo "E2E PASS"
echo "========================================"
echo
echo "Latest real clients:"
codex --version
claude --version
opencode --version
echo
echo "Verified:"
echo "  curl-based install"
echo "  Codex only"
echo "  Codex -> Claude clean replacement"
echo "  Claude -> Both transition"
echo "  same-release Both -> Both clean replacement"
echo "  public v0.1.2 -> single-install migration"
echo "  real Codex MCP registration"
echo "  real Claude MCP registration"
echo "  MCP initialize + tools/list"
echo "  scout / worker / runner tool contract"
echo "  installed bundle bounded wait refresh plus progress telemetry"
echo "  uninstall"
echo "  OpenCode backend cleanup"
echo "  preserved user configuration"
echo
echo E2E_DESIRED_STATE_COMPLETE
