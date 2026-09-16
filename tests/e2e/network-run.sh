#!/usr/bin/env bash

set -Eeuo pipefail

NETWORK_LOG="/tmp/runner-network-access-e2e.log"

set +e
node /e2e/network-access.mjs >"$NETWORK_LOG" 2>&1
NETWORK_STATUS=$?
set -e

cat "$NETWORK_LOG"

test "$NETWORK_STATUS" -eq 0 || {
  echo "ERROR: runner network access e2e exited $NETWORK_STATUS" >&2
  exit 1
}

for marker in \
  RUNNER_NETWORK_ACCESS_E2E_OK \
  LOOPBACK_HTTP_HOST_OK \
  LOOPBACK_HTTP_DISABLED_DENY_OK \
  DNS_RESOLVER_HOST_OK \
  TLS_VERIFIED_HOST_OK \
  CA_SYMLINK_NO_LEXICAL_BIND_OK \
  CA_SYMLINK_LAYOUT_HOST_OK \
  CA_SSL_CERT_PEM_BIND_SHAPE_OK \
  CA_SSL_CERT_PEM_READ_OK \
  TLS_CACERT_SSL_CERT_PEM_OK \
  ARCH_CA_NARROW_BINDS_OK \
  ARCH_CA_COMPAT_RESOLVE_OK \
  TLS_CACERT_ARCH_OK \
  SUSE_CA_NARROW_BINDS_OK \
  SUSE_NO_BROAD_VAR_OK \
  SUSE_CA_BUNDLE_VISIBLE_OK \
  TLS_CACERT_SUSE_OK
do
  grep -Fq "$marker" "$NETWORK_LOG" || {
    echo "ERROR: runner network access marker missing: $marker" >&2
    exit 1
  }
done

echo RUNNER_NETWORK_ACCESS_E2E_STAGE_OK
