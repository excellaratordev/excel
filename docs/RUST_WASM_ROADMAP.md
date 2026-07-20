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

Estado: **implementado**.

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

Estado: **implementado**.

- ABI versão 5 e IR versão 2;
- referências diretas separadas de retângulos de intervalo;
- buckets bidimensionais de 256 linhas por 32 colunas;
- dependências de intervalo sem uma aresta por célula;
- invalidação por sobreposição exata após seleção de candidatos por bucket;
- intervalos stateful de até 100.000 posições;
- métricas separadas de arestas diretas, intervalos e buckets;
- testes de recálculo transitivo, remoção de índices obsoletos e execução real do Wasm;
- o índice compacta o grafo; a materialização densa do cálculo foi eliminada posteriormente na Fase 5.

Critério de saída atingido: um intervalo de 100.000 posições usa um descritor de dependência e menos de 512 buckets, preservando recálculo seletivo.

## Fase 5 — avaliação esparsa de ranges

Estado: **implementado**.

- ABI versão 6, mantendo IR versão 2;
- índice ordenado das células ocupadas por coordenada;
- dispatch automático para o avaliador stateful esparso acima de 4.096 posições;
- `SOMA`, `MÉDIA`, `MÍNIMO`, `MÁXIMO` e `CONT.NÚM` visitando somente células ocupadas;
- funções condicionais e buscas preservando posições vazias por streaming;
- fallback explícito para operações matriciais grandes ainda não suportadas;
- métricas de ranges esparsos, células resolvidas, posições percorridas e materialização evitada.

Critério de saída atingido: `SOMA(A1:A100000)` com duas células ocupadas resolve apenas essas duas células e registra pelo menos 99.998 posições cuja materialização foi evitada; `SOMASES` mantém a semântica posicional sem criar matriz densa.

## Fase 6 — matrizes, spill e referências externas

Estado: **implementado parcialmente nesta entrega**.

Implementado:

- ABI versão 7, mantendo IR versão 2;
- `FILTRO`, `ÚNICO` e `CLASSIFICAR` com aliases em inglês;
- arrays tipados em avaliações stateless e stateful;
- limite experimental de 10.000 células por matriz dinâmica ou spill;
- export `superexcel_workbook_get_spill`;
- plano `ready`, `blocked` ou `scalar`;
- área, dimensões, matriz, valor da origem e lista de bloqueadores;
- `#DESPEJAR!` quando a área possui células ocupadas;
- métricas de planos e conflitos.

Ainda planejado:

- aplicação autoritativa do spill e registro dos alvos no workbook Rust;
- broadcasting completo para todas as operações;
- referências externas a Bases e Planilhas;
- IR com origem externa, revisão e tipos especializados;
- invalidação seletiva de fontes externas por revisão.

Critério parcial atingido: funções matriciais locais produzem arrays equivalentes ao JavaScript e o Rust identifica áreas de spill livres ou bloqueadas. O critério completo depende de spill autoritativo e referências externas.

## Fase 7 — runtime autoritativo

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
7. Matrizes não se tornam autoritativas enquanto o núcleo não aplicar o spill, registrar seus alvos e invalidá-los corretamente; o plano de conflito isolado não é suficiente.
8. A IR só se torna contrato de produção após cobrir referências externas e tipos especializados.
