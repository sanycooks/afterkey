#!/usr/bin/env bash
# Builds the will and factory contracts to WebAssembly and prints the will's code hash.
# Run on your own machine or VPS (needs internet access to Rust's servers).
set -euo pipefail
cd "$(dirname "$0")/../contracts"

command -v cargo >/dev/null || { echo "Install Rust first: https://rustup.rs"; exit 1; }
rustup target add wasm32-unknown-unknown >/dev/null
command -v cargo-near >/dev/null || cargo install --locked cargo-near

echo "== running tests"
cargo test --quiet

echo "== building"
(cd will && cargo near build non-reproducible-wasm)
(cd factory && cargo near build non-reproducible-wasm)

mkdir -p ../out
cp "$(find target/near -name 'afterkey_will.wasm' | head -1)" ../out/will.wasm
cp "$(find target/near -name 'afterkey_factory.wasm' | head -1)" ../out/factory.wasm

HASH=$(python3 - <<'PY'
import hashlib
d = hashlib.sha256(open('../out/will.wasm','rb').read()).digest()
A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
n = int.from_bytes(d, 'big'); s = ''
while n: n, r = divmod(n, 58); s = A[r] + s
print('1' * (len(d) - len(d.lstrip(b'\0'))) + s)
PY
)
echo "$HASH" > ../out/will.hash
ls -la ../out
echo "will code hash: $HASH"
