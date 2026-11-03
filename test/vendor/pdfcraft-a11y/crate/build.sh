#!/usr/bin/env bash
# Build the checker into the vendor directory beside this crate: the wasm module and its JavaScript glue.
#
# Needs: the wasm32-unknown-unknown target (rustup target add wasm32-unknown-unknown) and wasm-bindgen at the version Cargo.lock pins (cargo install wasm-bindgen-cli --version 0.2.129). Optional: wasm-opt (brew install binaryen) shrinks the module, and brotli measures it for the README.
set -euo pipefail
cd "$(dirname "$0")"

target="${CARGO_TARGET_DIR:-target}"
cargo build --release --target wasm32-unknown-unknown
wasm-bindgen --target web --no-typescript --out-dir .. "$target/wasm32-unknown-unknown/release/pdfcraft_a11y_wasm.wasm"
if command -v wasm-opt >/dev/null; then
  # rustc 1.99 emits bulk-memory and non-trapping float-to-int instructions, which wasm-opt must be told to accept.
  wasm-opt -Oz --enable-bulk-memory --enable-nontrapping-float-to-int -o ../pdfcraft_a11y_wasm_bg.wasm ../pdfcraft_a11y_wasm_bg.wasm
else
  echo "wasm-opt not found: the module stays unoptimised" >&2
fi
ls -l ../pdfcraft_a11y_wasm.js ../pdfcraft_a11y_wasm_bg.wasm
if command -v brotli >/dev/null; then
  echo "with Brotli: $(brotli -c -q 11 ../pdfcraft_a11y_wasm_bg.wasm | wc -c | tr -d ' ') bytes"
fi
