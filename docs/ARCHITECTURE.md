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
10. Toda migração deve manter compatibilidade até a substituição completa da camada antiga.

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
├── calculation/            # Adaptador do motor de cálculo
├── collaboration/          # Cliente otimista e outbox
├── telemetry/              # Coleta de RAM e latência
└── legacy/                 # Código mantido durante a migração
```

A estrutura será adotada progressivamente. Arquivos antigos permanecem funcionando até seus substitutos terem testes e métricas equivalentes ou superiores.

## Camadas

### 1. Modelo lógico

Representa documentos, planilhas, células, intervalos, tabelas e recursos sem depender de Flask, Supabase, DOM ou HyperFormula.

### 2. Runtime incremental

Recebe uma saída solicitada, expande somente o subgrafo necessário, consulta caches, carrega os blocos ausentes e recalcula apenas nós inválidos.

### 3. Armazenamento

Deve aceitar payloads legados densos e o modelo novo esparso. A transição será feita por adaptadores e versionamento de schema.

### 4. Colaboração

Mantém a aplicação otimista atual, separando:

- canal rápido não autoritativo;
- fila local persistente;
- confirmação autoritativa;
- log ordenado de operações;
- checkpoints e recuperação por delta;
- conflitos de valores e operações estruturais.

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
- cache e chunks ativos;
- tempo de cálculo e renderização;
- atraso de colaboração;
- operações pendentes;
- snapshots completos e recuperações por delta.

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

### Grade

- armazenamento esparso no cliente;
- viewport virtualizada;
- eliminação do DOM por célula possível;
- renderização apenas de resultados alterados.

### Cálculo

- interface abstrata para motores;
- benchmark automatizado do HyperFormula atual;
- runtime incremental próprio em Rust/Wasm;
- migração gradual de fórmulas.

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
