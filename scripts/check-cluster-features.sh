#!/usr/bin/env bash
# Fails unless exactly one of localnet/devnet/mainnet is enabled.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
log="$(mktemp)"

expect_fail() {
  local desc="$1"
  shift
  if cargo check -p fizzcaps_onchain --lib "$@" >"$log" 2>&1; then
    echo "FAIL: $desc compiled, but exactly one cluster feature is required"
    exit 1
  fi
  if ! grep -q "exactly one of the" "$log"; then
    echo "FAIL: $desc did not emit the cluster compile_error"
    cat "$log"
    exit 1
  fi
  echo "ok: $desc rejected"
}

expect_fail "no cluster feature" --no-default-features
expect_fail "localnet+devnet" --no-default-features --features localnet,devnet
expect_fail "devnet+mainnet" --no-default-features --features devnet,mainnet
expect_fail "all three cluster features" --no-default-features --features localnet,devnet,mainnet
expect_fail "default localnet plus devnet" --features devnet

echo "cluster feature gate ok"
