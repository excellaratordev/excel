# ADR-001 — Motor de cálculo próprio

- **Status:** aceito
- **Data:** 2026-07-16
- **Escopo:** cálculo de fórmulas, dependências, cache e recálculo

## Contexto

O objetivo do Excel Empresarial exige desempenho superior em planilhas online, uso seletivo de RAM, execução por cadeias e evolução futura para Rust/WebAssembly.

Um motor externo de planilhas imporia limites sobre:

- representação interna das células;
- estrutura do grafo de dependências;
- controle de cache e invalidação;
- execução sob demanda;
- integração com chunks esparsos;
- telemetria detalhada;
- execução distribuída;
- compatibilidade binária com Rust/Wasm;
- licenciamento e evolução do produto.

## Decisão

O projeto utilizará exclusivamente um motor de cálculo próprio.

HyperFormula deixa de ser dependência de produção e não terá fallback dentro da aplicação.

O contrato do motor será controlado pelo projeto e deverá suportar:

1. parser de fórmulas;
2. AST estável;
3. referências A1 e intervalos;
4. grafo incremental;
5. dependências de intervalos indexadas sem expansão célula por célula;
6. invalidação transitiva seletiva;
7. avaliação sob demanda;
8. cache de resultados;
9. detecção de ciclos;
10. funções dinâmicas e saída derramada;
11. alterações em lote;
12. desfazer e refazer;
13. métricas de desempenho e memória;
14. futura implementação equivalente em Rust/Wasm.

## Implementação de referência

A primeira implementação fica em:

```text
static/js/calculation/
├── formula-parser.js
├── dependency-graph.js
├── function-library.js
├── formula-runtime.js
└── runtime-bridge.js
```

Essa implementação JavaScript serve para validar semântica e contratos. Ela não é um compromisso de manter o núcleo final em JavaScript.

## Evolução para Rust/Wasm

A migração futura deve preservar a API pública usada pela interface:

```text
create
getCellValue
getCellValueDetailedType
setCellContents
suspendEvaluation
resumeEvaluation
consumeAffectedCells
getSheetSerialized
undo
redo
getStats
destroy
```

A interface, colaboração e persistência não devem conhecer detalhes internos da implementação.

## Consequências positivas

- controle total de performance e RAM;
- recálculo realmente seletivo;
- grafo otimizado para cadeias empresariais;
- ausência de dependência crítica de terceiros;
- liberdade para armazenamento esparso;
- telemetria interna completa;
- caminho direto para Rust/Wasm.

## Custos assumidos

- responsabilidade integral pela compatibilidade das fórmulas;
- necessidade de testes extensivos;
- implementação gradual de funções;
- manutenção própria do parser e do runtime;
- comparação contínua com Excel Online e Google Sheets.

## Regra de governança

Uma biblioteca externa pode ser usada somente em ferramentas de teste ou benchmark isolado. Ela não pode:

- executar fórmulas em produção;
- manter o grafo autoritativo;
- definir o formato dos dados;
- ser necessária para abrir ou editar uma planilha.
