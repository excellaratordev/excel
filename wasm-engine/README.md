# Motor Rust/WebAssembly do Super Excel

Este crate contém a primeira fatia funcional do motor de fórmulas em Rust/Wasm. Ele ainda não substitui todo o runtime JavaScript, mas deixou de ser apenas uma validação de ABI.

## Estado atual

A ABI versão `2` implementa:

- alocação e desalocação de memória linear;
- validação estrutural de envelopes JSON;
- parser próprio de fórmulas escalares;
- referências A1 locais;
- intervalos locais limitados a 4.096 células por avaliação;
- operadores `+`, `-`, `*`, `/`, `^`, `&`, `%` e comparações;
- matrizes e broadcasting básico;
- funções `SOMA`, `MÉDIA`, `MÍNIMO`, `MÁXIMO`, `CONT.NÚM`, `SE`, `E`, `OU`, `NÃO`, `SEERRO`, `ABS` e `ARRED`, com aliases em inglês;
- resposta JSON tipada com valor, dependências e status;
- integração experimental no navegador com modos `off`, `shadow` e `prefer`.

## Modos do navegador

O modo é controlado por `?wasm=` ou por `localStorage['superexcel.wasm.mode']`:

- `off`: somente JavaScript;
- `shadow`: JavaScript continua autoritativo e o resultado Rust é comparado em segundo plano;
- `prefer`: fórmulas suportadas são avaliadas em Rust; recursos não suportados usam fallback JavaScript.

Exemplo:

```text
/sheet/123?wasm=shadow
```

## ABI versão 2

Exports principais:

```text
superexcel_abi_version() -> u32
superexcel_alloc(len) -> pointer
superexcel_dealloc(pointer, len)
superexcel_validate_operation(pointer, len) -> 0 | 1
superexcel_evaluate_formula(pointer, len) -> result_pointer
superexcel_last_result_len() -> usize
```

Entrada de avaliação:

```json
{
  "formula": "=SOMA(A1:A3)+B1",
  "cells": {
    "A1": 2,
    "A2": 3,
    "A3": 5,
    "B1": 10
  }
}
```

Saída:

```json
{
  "status": "ok",
  "value": 20,
  "value_type": "number",
  "dependencies": ["A1", "A2", "A3", "B1"],
  "error": null
}
```

## Limites atuais

Ainda permanecem no runtime JavaScript:

- grafo autoritativo de dependências;
- cache e invalidação transitiva;
- alterações em lote, undo e redo;
- referências externas a Bases e Planilhas;
- funções de busca, critérios e matrizes dinâmicas avançadas;
- spill autoritativo;
- persistência e colaboração.

O próximo objetivo é mover o grafo e o cache para Rust sem mudar a API pública da grade.

## Build

```bash
sh scripts/build_wasm.sh
```

O artefato é copiado para:

```text
static/wasm/superexcel_wasm_engine.wasm
```

## Testes

```bash
cargo test --manifest-path wasm-engine/Cargo.toml
node tests/js/wasm-engine.integration.mjs static/wasm/superexcel_wasm_engine.wasm
```
