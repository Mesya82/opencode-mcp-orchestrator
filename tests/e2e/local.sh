#!/usr/bin/env bash

set -Eeuo pipefail

ROOT="$(
  cd "$(dirname "${BASH_SOURCE[0]}")/../.."
  pwd
)"

VERSION="${E2E_VERSION:-0.0.0-e2e}"
IMAGE="${E2E_IMAGE:-opencode-mcp-orchestrator-e2e:local}"
RUNTIME="${E2E_CONTAINER_RUNTIME:-}"
REPOSITORY="${E2E_REPOSITORY:-${GITHUB_REPOSITORY:-Mesya82/opencode-mcp-orchestrator}}"

cd "$ROOT"

if test -z "$RUNTIME"; then
  if command -v podman >/dev/null 2>&1; then
    RUNTIME="podman"
  elif command -v docker >/dev/null 2>&1; then
    RUNTIME="docker"
  else
    echo "ERROR: podman or docker is required" >&2
    exit 1
  fi
fi

case "$RUNTIME" in
  podman|docker)
    ;;
  *)
    echo "ERROR: unsupported container runtime: $RUNTIME" >&2
    exit 1
    ;;
esac

echo "Container runtime: $RUNTIME"
echo "E2E version:       $VERSION"
echo "Repository:        $REPOSITORY"

echo
echo "=== BUILD RELEASE ==="

npm run build
npm run test:focused

rm -rf release

node \
  scripts/package-release.mjs \
  --version "$VERSION" \
  --repository "$REPOSITORY"

(
  cd release
  sha256sum -c SHA256SUMS
)

echo
echo "=== BUILD E2E IMAGE ==="

"$RUNTIME" build \
  --pull \
  --file tests/e2e/Containerfile \
  --tag "$IMAGE" \
  .

echo
echo "=== RUN E2E ==="

if test "$RUNTIME" = "podman"; then
  "$RUNTIME" run \
    --rm \
    --dns 127.0.0.1 \
    --sysctl net.ipv4.ip_unprivileged_port_start=0 \
    --security-opt seccomp=unconfined \
    --security-opt systempaths=unconfined \
    --security-opt label=disable \
    --entrypoint /bin/bash \
    "$IMAGE" \
    /e2e/network-run.sh

  "$RUNTIME" run \
    --rm \
    --security-opt seccomp=unconfined \
    --security-opt systempaths=unconfined \
    --security-opt label=disable \
    --volume "$ROOT/release:/release:ro,Z" \
    "$IMAGE"
else
  # Disposable E2E container needs nested namespaces for bwrap/Doctor probes.
  "$RUNTIME" run \
    --rm \
    --dns 127.0.0.1 \
    --sysctl net.ipv4.ip_unprivileged_port_start=0 \
    --security-opt seccomp=unconfined \
    --security-opt apparmor=unconfined \
    --security-opt systempaths=unconfined \
    --entrypoint /bin/bash \
    "$IMAGE" \
    /e2e/network-run.sh

  "$RUNTIME" run \
    --rm \
    --security-opt seccomp=unconfined \
    --security-opt apparmor=unconfined \
    --security-opt systempaths=unconfined \
    --volume "$ROOT/release:/release:ro" \
    "$IMAGE"
fi
