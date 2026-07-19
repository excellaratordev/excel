# Motor Rust/WebAssembly do Super Excel

Este crate contém um núcleo funcional e stateful do motor de fórmulas em Rust/Wasm. Ele ainda não substitui todo o runtime JavaScript, mas já mantém workbooks locais, dependências, cache e recálculo seletivo para a fatia de fórmulas suportada.

## Estado atual

A ABI versão `3` implementa:

- alocação e desalocação de memória linear;
- validação estrutural de envelopes JSON;
- parser e AST próprios;
- referências A1 e intervalos locais limitados a 4.096 células por fórmula;
- operadores `+`, `-`, `*`, `/`, `^`, `&`, `%` e comparações;
- matrizes e broadcasting básico no avaliador stateless;
- funções `SOMA`, `MÉDIA`, `MÍNIMO`, `MÁXIMO`, `CONT.NÚM`, `SE`, `E`, `OU`, `NÃO`, `SEERRO`, `ABS` e `ARRED`, com aliases em inglês;
- resposta JSON tipada com valor, dependências e status;
- registro de workbooks por handle;
- armazenamento de valores e fórmulas locais em Rust;
- grafo reverso de dependências entre células;
- cache de resultados por célula;
- invalidação transitiva somente das cadeias afetadas;
- detecção de ciclos durante a avaliação;
- aplicação de alterações em lote com revisão e lista de afetados;
- métricas de cache, recálculo, atualizações e arestas;
- integração experimental no navegador com modos `off`, `shadow` e `prefer`.

## Modos do navegador

O modo é controlado por `?wasm=` ou por `localStorage['superexcel.wasm.mode']`:

- `off`: somente JavaScript, padrão atual;
- `shadow`: JavaScript continua autoritativo e o resultado Rust é comparado em segundo plano;
- `prefer`: fórmulas escalares suportadas são avaliadas no workbook Rust; recursos não suportados usam fallback JavaScript.

Exemplo:

```text
/sheet/123?wasm=shadow
/sheet/123?wasm=prefer
```

## ABI versão 3

Exports stateless:

```text
superexcel_abi_version() -> u32
superexcel_alloc(len) -> pointer
superexcel_dealloc(pointer, len)
superexcel_validate_operation(pointer, len) -> 0 | 1
superexcel_evaluate_formula(pointer, len) -> result_pointer
superexcel_last_result_len() -> usize
```

Exports stateful:

```text
superexcel_workbook_create(pointer, len) -> result_pointer
superexcel_workbook_apply(handle, pointer, len) -> result_pointer
superexcel_workbook_get_cell(handle, pointer, len) -> result_pointer
superexcel_workbook_stats(handle) -> result_pointer
superexcel_workbook_destroy(handle) -> 0 | 1
```

Criação de workbook:

```json
{
  "cells": {
    "A1": 2,
    "B1": "=A1*3",
    "C1": "=B1+1"
  }
}
```

Alteração incremental:

```json
{
  "changes": {
    "A1": 4
  }
}
```

A resposta informa a revisão e somente a cadeia afetada:

```json
{
  "status": "ok",
  "revision": 1,
  "affected": ["A1", "B1", "C1"]
}
```

## Cache e invalidação

Ao consultar uma fórmula, o núcleo:

1. reutiliza o valor quando a célula está no cache;
2. resolve recursivamente apenas as dependências necessárias;
3. detecta ciclos pela pilha de avaliação;
4. armazena o resultado calculado;
5. invalida somente a célula alterada e seus dependentes transitivos.

Fórmulas independentes permanecem no cache após uma alteração em outra cadeia.

## Integração com o runtime JavaScript

O navegador cria um workbook Rust a partir da matriz atual e espelha alterações feitas por `setCellContents`. Alterações agrupadas por `suspendEvaluation` e `resumeEvaluation` são enviadas em lote.

Após `undo` ou `redo`, o espelho Rust é reconstruído a partir do estado serializado pelo runtime JavaScript. O handle também é destruído quando o runtime é encerrado ou o modo Wasm volta para `off`.

## Limites atuais

Ainda permanecem no runtime JavaScript:

- funções empresariais avançadas, como `SOMASES`, `PROCX`, `ÍNDICE` e `CORRESP`;
- referências externas a Bases e Planilhas;
- matrizes dinâmicas completas e spill autoritativo;
- undo/redo e transações como fonte oficial do histórico;
- persistência, snapshots e colaboração;
- grafo otimizado por buckets para intervalos muito grandes;
- resultado autoritativo de matrizes no modo `prefer`.

Quando uma fórmula não é suportada, o núcleo retorna `unsupported`; o navegador preserva o resultado JavaScript.

## Limites de segurança

- até 4 MB por payload ABI;
- até 4.096 células expandidas por intervalo;
- até 100.000 células armazenadas por workbook experimental;
- até 10.000 alterações por lote.

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
pytest -q tests/test_wasm_frontend.py
```
