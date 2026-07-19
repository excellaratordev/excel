# Estado atual do Super Excel

> Atualizado em **19 de julho de 2026**. Este documento descreve o que existe no código atual. Metas futuras permanecem em `docs/ARCHITECTURE.md` e `BENCHMARK.md`.

## Resumo executivo

O Super Excel é hoje uma aplicação web multiusuário para organizar projetos empresariais em um pipeline de dados e regras de negócio. A aplicação combina:

- backend Flask;
- Supabase para banco relacional, autenticação Google, RLS e recursos de tempo real;
- frontend em HTML, CSS e JavaScript;
- motor de fórmulas próprio em JavaScript;
- payload esparso para Planilhas;
- Bases relacionais para entrada e saída tratada;
- publicação JSON por arquivos Elementar;
- conector GitHub para importar e hospedar templates HTML.

O núcleo funcional está operante, mas a arquitetura ainda está em transição. O motor de cálculo autoritativo continua em JavaScript; o módulo Rust/WebAssembly existente é um contrato inicial de ABI e validação de operações, não o motor completo de fórmulas.

## Pipeline implementado

```text
Base -> Planilha -> Base 2 -> Elementar
entrada   cálculo    tratado   publicação
```

A ordem de criação é validada no banco: um projeto precisa possuir a etapa anterior antes de criar a seguinte. Dependências novas só podem avançar uma etapa.

### 1. Base de entrada

Estado atual:

- armazenamento relacional em `base_columns` e `base_rows`;
- colunas tipadas: texto, número, booleano, data, data/hora e JSON;
- paginação de registros e grade própria para Bases;
- criação, edição e exclusão de colunas e registros;
- revisão otimista para detectar alterações concorrentes;
- valores iniciados por `=` são aceitos e armazenados literalmente, inclusive em colunas não textuais;
- não existe avaliação de fórmulas na Base de entrada.

A Base é fonte de dados. Uma sequência como `=SOMA(A1:A2)` pode ser armazenada como conteúdo, mas não é executada nessa etapa.

### 2. Planilha de cálculo

Estado atual:

- payload versão 2 com armazenamento esparso;
- novas Planilhas começam com dimensão lógica de 60 linhas por 26 colunas;
- parser próprio, AST, grafo de dependências, cache e invalidação seletiva;
- referências A1, intervalos, detecção de ciclos e matrizes derramadas;
- biblioteca própria de fórmulas em pt-BR, com aliases em inglês;
- motor lógico separado, com curto-circuito para funções condicionais;
- referências diretas e intervalos vindos de Bases, por exemplo:

```excel
='Clientes'!A1
=SOMA('Pedidos'!D2:D100)
```

- atualização das fórmulas dependentes quando a revisão de uma Base muda;
- desfazer/refazer, persistência, snapshots de renderização e colaboração por operações;
- primeira pintura usando snapshot local antes das consultas remotas;
- carregamento de painéis, referências externas e telemetria sob demanda.

O motor de fórmulas em produção é o runtime JavaScript localizado em `static/js/calculation/`.

### 3. Base 2 tratada

Estado atual:

- usa o mesmo armazenamento relacional da Base de entrada;
- permanece editável manualmente;
- pode receber colunas e registros criados pelo usuário;
- pode ser vinculada opcionalmente a um intervalo de uma Planilha da etapa 2;
- a vinculação materializa o intervalo em colunas e registros relacionais;
- valores calculados da Planilha são enviados por snapshot para que a Base 2 receba resultados, e não apenas o texto das fórmulas;
- fórmulas digitadas diretamente na Base 2 são armazenadas separadamente do último valor calculado;
- referências diretas a Planilhas são suportadas no formato `='Nome da Planilha'!A1`;
- o valor calculado persistido é o que segue para a Elementar.

A sincronização Planilha -> Base 2 é opcional. A Base 2 pode ser editada manualmente, mas uma nova materialização do vínculo exclui e recria todas as colunas e registros do destino; alterações manuais feitas nessa Base 2 podem ser sobrescritas na próxima sincronização.

### 4. Elementar

Estado atual:

- é criada exclusivamente como etapa 4 do pipeline;
- declara elementos usando referências a intervalos;
- consome somente Bases 2 tratadas do mesmo projeto;
- lê apenas os intervalos necessários nas Bases 2;
- transforma célula, linha, coluna ou tabela em JSON;
- gera prévia antes da publicação;
- publica versões imutáveis;
- valida a revisão da definição e das Bases 2 antes de publicar;
- oferece endpoint autenticado e endpoint público com token rotacionável;
- responde com `ETag`, versão e horário da publicação;
- registra dependências por intervalo;
- alterações em Bases 2 disparam atualização das Elementares afetadas quando a dependência já está configurada.

Limites atuais principais:

- até 100 declarações;
- até 20 Bases 2 de origem;
- até 100.000 células solicitadas;
- linhas de origem até 5.000 no processo atual;
- até 20 MB de dados de origem;
- até 2 MB no JSON publicado.

## Projetos, usuários e permissões

Implementado:

- login exclusivamente com Google por Supabase Auth;
- projetos e pastas;
- proprietário e membros por e-mail;
- roles padrão `viewer`, `editor`, `admin` e `owner`;
- roles personalizadas armazenadas por projeto;
- capacidades como `project.view`, `workbook.edit`, `cell.edit`, `members.manage` e `roles.manage`;
- verificação de capacidade no backend para as rotas mapeadas;
- interface para administração de roles e membros.

A migração de verificações baseadas apenas em hierarquia de role para capacidades ainda é progressiva: rotas sem capacidade explícita continuam usando o nível mínimo de role.

## Colaboração e recuperação

Implementado:

- edição local otimista;
- operações com UUID, cliente, sequência e revisão conhecida;
- aplicação autoritativa no banco por RPC;
- log de alterações por revisão;
- busca incremental de deltas;
- fallback para snapshot completo quando o delta não está íntegro ou excede o limite;
- tópico de tempo real por Planilha;
- fila local e reconciliação no frontend;
- snapshots de renderização para abertura rápida;
- prevenção de operações duplicadas por identificador.

Limites atuais relevantes:

- até 100 operações por lote HTTP;
- até 10.000 alterações de células por operação;
- rotas de colaboração aceitam coordenadas até 5.000 linhas por 300 colunas;
- busca incremental retorna no máximo 500 eventos antes do fallback para snapshot.

## Motor de cálculo

### Implementado

- motor próprio sem HyperFormula em produção;
- parser e AST próprios;
- dependências por célula e por intervalos indexados;
- invalidação transitiva seletiva;
- cache de resultados;
- fórmulas dinâmicas e derramamento;
- biblioteca lógica com avaliação preguiçosa;
- referências externas a Bases;
- métricas internas;
- benchmarks C1-C5 e L1-L5 executados na CI.

### Ainda em evolução

- a implementação autoritativa permanece em JavaScript;
- a representação intermediária comum ainda não substituiu todas as camadas;
- o projeto contém `app.js`, `app-v2.js` e `app-v3.js` durante a transição;
- o modelo esparso já existe no payload e no runtime, mas alguns fluxos ainda possuem limites menores que os máximos lógicos de 1.000.000 x 10.000;
- não há evidência de benchmark de produção publicada no repositório que comprove as metas de excelência de `BENCHMARK.md`.

## Rust/WebAssembly

Existe um crate em `wasm-engine/` que:

- define a ABI versão 1;
- expõe alocação e desalocação de memória;
- valida envelopes básicos de operações;
- compila para `wasm32-unknown-unknown` na CI.

Ele ainda não implementa parser de fórmulas, AST, grafo, biblioteca de funções ou recálculo. Portanto, Rust/Wasm é hoje uma fundação de integração, não o motor principal.

## Conector GitHub e publicação HTML

Implementado:

- conexão por GitHub App e confirmação OAuth do usuário;
- um repositório e uma branch por projeto;
- importação inicial e sincronização manual;
- atualização por webhook de `push` ou merge;
- espelhamento somente de `templates/**/*.html` UTF-8;
- remoção local quando um HTML é removido no GitHub;
- hospedagem dos HTMLs por rota de prévia isolada;
- suporte a subdomínio estável quando o DNS wildcard está configurado;
- ETag, cache curto e cabeçalhos de segurança;
- conteúdo somente leitura: o Super Excel não envia alterações de volta ao GitHub.

## Observabilidade e qualidade

Implementado:

- telemetria de payload, memória estimada, cálculo, renderização e colaboração;
- coleta adiada para não competir com a primeira pintura;
- Test Time compartilhado entre as quatro etapas do pipeline;
- grupos de células/intervalos, sessões e linha do tempo de propagação;
- testes Python e JavaScript;
- compilação de sintaxe Python/JavaScript na CI;
- benchmarks de cálculo, lógica e simulação de colaboração;
- compilação e testes do crate Wasm;
- validação de migrations e de assets same-origin.

## Implantação atual

- aplicação Flask executada por Gunicorn;
- Blueprint do Render em `render.yaml`;
- Docker disponível;
- Supabase obrigatório para banco e autenticação;
- dependência web do Supabase copiada para `static/vendor` durante o build;
- health check em `/api/health`.

Variáveis mínimas:

```text
SUPABASE_URL=
SUPABASE_SECRET_KEY=
SUPABASE_PUBLISHABLE_KEY=
```

O conector GitHub exige variáveis adicionais descritas em `docs/GITHUB_TEMPLATE_CONNECTOR.md`.

## O que não está implementado no código atual

- motor completo de fórmulas em Rust/Wasm;
- aplicação desktop/Tauri;
- importação nativa de XLSX ou XLSM;
- edição bidirecional dos templates GitHub;
- provas publicadas de que as metas finais de latência, RAM e concorrência foram atingidas em produção;
- estrutura final de diretórios prevista em `docs/ARCHITECTURE.md`.

## Documentos relacionados

- `README.md`: visão geral e instalação;
- `docs/ARCHITECTURE.md`: arquitetura atual, transição e alvo;
- `docs/FILE_PIPELINE.md`: regras detalhadas das quatro etapas;
- `docs/ELEMENTAR_WORKBOOKS.md`: contrato atual da publicação JSON;
- `docs/LOGICAL_ENGINE.md`: motor lógico;
- `docs/ADR-001-CUSTOM-CALCULATION-ENGINE.md`: decisão do motor próprio;
- `BENCHMARK.md`: metas e critérios, não resultados atuais;
- `docs/BENCHMARK-RUNBOOK.md`: execução dos benchmarks;
- `docs/GITHUB_TEMPLATE_CONNECTOR.md`: conector GitHub;
- `docs/GITHUB_HTML_SUBDOMAINS.md`: hospedagem dos HTMLs.
