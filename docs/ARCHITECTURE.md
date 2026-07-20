# Arquitetura do Excel Empresarial

Este documento separa três conceitos:

1. **arquitetura atual**: o que está implementado no repositório;
2. **arquitetura de transição**: refatorações ainda necessárias sem alterar contratos públicos;
3. **arquitetura-alvo**: direção que orienta substituições futuras.

O retrato operacional detalhado está em `docs/CURRENT_STATUS.md`. As metas mensuráveis estão em `BENCHMARK.md`.

## Visão do produto

O Excel Empresarial é um runtime empresarial flexível cuja interface principal pode ser uma grade, mas cuja lógica combina:

- dados relacionais;
- planilhas esparsas;
- cadeias de transformação;
- grafos de dependência;
- colaboração;
- permissões;
- automações;
- publicação de dados e interfaces.

O produto deve preservar a liberdade de uma planilha sem transformar a regra de negócio em uma estrutura rígida de ERP.

## Arquitetura atual

```text
Navegador
├── autenticação Google / Supabase
├── gerenciador de projetos e arquivos
├── grade relacional de Bases
├── grade esparsa de Planilhas
├── motor de fórmulas JavaScript
├── colaboração otimista e snapshots
├── Elementar / JSON ao vivo
├── Test Time e telemetria
└── administração de roles e integrações
          │
          ▼
Flask / Gunicorn
├── projetos, arquivos e workbooks
├── Bases e Base 2
├── referências Base -> Planilha
├── materialização Planilha -> Base 2
├── publicação Base 2 -> Elementar
├── colaboração, recuperação e snapshots
├── capacidades e roles
├── conector GitHub e hospedagem HTML
└── telemetria e Test Time
          │
          ▼
Supabase
├── PostgreSQL / PostgREST
├── Auth Google
├── RLS
├── RPCs de colaboração e materialização
├── logs de operações e revisões
├── tabelas relacionais de Bases
├── publicações Elementar
└── tabelas de integração e observabilidade
```

### Backend atual

O backend continua modularizado principalmente em arquivos Python na raiz:

```text
app.py
backend.py
projects_routes.py
files_routes.py
workbook_routes.py
base_routes.py
base_reference_routes.py
treated_base_routes.py
treated_base_formula_routes.py
elementar_routes.py
elementar_automation_routes.py
collaboration_routes.py
snapshot_routes.py
telemetry_routes.py
test_time_routes.py
roles_routes.py
github_connector.py
github_oauth.py
github_sites.py
```

O pacote `superexcel/` contém contratos independentes para pipeline, permissões e payloads, mas a migração dos módulos de aplicação para uma estrutura completa de camadas ainda não foi concluída.

### Frontend atual

A Planilha possui um único caminho de inicialização em produção:

```text
templates/index.html
        │
        ▼
static/js/sheet-bootstrap-v2.js
        │
        ├── grid/sparse-store.js
        ├── grid/viewport.js
        ├── collab-operation.js
        ├── collab-operation-store.js
        ▼
static/js/app-v3.js
        │
        ├── sheet-capabilities.js
        └── sheet-collaboration-v3.js
```

Os arquivos `app.js`, `app-v2.js`, `app-loader.js` e `sheet-bootstrap.js` foram removidos. O CI valida que eles não sejam reintroduzidos nem referenciados.

Outros módulos do frontend permanecem separados por responsabilidade:

```text
static/js/
├── grid/                         # armazenamento esparso, viewport e interação
├── calculation/                  # parser, grafo, funções e runtime
├── collab-operation*.js          # contrato e fila de operações
├── sheet-collaboration-v3.js     # sincronização da Planilha
├── snapshot-*.js                 # primeira pintura e recuperação
├── base-grid.js                  # grade relacional
├── base-reference-*.js           # Base dentro da Planilha
├── treated-base-*.js             # materialização e fórmulas da Base 2
├── elementar-*.js                # publicação e prévia JSON
├── test-time.js                  # rastreamento entre etapas
└── performance-telemetry.js      # métricas do navegador
```

## Pipeline arquitetural atual

```text
Base de entrada -> Planilha de cálculo -> Base 2 tratada -> Elementar
```

### Base de entrada

- armazenamento relacional em `base_columns` e `base_rows`;
- colunas tipadas;
- registros paginados;
- valores iniciados por `=` armazenados literalmente;
- nenhum runtime de fórmulas.

### Planilha de cálculo

- payload versão 2 esparso;
- motor de fórmulas JavaScript próprio;
- parser, AST, grafo, cache e recálculo seletivo;
- referências a Bases;
- colaboração por operações;
- snapshots para renderização e recuperação.

### Base 2 tratada

- armazenamento relacional;
- edição manual permitida;
- materialização opcional de intervalo de uma Planilha;
- fórmulas próprias armazenadas separadamente do último valor calculado;
- resultado persistido para consumo downstream.

### Elementar

- consome somente Bases 2 do mesmo projeto;
- lê os intervalos necessários;
- publica JSON imutável e versionado;
- registra dependências;
- republica saídas afetadas após mutações nas Bases 2 configuradas.

## Princípios obrigatórios

1. A interface não deve aguardar o servidor para refletir uma alteração local válida.
2. A unidade de cálculo é o nó do grafo, não a planilha inteira.
3. A unidade de armazenamento deve ser o dado necessário, não uma matriz monolítica vazia.
4. Dados vazios não devem consumir memória proporcional ao tamanho lógico máximo.
5. A representação visual deve se limitar ao viewport e à margem necessária.
6. Resultados válidos devem ser reutilizados.
7. Invalidação e recálculo devem ser seletivos.
8. Roles devem ser conjuntos configuráveis de capacidades.
9. Telemetria de cálculo, renderização, colaboração e memória faz parte do núcleo.
10. O motor de cálculo é propriedade do projeto e não depende de engines de planilha de terceiros.
11. Migrações devem manter compatibilidade até a substituição comprovada da camada antiga.
12. A documentação deve diferenciar recurso implementado, recurso parcial e arquitetura-alvo.
13. Um único caminho de bootstrap deve ser autoritativo em produção.

## Camadas atuais

### Modelo lógico

Implementado parcialmente em `superexcel/core/` e no runtime JavaScript. Representa identidades dos quatro tipos de arquivo, transições permitidas, payloads esparsos, capacidades, roles, células, intervalos e dependências.

### Runtime incremental

```text
fórmula
  ↓
parser
  ↓
AST
  ↓
grafo de dependências locais e externas
  ↓
invalidação seletiva
  ↓
avaliação sob demanda
  ↓
cache de resultado
```

Referências individuais são indexadas diretamente. Intervalos são registrados sem criar uma aresta independente para cada célula. O runtime invalida apenas as fórmulas relacionadas quando uma origem muda.

### Armazenamento

Planilhas usam payload esparso:

```json
{
  "version": 2,
  "storage": "sparse",
  "rows": 60,
  "cols": 26,
  "cells": [
    {"r": 0, "c": 0, "v": 1},
    {"r": 0, "c": 1, "v": "=A1*2"}
  ]
}
```

O backend ainda aceita payloads densos antigos e os converte para o formato esparso. Bases e Base 2 usam `workbooks`, `base_columns` e `base_rows`, sem matriz vazia de células.

### Colaboração

Implementado:

- aplicação otimista local;
- fila de operações;
- UUID e sequência por cliente;
- revisão conhecida;
- aplicação autoritativa por RPC;
- log ordenado de revisões;
- delta incremental;
- fallback por snapshot;
- tópico de tempo real;
- reconciliação no frontend.

### Permissões

Implementado:

- roles padrão e personalizadas;
- catálogo de capacidades;
- proteção de rotas mapeadas por capacidade;
- fallback temporário para hierarquia de role em rotas ainda não mapeadas.

### Publicação e integrações

Implementado:

- Elementar privado e público;
- versões imutáveis e ETag;
- dependências por intervalo;
- atualização automática a partir de Base 2;
- GitHub App para sincronizar HTMLs;
- hospedagem em prévia isolada ou subdomínio wildcard.

### Telemetria e Test Time

Implementado:

- métricas de payload e memória estimada;
- tempos de cálculo e renderização;
- métricas de colaboração;
- coleta adiada para reduzir interferência no carregamento;
- sessões Test Time compartilhadas;
- grupos de intervalos nas quatro etapas;
- linha do tempo de eventos.

## Motor de cálculo próprio

A decisão arquitetural de `docs/ADR-001-CUSTOM-CALCULATION-ENGINE.md` está implementada: HyperFormula não é dependência de produção.

O runtime JavaScript atual fornece parser independente da grade, AST, referências A1 e intervalos, dependências locais e externas, detecção de ciclos, cache, invalidação seletiva, funções dinâmicas, alterações em lote, desfazer/refazer e métricas.

## Rust/WebAssembly: situação real

O crate `wasm-engine/` é compilado pela CI e contém um núcleo experimental stateful:

- ABI versão 7 e IR de fórmulas versão 2;
- parser e AST em Rust;
- compilação local para IR JSON compacta, separando células e retângulos, com testes diferenciais contra o parser JavaScript;
- avaliação de fórmulas locais básicas, condicionais, de busca e matrizes dinâmicas `FILTRO`, `ÚNICO` e `CLASSIFICAR`;
- critérios numéricos, operadores e curingas;
- workbooks identificados por handles;
- grafo reverso de referências diretas e índice de intervalos em buckets 256×32;
- índice ordenado de células ocupadas e avaliador esparso para ranges grandes;
- agregações sobre células ocupadas e streaming posicional para critérios/buscas;
- cache de resultados, detecção de ciclos e invalidação transitiva;
- plano de spill verificável com área, dimensões, matriz e bloqueadores, sem assumir a aplicação na grade;
- alterações em lote, revisão, lista de afetados e métricas;
- integração `off`, `shadow` e `prefer` com fallback JavaScript.

O grafo Rust não expande intervalos em arestas por célula; ele seleciona candidatos por bucket e confirma a sobreposição exata. O avaliador stateful também evita buffers densos em ranges grandes: agregações simples visitam somente células ocupadas, enquanto critérios e buscas percorrem posições implicitamente. A IR não cobre referências externas. O núcleo já calcula a primeira fatia de matrizes dinâmicas e detecta conflitos de spill, mas o JavaScript ainda aplica o spill na grade e permanece autoritativo para histórico, persistência e colaboração. JavaScript permanece como referência geral e fallback.

## Matriz de maturidade

| Área | Estado atual |
|---|---|
| Autenticação Google | Implementado |
| Projetos, pastas e membros | Implementado |
| Roles personalizadas/capacidades | Implementado parcialmente; fallback por nível ainda existe |
| Base relacional | Implementado |
| Planilha esparsa | Implementado |
| Bootstrap único da Planilha | Implementado |
| Motor próprio JavaScript | Implementado |
| Referências Base -> Planilha | Implementado |
| Materialização Planilha -> Base 2 | Implementado e opcional |
| Fórmulas na Base 2 | Implementado |
| Elementar Base 2 -> JSON | Implementado |
| Republicação automática | Implementado para dependências configuradas |
| Colaboração por operações | Implementado |
| Telemetria e Test Time | Implementado |
| GitHub App e hospedagem HTML | Implementado |
| Workbook Rust/Wasm stateful, IR v2, ranges esparsos e plano de spill | Implementado parcialmente; matrizes dinâmicas iniciais existem, mas o modo padrão ainda é `off` |
| Motor completo Rust/Wasm | Não implementado |
| Importação XLSX/XLSM | Não implementado |
| Aplicação desktop/Tauri | Não implementado |
| Estrutura final em camadas | Em migração |
| Metas finais comprovadas em produção | Não comprovadas no repositório |

## Arquitetura-alvo

```text
superexcel/
├── api/                    # Rotas HTTP e contratos externos
├── application/            # Casos de uso e orquestração
├── collaboration/          # Operações, revisões, presença e conflitos
├── core/
│   ├── graph/              # Grafo de dependências e invalidação
│   ├── calculation/        # Plano e runtime de cálculo
│   ├── storage/            # Chunks, dados esparsos e cache
│   ├── workbook/           # Modelo lógico dos arquivos
│   └── permissions/        # Capacidades, roles e políticas
├── infrastructure/         # Supabase, filas, storage e adaptadores
├── telemetry/              # Métricas e comparação de desempenho
└── web/                    # Integração com o frontend

static/js/
├── app/                    # Inicialização e shell
├── grid/                   # Renderização e virtualização
├── calculation/            # Runtime JavaScript e eventual ponte experimental
├── collaboration/          # Cliente otimista e outbox
└── telemetry/              # Métricas do navegador
```

Uma camada antiga só permanece quando ainda possui consumidor ativo ou contrato de compatibilidade comprovado.

## Próximas fronteiras arquiteturais

### 1. Modularizar `app-v3.js`

- separar comandos, seleção, edição, persistência e integração com a grade;
- manter `sheet-bootstrap-v2.js` como única entrada pública;
- preservar os contratos `window.SuperExcelApp` usados por colaboração e painéis;
- remover módulos somente depois de comprovar ausência de consumidores.

### 2. Consolidar o backend em camadas

- mover regras de negócio das rotas para casos de uso;
- reduzir monkeypatches de instalação;
- centralizar validação de capacidades;
- separar contratos de domínio dos adaptadores Supabase.

### 3. Ampliar a representação intermediária

- a IR versão 2 cobre fórmulas locais e ranges compactos e possui testes diferenciais entre JavaScript e Rust;
- adicionar referências externas, tipos especializados e metadados de origem;
- aproximar o catálogo de aliases de uma única fonte de verdade;
- manter a semântica do runtime JavaScript como referência autoritativa até a paridade comprovada.

### 4. Expandir Rust/Wasm com evidência

A base stateful, a IR v2, as funções empresariais, a avaliação esparsa e as matrizes dinâmicas iniciais já existem. A próxima ampliação exige tornar spill e seus alvos autoritativos, adicionar referências externas, benchmarks comparativos, feature flag e rollback para o runtime JavaScript.

### 5. Demonstrar desempenho

- publicar resultados reproduzíveis dos benchmarks;
- incluir commit, ambiente, média, p50, p95 e p99;
- medir abertura, cálculo, renderização, RAM e colaboração;
- distinguir benchmark sintético de carga real em produção.

## Regra de substituição

Uma camada nova só substitui a antiga quando:

1. possui testes automatizados;
2. mantém compatibilidade de dados e fórmulas;
3. alcança ou supera as metas aplicáveis de `BENCHMARK.md`;
4. possui rollback claro;
5. não piora colaboração, segurança ou consumo de memória;
6. tem telemetria suficiente para detectar regressão;
7. sua documentação descreve o comportamento real, e não apenas o objetivo.
