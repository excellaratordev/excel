# Roadmap Rust/Wasm do Super Excel

## Objetivo

Substituir progressivamente o núcleo de cálculo JavaScript por Rust/WebAssembly sem reescrever a grade, colaboração, persistência ou contratos públicos de edição.

## Fase 1 — avaliador funcional híbrido

Estado: **implementado nesta entrega**.

- ABI JSON versão 2;
- parser e AST em Rust;
- números, textos, booleanos, referências e intervalos locais;
- operadores e funções básicas;
- módulo Wasm versionado como asset estático;
- integração `off`, `shadow` e `prefer`;
- fallback automático para o runtime JavaScript;
- testes Rust e integração Node/Wasm.

Critério de saída: fórmulas suportadas produzem o mesmo resultado do JavaScript em modo `shadow`.

## Fase 2 — representação intermediária compartilhada

- definir IR compacta e versionada;
- serializar AST JavaScript para comparação durante a migração;
- eliminar diferenças de coerção e localização;
- catálogo único de funções e aliases;
- suíte de paridade por fórmula.

Critério de saída: parser Rust e JavaScript produzem árvores semanticamente equivalentes.

## Fase 3 — grafo e invalidação em Rust

- nós de célula e intervalo;
- buckets bidimensionais para intervalos;
- detecção de ciclos;
- coleta seletiva de afetados;
- cache de resultados e métricas;
- API para alterações em lote.

Critério de saída: Rust controla dependências e recálculo, mantendo valores compatíveis com o runtime atual.

## Fase 4 — funções empresariais e matrizes

- `SOMASES`, `CONT.SES`, `MÉDIASES`;
- `PROCV`, `PROCX`, `ÍNDICE`, `CORRESP`;
- `FILTRO`, `ÚNICO`, `CLASSIFICAR`;
- broadcasting completo;
- spill e conflitos de área;
- referências externas e valores tipados.

Critério de saída: cobertura funcional suficiente para operar planilhas reais sem fallback frequente.

## Fase 5 — runtime autoritativo

- modo `prefer` como padrão;
- JavaScript reduzido a adaptador de UI;
- persistência de snapshots compactos;
- undo/redo e transações no núcleo;
- telemetria comparativa de RAM e latência;
- rollback explícito para a versão JavaScript.

Critério de saída: metas de `BENCHMARK.md` atingidas e ausência de divergências conhecidas.

## Regras de segurança

1. Nenhuma função migra sem testes de paridade.
2. Resultado divergente usa JavaScript e registra métrica.
3. Recursos não suportados retornam `unsupported`, nunca um resultado inventado.
4. O asset Wasm deve corresponder exatamente ao código Rust do commit.
5. A ABI só muda com incremento de versão e adaptação simultânea do navegador.
