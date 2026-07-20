# Roadmap Rust/Wasm do Super Excel

## Objetivo

Substituir progressivamente o núcleo de cálculo JavaScript por Rust/WebAssembly sem reescrever a grade, colaboração, persistência ou contratos públicos de edição.

## Fase 1 — avaliador funcional híbrido

Estado: **implementado**.

- ABI JSON versão 2;
- parser e AST em Rust;
- números, textos, booleanos, referências e intervalos locais;
- operadores e funções básicas;
- módulo Wasm versionado como asset estático;
- integração `off`, `shadow` e `prefer`;
- fallback automático para o runtime JavaScript;
- testes Rust e integração Node/Wasm.

Critério de saída atingido: fórmulas suportadas são executadas pelo binário Wasm e comparáveis ao JavaScript em modo `shadow`.

## Fase 2 — workbook stateful, grafo e cache

Estado: **implementado**.

- ABI versão 3;
- workbooks identificados por handles;
- valores e fórmulas locais armazenados em Rust;
- grafo reverso de dependências por célula;
- detecção de ciclos;
- cache de resultados;
- invalidação transitiva seletiva;
- alterações em lote;
- revisão e lista ordenada de células afetadas;
- métricas de cache, recálculo, atualizações e arestas;
- espelhamento das edições do runtime JavaScript;
- reconstrução segura após undo/redo;
- destruição explícita do workbook e liberação do estado.

Critério de saída atingido: alterar `A1` em uma cadeia `A1 -> B1 -> C1` invalida apenas `A1`, `B1` e `C1`, preservando fórmulas independentes no cache.

## Fase 3 — IR compartilhada e funções empresariais

Estado: **implementado nesta entrega**.

- ABI versão 4;
- IR JSON versão 1 para fórmulas locais;
- compilação da mesma fórmula pelo parser JavaScript e pelo parser Rust;
- suíte diferencial para estrutura, aliases e dependências;
- `CONT.SE`, `CONT.SES`, `SOMASE`, `SOMASES`, `MÉDIASE` e `MÉDIASES`;
- critérios numéricos, operadores de comparação e curingas `*`/`?`;
- `PROCV`, `PROCX`, `ÍNDICE` e `CORRESP`;
- uso das novas funções pelo workbook stateful e seu cache incremental;
- retorno `unsupported` preservado para funções ainda não migradas.

Critério de saída atingido: fórmulas locais representativas geram IR semanticamente equivalente em JavaScript e Rust, e funções empresariais comuns executam pelo binário Wasm e pelo workbook stateful.

## Fase 4 — grafo de intervalos grandes

Estado: **planejado**.

- buckets bidimensionais para intervalos grandes;
- dependências de intervalo sem expansão célula por célula;
- invalidação por sobreposição de retângulos;
- operações em lote com buffers compactos;
- benchmarks específicos de cadeias e agregações empresariais.

Critério de saída: fórmulas com grandes intervalos não geram explosão de arestas e mantêm recálculo seletivo mensurável.

## Fase 5 — matrizes, spill e referências externas

Estado: **planejado**.

- `FILTRO`, `ÚNICO` e `CLASSIFICAR`;
- broadcasting completo;
- spill e conflitos de área;
- referências externas a Bases e Planilhas;
- IR com origem externa, revisão e tipos especializados;
- valores tipados e buffers compactos;
- invalidação seletiva de fontes externas por revisão.

Critério de saída: matrizes e referências externas produzem os mesmos resultados, tipos e áreas afetadas do runtime JavaScript.

## Fase 6 — runtime autoritativo

Estado: **futuro**.

- modo `prefer` como padrão;
- JavaScript reduzido a adaptador de UI e fallback emergencial;
- persistência de snapshots compactos;
- undo/redo e transações no núcleo;
- integração direta com colaboração;
- telemetria comparativa de RAM e latência;
- rollback explícito para a versão JavaScript.

Critério de saída: metas de `BENCHMARK.md` atingidas, cobertura funcional suficiente e ausência de divergências conhecidas em produção controlada.

## Regras de segurança

1. Nenhuma função migra sem testes de paridade.
2. Resultado divergente usa JavaScript e registra métrica.
3. Recursos não suportados retornam `unsupported`, nunca um resultado inventado.
4. O asset Wasm deve corresponder exatamente ao código Rust do commit.
5. A ABI só muda com incremento de versão e adaptação simultânea do navegador.
6. O modo padrão permanece `off` até haver evidência de paridade e ganho mensurável.
7. Matrizes não se tornam autoritativas enquanto spill e conflitos não estiverem implementados no núcleo.
8. A IR só se torna contrato de produção após cobrir referências externas e tipos especializados.
