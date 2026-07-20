# Motor Rust/WebAssembly do Super Excel

Este crate contém um núcleo funcional e stateful do motor de fórmulas em Rust/Wasm. Ele ainda não substitui todo o runtime JavaScript, mas já mantém workbooks locais, dependências, cache e recálculo seletivo para a fatia de fórmulas suportada.

## Estado atual

A ABI versão `7` implementa:

- alocação e desalocação de memória linear;
- validação estrutural de envelopes JSON;
- parser e AST próprios;
- IR JSON de fórmulas versão `2`, com referências diretas e retângulos separados;
- compilação de fórmula para IR em Rust, comparável à IR produzida pelo parser JavaScript;
- referências A1 e ranges locais de até 4.096 posições no avaliador stateless e 100.000 no workbook stateful;
- operadores `+`, `-`, `*`, `/`, `^`, `&`, `%` e comparações;
- matrizes e broadcasting básico no avaliador stateless;
- funções `SOMA`, `MÉDIA`, `MÍNIMO`, `MÁXIMO`, `CONT.NÚM`, `SE`, `E`, `OU`, `NÃO`, `SEERRO`, `ABS` e `ARRED`;
- funções condicionais `CONT.SE`, `CONT.SES`, `SOMASE`, `SOMASES`, `MÉDIASE` e `MÉDIASES`;
- critérios numéricos, operadores de comparação e curingas `*` e `?`;
- buscas `PROCV`, `PROCX`, `ÍNDICE` e `CORRESP`;
- matrizes dinâmicas `FILTRO`, `ÚNICO` e `CLASSIFICAR`;
- resultados `array` em JSON, limitados a 10.000 células;
- plano de spill stateful com estados `ready`, `blocked` e `scalar`;
- detecção de células bloqueadoras e retorno `#DESPEJAR!`;
- aliases em inglês para as funções suportadas;
- resposta JSON tipada com valor, dependências e status;
- registro de workbooks por handle;
- armazenamento de valores e fórmulas locais em Rust;
- grafo reverso para referências diretas e índice de intervalos em buckets 256×32;
- índice `BTreeMap` das células ocupadas por coordenada;
- avaliador stateful esparso para ranges acima de 4.096 posições;
- agregações simples que leem apenas células ocupadas;
- critérios e buscas que preservam posições em branco sem criar matrizes densas;
- cache de resultados por célula;
- invalidação transitiva somente das cadeias afetadas;
- detecção de ciclos durante a avaliação;
- aplicação de alterações em lote com revisão e lista de afetados;
- métricas de cache, recálculo, ranges esparsos, células resolvidas, planos de spill e conflitos;
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

## ABI versão 7

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
superexcel_workbook_get_spill(handle, pointer, len) -> result_pointer
superexcel_workbook_stats(handle) -> result_pointer
superexcel_workbook_destroy(handle) -> 0 | 1
```

## IR de fórmulas versão 2

Entrada:

```json
{"formula":"=SOMASES(C1:C3;A1:A3;"Pago";B1:B3;">10")"}
```

Saída simplificada:

```json
{
  "status": "ok",
  "ir_version": 2,
  "dependencies": [],
  "range_dependencies": [
    {"top": 0, "bottom": 2, "left": 0, "right": 0},
    {"top": 0, "bottom": 2, "left": 1, "right": 1},
    {"top": 0, "bottom": 2, "left": 2, "right": 2}
  ],
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

Ao consultar uma fórmula, o núcleo reutiliza o cache quando válido, resolve apenas as dependências necessárias, detecta ciclos e invalida somente a célula alterada e seus dependentes transitivos. Para ranges grandes, `SOMA`, `MÉDIA`, `MÍNIMO`, `MÁXIMO` e `CONT.NÚM` visitam somente células ocupadas. Funções condicionais e buscas preservam índices implícitos em branco por streaming, sem alocar uma matriz com 100.000 elementos.

## Integração com o runtime JavaScript

O navegador cria um workbook Rust a partir da matriz atual e espelha alterações feitas por `setCellContents`. Alterações agrupadas por `suspendEvaluation` e `resumeEvaluation` são enviadas em lote.

Após `undo` ou `redo`, o espelho Rust é reconstruído a partir do estado serializado pelo runtime JavaScript. O handle também é destruído quando o runtime é encerrado ou o modo Wasm volta para `off`.

Para matrizes locais, o workbook pode retornar o array completo e gerar um plano de spill. O plano informa área, dimensões e bloqueadores, mas não escreve os valores derivados nas células-alvo. Essa aplicação continua no runtime JavaScript.

## Limites atuais

Ainda permanecem no runtime JavaScript:

- demais matrizes dinâmicas e operações acima dos limites experimentais;
- referências externas a Bases e Planilhas;
- aplicação autoritativa do spill e registro dos alvos pelo Rust;
- undo/redo e transações como fonte oficial do histórico;
- persistência, snapshots e colaboração;
- resultado autoritativo de matrizes no modo `prefer`.

Quando uma fórmula não é suportada, o núcleo retorna `unsupported`; o navegador preserva o resultado JavaScript.

## Limites de segurança

- até 4 MB por payload ABI;
- até 4.096 posições por intervalo no avaliador stateless;
- até 100.000 posições por intervalo no workbook stateful;
- até 100.000 células armazenadas por workbook experimental;
- até 10.000 alterações por lote;
- até 10.000 células por matriz dinâmica ou plano de spill.

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
