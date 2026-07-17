# Arquitetura Final do Excel Empresarial

Este documento define a arquitetura-alvo do produto e as fronteiras que devem orientar todas as mudanças estruturais.

## Visão do produto

O Excel Empresarial não é apenas uma planilha. Ele é um runtime empresarial flexível cuja interface principal pode ser uma grade, mas cuja lógica interna é formada por dados esparsos, cadeias de transformação, grafos de dependência, automações, permissões e visualizações.

O produto deve preservar a liberdade de uma planilha e evitar estruturas rígidas de ERP.

## Princípios obrigatórios

1. A interface nunca aguarda o servidor para refletir uma alteração local.
2. A unidade de cálculo é o nó do grafo, não a planilha inteira.
3. A unidade de armazenamento é o bloco ou registro necessário, não um arquivo monolítico.
4. Dados vazios não devem ocupar memória proporcional ao tamanho máximo da grade.
5. Apenas células visíveis devem possuir representação visual ativa.
6. Resultados válidos devem ser reutilizados.
7. Invalidação e recálculo devem ser seletivos.
8. Roles são conjuntos configuráveis de capacidades.
9. Telemetria de cálculo, renderização, colaboração e memória faz parte do núcleo.
10. O motor de cálculo é propriedade do projeto e não depende de engines de planilha de terceiros.
11. Toda migração deve manter compatibilidade até a substituição completa da camada antiga.

## Estrutura-alvo do repositório

```text
superexcel/
├── api/                    # Rotas HTTP e contratos externos
├── application/            # Casos de uso e orquestração
├── collaboration/          # Operações, revisões, presença e conflitos
├── core/
│   ├── graph/              # Grafo de dependências e invalidação
│   ├── calculation/        # Plano e runtime de cálculo
│   ├── storage/            # Chunks, dados esparsos e cache
│   ├── workbook/           # Modelo lógico de documento/planilha
│   └── permissions/        # Capacidades, roles e políticas
├── infrastructure/         # Supabase, filas, storage e adaptadores
├── telemetry/              # Métricas e comparação de desempenho
└── web/                    # Integração com o frontend atual

static/js/
├── app/                    # Inicialização e shell
├── grid/                   # Renderização e virtualização
├── calculation/
│   ├── formula-parser.js   # Tokenização, parser e AST
│   ├── dependency-graph.js # Índice de dependências exatas e por chunks
│   ├── function-library.js # Biblioteca de funções internas
│   └── formula-runtime.js  # Avaliação incremental, cache e histórico
├── collaboration/          # Cliente otimista e outbox
├── telemetry/              # Coleta de RAM e latência
└── legacy/                 # Código mantido durante a migração
```

A estrutura será adotada progressivamente. Arquivos antigos permanecem funcionando até seus substitutos terem testes e métricas equivalentes ou superiores.

## Camadas

### 1. Modelo lógico

Representa documentos, planilhas, células, intervalos, tabelas e recursos sem depender de Flask, Supabase, DOM ou bibliotecas externas de planilha.

### 2. Runtime incremental

Recebe uma saída solicitada, expande somente o subgrafo necessário, consulta caches, carrega os blocos ausentes e recalcula apenas nós inválidos.

A execução segue:

```text
fórmula
  ↓
parser
  ↓
AST
  ↓
grafo de dependências
  ↓
invalidação seletiva
  ↓
avaliação sob demanda
  ↓
cache de resultado
```

Referências individuais são indexadas diretamente. Intervalos são registrados em buckets bidimensionais para que `A1:A5000` seja uma única relação lógica, e não cinco mil arestas independentes.

### 3. Armazenamento

Deve aceitar payloads legados densos e o modelo novo esparso. A transição será feita por adaptadores e versionamento de schema.

O runtime de cálculo já mantém apenas células preenchidas em seu armazenamento interno. A grade atual ainda será migrada para o mesmo modelo.

### 4. Colaboração

Mantém a aplicação otimista atual, separando:

- canal rápido não autoritativo;
- fila local persistente;
- confirmação autoritativa;
- log ordenado de operações;
- checkpoints e recuperação por delta;
- conflitos de valores e operações estruturais.

O motor de cálculo é local e determinístico. Alterações remotas entram como operações de célula e invalidam somente as cadeias relacionadas.

### 5. Permissões

Toda ação é protegida por uma capacidade, por exemplo:

- `workbook.view`
- `workbook.edit`
- `workbook.delete`
- `cell.edit`
- `formula.edit`
- `structure.edit`
- `data.import`
- `data.export`
- `members.manage`
- `roles.manage`

As roles padrão continuam existindo, mas passam a ser presets de capacidades.

### 6. Telemetria

Cada planilha deve publicar métricas de:

- heap do navegador, quando disponível;
- células DOM;
- células carregadas e preenchidas;
- fórmulas e dependências;
- arestas exatas e intervalos indexados;
- cache e chunks ativos;
- taxa de acerto do cache;
- tempo de cálculo e renderização;
- atraso de colaboração;
- operações pendentes;
- snapshots completos e recuperações por delta.

## Motor de cálculo próprio

O motor interno deve cumprir os seguintes contratos:

- parser independente da interface;
- AST estável e testável;
- biblioteca de funções desacoplada;
- grafo com dependências por célula e intervalo;
- detecção de ciclos;
- cálculo sob demanda;
- cache reutilizável;
- invalidação transitiva seletiva;
- funções dinâmicas com saída derramada;
- transações para alterações em lote;
- desfazer e refazer;
- métricas internas;
- API compatível com futura implementação Rust/Wasm.

A versão JavaScript é a implementação de referência e permite validar semântica, testes e contratos. O núcleo de alta performance poderá ser substituído por Rust/Wasm mantendo a mesma API pública.

## Modelo de dados futuro

O formato legado continua aceito:

```json
{"version": 1, "rows": 60, "cols": 26, "cells": [[1, 2, 3]]}
```

O formato esparso será introduzido por versão:

```json
{
  "version": 2,
  "storage": "sparse",
  "rows": 1000000,
  "cols": 10000,
  "cells": [
    {"r": 0, "c": 0, "v": 1},
    {"r": 0, "c": 1, "v": "=A1*2"}
  ]
}
```

O tamanho lógico da grade não implica alocação de todas as posições.

## Sequência de migração

### Fundação

- arquitetura documentada;
- pacote `superexcel` independente;
- capacidades e roles padrão;
- telemetria por planilha;
- adaptadores para payload compacto.

### Motor próprio

- remoção completa do HyperFormula;
- parser e AST internos;
- grafo incremental por célula e intervalo;
- biblioteca inicial de fórmulas empresariais;
- funções dinâmicas;
- cache, ciclos, undo e redo;
- testes automatizados de semântica.

### Grade

- armazenamento esparso no cliente;
- viewport virtualizada;
- eliminação do DOM por célula possível;
- renderização apenas de resultados alterados.

### Rust/Wasm

- contrato binário do runtime;
- implementação do parser e grafo em Rust;
- buffers compactos entre interface e Wasm;
- benchmarks comparativos com a implementação de referência;
- substituição do núcleo sem alterar colaboração e UI.

### Colaboração

- versão por célula/recurso;
- checkpoints por chunk;
- recuperação sem snapshot completo;
- operações estruturais transformáveis;
- testes de carga multiusuário.

### Aplicações e dados

- visualizações sobre a mesma base lógica;
- automações e endpoints reutilizando o grafo;
- workers Python isolados;
- publicação de aplicações empresariais.

## Regra de aprovação

Uma nova camada só substitui a antiga quando:

1. possui testes automatizados;
2. mantém compatibilidade de dados;
3. alcança ou supera as metas de `BENCHMARK.md`;
4. possui rollback claro;
5. não piora colaboração ou consumo de memória.
