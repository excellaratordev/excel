# Super Excel Rust/Wasm contract

This crate establishes ABI version `1` between the browser runtime and the future Rust calculation engine.

Exports:

- `superexcel_abi_version() -> u32`
- `superexcel_alloc(len) -> pointer`
- `superexcel_dealloc(pointer, len)`
- `superexcel_validate_operation(pointer, len) -> 0 | 1`

Operations cross the boundary as UTF-8 JSON envelopes. Every operation must contain an idempotency `id` and a `kind`. The first supported kind is `cells.patch`.

The JavaScript adapter is `static/js/wasm/engine-contract.js`. Formula evaluation remains in the JavaScript incremental runtime until Rust reaches functional parity.
