# ADR-001 — Motor de cálculo próprio

- **Status:** aceito
- **Data:** 2026-07-16
- **Escopo:** cálculo de fórmulas, dependências, cache e recálculo

## Contexto

O objetivo do Excel Empresarial exige desempenho superior em planilhas online, uso seletivo de RAM, execução por cadeias e liberdade para avaliar futuramente tecnologias como Rust/WebAssembly.

Um motor externo de planilhas imporia limites sobre:

- representação interna das células;
- estrutura do grafo de dependências;
- controle de cache e invalidação;
- execução sob demanda;
- integração com chunks esparsos;
- telemetria detalhada;
- execução distribuída;
- evolução futura para outros runtimes;
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
14. possibilidade de uma implementação futura equivalente em Rust/Wasm, sem transformar essa hipótese em dependência atual.

## Implementação de referência e produção

A implementação atual fica em:

```text
static/js/calculation/
├── formula-parser.js
├── dependency-graph.js
├── function-library.js
├── formula-runtime.js
└── runtime-bridge.js
```

Essa implementação JavaScript valida semântica e contratos e também é o runtime de produção atual. Não existe hoje um segundo motor funcional em Rust.

## Status atual do Rust/Wasm

A frente Rust/Wasm está em estágio **embrionário e experimental**.

O diretório `wasm-engine/` contém somente:

- uma ABI experimental de versão `1`;
- funções de alocação e liberação de memória;
- validação superficial da presença de `id` e `kind` em um envelope UTF-8;
- tipos demonstrativos de célula e operação;
- testes básicos de compilação nativa e para `wasm32-unknown-unknown`.

O adaptador `static/js/wasm/engine-contract.js` apenas instancia o módulo, confere a ABI e chama a validação mínima. Ele não conecta o Wasm ao estado da planilha.

Ainda não existem em Rust/Wasm parser, AST, grafo, biblioteca de funções, recálculo, cache, ciclos, matrizes dinâmicas, integração com a grade ou benchmarks de paridade.

## Hipótese de evolução para Rust/Wasm

Uma migração futura deverá preservar a API pública usada pela interface:

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

A interface, colaboração e persistência não deverão conhecer detalhes internos da implementação.

Essa evolução não está aprovada como substituição automática. Ela só poderá avançar por etapas, com contratos versionados, testes compartilhados, benchmarks e fallback para o runtime JavaScript.

## Consequências positivas

- controle total de performance e RAM;
- recálculo realmente seletivo;
- grafo otimizado para cadeias empresariais;
- ausência de dependência crítica de terceiros;
- liberdade para armazenamento esparso;
- telemetria interna completa;
- liberdade para experimentar Rust/Wasm ou outros runtimes sem reescrever a interface.

## Custos assumidos

- responsabilidade integral pela compatibilidade das fórmulas;
- necessidade de testes extensivos;
- implementação gradual de funções;
- manutenção própria do parser e do runtime;
- comparação contínua com Excel Online e Google Sheets;
- risco de investir em Rust/Wasm antes de existir evidência de benefício real.

## Regra de governança

Uma biblioteca externa pode ser usada somente em ferramentas de teste ou benchmark isolado. Ela não pode:

- executar fórmulas em produção;
- manter o grafo autoritativo;
- definir o formato dos dados;
- ser necessária para abrir ou editar uma planilha.

Rust/Wasm também não pode substituir nenhuma parte autoritativa apenas por expectativa de performance. A substituição exige paridade funcional, ganho mensurável, compatibilidade, rollback e aprovação explícita.
