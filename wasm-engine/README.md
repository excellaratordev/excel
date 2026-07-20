# Motor Rust/WebAssembly do Super Excel

Este crate contém um núcleo funcional e stateful do motor de fórmulas em Rust/Wasm. Ele ainda não substitui todo o runtime JavaScript, mas já mantém workbooks locais, dependências, cache e recálculo seletivo para a fatia de fórmulas suportada.

## Estado atual

A ABI versão `4` implementa:

- alocação e desalocação de memória linear;
- validação estrutural de envelopes JSON;
- parser e AST próprios;
- IR JSON de fórmulas versão `1`;
- compilação de fórmula para IR em Rust, comparável à IR produzida pelo parser JavaScript;
- referências A1 e intervalos locais limitados a 4.096 células por fórmula;
- operadores `+`, `-`, `*`, `/`, `^`, `&`, `%` e comparações;
- matrizes e broadcasting básico no avaliador stateless;
- funções `SOMA`, `MÉDIA`, `MÍNIMO`, `MÁXIMO`, `CONT.NÚM`, `SE`, `E`, `OU`, `NÃO`, `SEERRO`, `ABS` e `ARRED`;
- funções condicionais `CONT.SE`, `CONT.SES`, `SOMASE`, `SOMASES`, `MÉDIASE` e `MÉDIASES`;
- critérios numéricos, operadores de comparação e curingas `*` e `?`;
- buscas `PROCV`, `PROCX`, `ÍNDICE` e `CORRESP`;
- aliases em inglês para as funções suportadas;
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

## ABI versão 4

Exports stateless:

```text
superexcel_abi_version() -> u32
superexcel_alloc(len) -> pointer
superexcel_dealloc(pointer, len)
superexcel_validate_operation(pointer, len) -> 0 | 1
superexcel_compile_formula(pointer, len) -> result_pointer
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

## IR de fórmulas versão 1

Entrada:

```json
{"formula":"=SOMASES(C1:C3;A1:A3;"Pago";B1:B3;">10")"}
```

Saída simplificada:

```json
{
  "status": "ok",
  "ir_version": 1,
  "dependencies": ["A1", "A2", "A3", "B1", "B2", "B3", "C1", "C2", "C3"],
  "ast": {
    "type": "call",
    "name": "SOMASES",
    "args": []
  }
}
```

O campo `args` contém a árvore completa. A suíte diferencial valida que JavaScript e Rust produzem a mesma estrutura semântica para fórmulas locais representativas.

## Workbook incremental

Criação:

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
{"changes":{"A1":4}}
```

Resposta:

```json
{
  "status": "ok",
  "revision": 1,
  "affected": ["A1", "B1", "C1"]
}
```

Ao consultar uma fórmula, o núcleo reutiliza o cache quando válido, resolve apenas as dependências necessárias, detecta ciclos e invalida somente a célula alterada e seus dependentes transitivos.

## Integração com o runtime JavaScript

O navegador cria um workbook Rust a partir da matriz atual e espelha alterações feitas por `setCellContents`. Alterações agrupadas por `suspendEvaluation` e `resumeEvaluation` são enviadas em lote.

Após `undo` ou `redo`, o espelho Rust é reconstruído a partir do estado serializado pelo runtime JavaScript. O handle também é destruído quando o runtime é encerrado ou o modo Wasm volta para `off`.

## Limites atuais

Ainda permanecem no runtime JavaScript:

- `FILTRO`, `ÚNICO`, `CLASSIFICAR` e demais matrizes dinâmicas completas;
- referências externas a Bases e Planilhas;
- spill autoritativo;
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

O artefato é copiado para `static/wasm/superexcel_wasm_engine.wasm`.

## Testes

```bash
cargo test --manifest-path wasm-engine/Cargo.toml
node --test tests/js/formula-ir.test.js
node tests/js/wasm-engine.integration.mjs static/wasm/superexcel_wasm_engine.wasm
pytest -q tests/test_wasm_frontend.py
```
