#!/usr/bin/env bash
#
# tests/e2e/github-userns.sh
#
# Disposable GitHub-hosted-runner-only wrapper for the Docker E2E loopback
# AppArmor blocker (kernel.apparmor_restrict_unprivileged_userns).
#
# Usage:
#   bash tests/e2e/github-userns.sh <command> [args...]
# Example:
#   bash tests/e2e/github-userns.sh npm run test:e2e
#
# Behavior:
# - Refuses to run outside GitHub-hosted runners BEFORE any sysctl write:
#   requires GITHUB_ACTIONS=true AND RUNNER_ENVIRONMENT=github-hosted.
# - If the sysctl key is truly absent, logs and runs the supplied command
#   unchanged (no sandbox skip).
# - Otherwise captures and validates the prior value (must be 0 or 1),
#   installs an EXIT trap BEFORE the privileged write, sets the key to 0,
#   verifies, executes the supplied command, and restores + verifies the
#   exact prior value on success, failure, and signals (via EXIT trap).
# - Preserves the supplied command's nonzero status; exits nonzero if the
#   restore or its verification fails.
# - Never writes persistent sysctl.conf files.

set -Eeuo pipefail

SYSCTL_KEY="kernel.apparmor_restrict_unprivileged_userns"

if test "$#" -eq 0; then
  echo "Usage: $0 <command> [args...]" >&2
  exit 2
fi

# Boundary guard: refuse BEFORE any sysctl interaction.
if test "${GITHUB_ACTIONS:-}" != "true" || test "${RUNNER_ENVIRONMENT:-}" != "github-hosted"; then
  echo "ERROR: $0 is only permitted on disposable GitHub-hosted runners (requires GITHUB_ACTIONS=true and RUNNER_ENVIRONMENT=github-hosted)." >&2
  exit 1
fi

# Only an explicit missing-key error permits passthrough. Permission and
# other read failures must not be mistaken for an absent kernel feature.
PRIOR=""
if ! PRIOR="$(LC_ALL=C sysctl -n "$SYSCTL_KEY" 2>&1)"; then
  if test "$PRIOR" = "sysctl: cannot stat /proc/sys/kernel/apparmor_restrict_unprivileged_userns: No such file or directory"; then
    echo "INFO: sysctl key $SYSCTL_KEY absent; running supplied command without userns adjustment."
    "$@"
    exit "$?"
  fi
  echo "ERROR: cannot read $SYSCTL_KEY; refusing userns adjustment." >&2
  exit 1
fi

# Validate prior value before mutating anything.
case "$PRIOR" in
  0|1)
    ;;
  *)
    echo "ERROR: unexpected prior value for $SYSCTL_KEY: '$PRIOR' (expected 0 or 1)." >&2
    exit 1
    ;;
esac

# Install the EXIT trap BEFORE the privileged write so success, failure,
# and signals all restore the exact prior value. The trap body runs at
# shell EXIT only; it never runs before the E2E command itself.
MUTATED=0
restore_userns() {
  rc=$?
  set +e
  if test "$MUTATED" = "1"; then
    if ! sudo sysctl -w "${SYSCTL_KEY}=${PRIOR}" >/dev/null; then
      echo "ERROR: failed to restore $SYSCTL_KEY to $PRIOR." >&2
      exit 1
    fi
    CURRENT=""
    if ! CURRENT="$(sysctl -n "$SYSCTL_KEY" 2>/dev/null)"; then
      echo "ERROR: failed to verify $SYSCTL_KEY restore to $PRIOR (key unreadable)." >&2
      exit 1
    fi
    if test "$CURRENT" != "$PRIOR"; then
      echo "ERROR: restore verification failed for $SYSCTL_KEY: got '$CURRENT', expected '$PRIOR'." >&2
      exit 1
    fi
    echo "Restored $SYSCTL_KEY=$PRIOR."
  fi
  return "$rc"
}
trap restore_userns EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# Mark mutation intent before the write so a partial-mutation write
# failure still attempts the restore path via the EXIT trap.
MUTATED=1
if ! sudo sysctl -w "${SYSCTL_KEY}=0" >/dev/null; then
  echo "ERROR: failed to set $SYSCTL_KEY to 0." >&2
  exit 1
fi

CURRENT=""
if ! CURRENT="$(sysctl -n "$SYSCTL_KEY" 2>/dev/null)"; then
  echo "ERROR: failed to verify $SYSCTL_KEY after write (key unreadable)." >&2
  exit 1
fi
if test "$CURRENT" != "0"; then
  echo "ERROR: verification failed for $SYSCTL_KEY: got '$CURRENT', expected '0'." >&2
  exit 1
fi
echo "Set $SYSCTL_KEY=0 (prior $PRIOR) for disposable E2E run."

# Execute the ENTIRE supplied command and preserve its status.
# The EXIT trap restores the prior value afterwards.
CMD_STATUS=0
"$@" || CMD_STATUS=$?
exit "$CMD_STATUS"
