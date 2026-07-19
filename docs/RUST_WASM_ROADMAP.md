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

Estado: **implementado nesta entrega**.

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

## Fase 3 — representação intermediária compartilhada

Estado: **planejado**.

- definir IR compacta e versionada;
- serializar AST JavaScript para comparação durante a migração;
- eliminar diferenças de coerção e localização;
- catálogo único de funções e aliases;
- suíte extensa de paridade por fórmula;
- reduzir parsing duplicado entre JavaScript e Rust.

Critério de saída: parser Rust e JavaScript produzem árvores semanticamente equivalentes e o catálogo possui uma única fonte de verdade.

## Fase 4 — grafo de intervalos e funções empresariais

Estado: **planejado**.

- buckets bidimensionais para intervalos grandes;
- dependências de intervalo sem expansão célula por célula;
- `SOMASE`, `SOMASES`, `CONT.SE`, `CONT.SES`, `MÉDIASE` e `MÉDIASES`;
- `PROCV`, `PROCX`, `ÍNDICE` e `CORRESP`;
- critérios, curingas e coerção compatível com o runtime atual;
- benchmarks específicos de cadeias empresariais.

Critério de saída: fórmulas empresariais comuns operam no workbook Rust sem fallback frequente e sem explosão de arestas em intervalos grandes.

## Fase 5 — matrizes, spill e referências externas

Estado: **planejado**.

- `FILTRO`, `ÚNICO` e `CLASSIFICAR`;
- broadcasting completo;
- spill e conflitos de área;
- referências externas a Bases e Planilhas;
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
