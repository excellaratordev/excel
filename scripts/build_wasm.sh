#!/usr/bin/env sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TARGET="$ROOT/wasm-engine/target/wasm32-unknown-unknown/release/superexcel_wasm_engine.wasm"
OUTPUT="$ROOT/static/wasm/superexcel_wasm_engine.wasm"

cargo build --manifest-path "$ROOT/wasm-engine/Cargo.toml" --target wasm32-unknown-unknown --release
mkdir -p "$(dirname "$OUTPUT")"
cp "$TARGET" "$OUTPUT"
printf 'Wasm gerado em %s\n' "$OUTPUT"
