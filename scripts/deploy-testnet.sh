#!/usr/bin/env bash
# Deploys Afterkey to NEAR testnet with near-cli-rs (https://github.com/near/near-cli-rs).
# Usage: ACCOUNT=yourname.testnet ./scripts/deploy-testnet.sh
# Run ./scripts/build-contracts.sh first. Your ACCOUNT must be in the near-cli keychain
# (near account import-account ...) and hold ~15 testnet NEAR (faucet: https://near-faucet.io).
set -euo pipefail
cd "$(dirname "$0")/.."
: "${ACCOUNT:?set ACCOUNT=yourname.testnet}"
FACTORY="afterkey.${ACCOUNT}"
HASH=$(cat out/will.hash)

echo "== 1/3 publish the will code once, pinned by its hash (nobody can change code pinned by hash)"
near contract deploy-as-global use-file out/will.wasm as-global-hash "$ACCOUNT" \
  network-config testnet sign-with-keychain send

echo "== 2/3 create the factory account $FACTORY"
near account create-account fund-myself "$FACTORY" '5 NEAR' autogenerate-new-keypair save-to-keychain \
  sign-as "$ACCOUNT" network-config testnet sign-with-keychain send

echo "== 3/3 deploy and initialise the factory"
near contract deploy "$FACTORY" use-file out/factory.wasm with-init-call new \
  json-args "{\"will_code_hash\":\"$HASH\",\"mpc_contract\":\"v1.signer-prod.testnet\",\"min_deposit\":\"500000000000000000000000\"}" \
  prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send

echo
echo "Done. Factory: $FACTORY   Will code hash: $HASH"
echo "Build the app with:  cd app && VITE_FACTORY=$FACTORY npm run build"
echo "Telegram alerts:     see alerts/README.md (free on Cloudflare Workers, set FACTORY=$FACTORY)"
