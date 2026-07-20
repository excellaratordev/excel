# Super Excel

Plataforma web multiusuário para organizar dados, regras de negócio e publicação de aplicações empresariais usando um pipeline de quatro etapas:

```text
Base -> Planilha -> Base 2 -> Elementar
entrada   cálculo    tratado   publicação
```

A aplicação usa **Flask**, **Supabase**, **HTML/CSS/JavaScript**, um **motor de fórmulas próprio** e um núcleo híbrido stateful em **Rust/WebAssembly** para fórmulas locais suportadas.

> O retrato técnico completo e as limitações atuais estão em [`docs/CURRENT_STATUS.md`](docs/CURRENT_STATUS.md). As metas futuras permanecem separadas em [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) e [`BENCHMARK.md`](BENCHMARK.md).

## Estado atual

O projeto já possui:

- autenticação exclusivamente com Google por Supabase Auth;
- projetos, pastas, membros, roles e capacidades configuráveis;
- Base de entrada relacional com colunas tipadas e registros paginados;
- Planilha de cálculo com payload esparso e motor incremental próprio;
- referências de fórmulas a Bases, incluindo células e intervalos;
- Base 2 relacional, editável e opcionalmente materializada por uma Planilha;
- fórmulas na Base 2 com texto e último valor calculado armazenados separadamente;
- Elementar para publicar JSON versionado a partir de Bases 2;
- atualização automática das Elementares afetadas após alterações em Bases 2 configuradas;
- colaboração otimista, log de operações, deltas e fallback por snapshot;
- snapshots locais/remotos para primeira pintura rápida;
- telemetria e Test Time nas quatro etapas do pipeline;
- conector GitHub para espelhar `templates/**/*.html`;
- hospedagem isolada dos HTMLs sincronizados por prévia ou subdomínio;
- CI com testes Python, JavaScript, benchmarks e execução real do binário Wasm.

## O que ainda não está pronto

- Rust/Wasm já mantém workbooks locais, dependências por célula, cache e invalidação transitiva para fórmulas suportadas. Funções avançadas, intervalos grandes, matrizes completas, referências externas, histórico, persistência e colaboração continuam autoritativos no JavaScript.
- O frontend da Planilha possui um único caminho de produção: `templates/index.html` carrega `sheet-bootstrap-v2.js`, que inicializa `app-v3.js`.
- O payload suporta dimensões lógicas grandes, porém alguns fluxos atuais trabalham com limites menores, especialmente 5.000 linhas por 300 colunas.
- Não existe importador nativo de XLSX/XLSM no código atual.
- O conector GitHub é somente leitura, limitado a HTML e a uma conexão por projeto.
- As metas finais de latência, RAM e concorrência de `BENCHMARK.md` ainda não possuem comprovação de produção publicada no repositório.

## Pipeline de arquivos

### 1. Base

Camada relacional de entrada, persistida em `base_columns` e `base_rows`.

- Tipos: texto, número, booleano, data, data/hora e JSON.
- Valores iniciados por `=` são armazenados literalmente.
- A Base de entrada não executa fórmulas.

### 2. Planilha

Camada de cálculo e regras de negócio.

- Payload versão 2 esparso.
- Parser, AST, grafo de dependências e cache próprios.
- Recálculo seletivo das cadeias afetadas.
- Funções dinâmicas e saída derramada.
- Biblioteca de fórmulas em pt-BR com aliases em inglês.
- Referências externas a Bases:

```excel
='Clientes'!A1
=SOMA('Pedidos'!D2:D100)
```

### 3. Base 2

Camada relacional tratada.

- Permanece editável manualmente.
- Pode ser vinculada opcionalmente a um intervalo de uma Planilha.
- Materializa resultados calculados em colunas e registros.
- Pode armazenar fórmulas próprias e referências diretas a Planilhas.
- O último valor calculado é persistido para consumo da Elementar.

### 4. Elementar

Camada de publicação.

- Consome somente Bases 2 do mesmo projeto.
- Converte célula, linha, coluna ou tabela em JSON.
- Publica versões imutáveis.
- Fornece endpoint privado ou público com token.
- Usa ETag e registra dependências por intervalo.

Consulte [`docs/FILE_PIPELINE.md`](docs/FILE_PIPELINE.md) e [`docs/ELEMENTAR_WORKBOOKS.md`](docs/ELEMENTAR_WORKBOOKS.md).

## Motor de fórmulas

O runtime de produção está em `static/js/calculation/` e não depende de motores externos de planilha.

```text
fórmula
  ↓
parser próprio
  ↓
AST
  ↓
grafo de dependências locais e externas
  ↓
invalidação seletiva
  ↓
avaliação sob demanda + cache
```

Exemplos:

```excel
=SOMA(A1:A10)
=SE(B2>=1000;"Meta atingida";"Abaixo da meta")
=SOMASES(E2:E20;D2:D20;"Pago";C2:C20;"Fortaleza")
=PROCX(A2;F2:F20;H2:H20;"Não encontrado")
=ÚNICO(B2:B20)
=CLASSIFICAR(A2:D20;4;-1)
```

Use `;` como separador de argumentos e `,` como separador decimal.

## Rust/WebAssembly — ABI 4, IR compartilhada e funções empresariais

O diretório `wasm-engine/` contém um núcleo stateful em Rust compilado para WebAssembly. Para a fatia local suportada, ele mantém valores, fórmulas, dependências, cache e recálculo seletivo dentro do módulo Wasm. A ABI 4 também expõe uma representação intermediária JSON versionada, comparável à produzida pelo parser JavaScript.

Implementado:

- ABI versão `4` e IR de fórmulas versão `1`;
- parser e AST próprios em Rust;
- compilação de fórmula para IR pelo JavaScript e pelo Wasm;
- números, textos, booleanos, referências A1 e intervalos locais;
- operadores aritméticos, concatenação, percentual e comparações;
- funções básicas localizadas e aliases em inglês;
- funções condicionais `CONT.SE`, `CONT.SES`, `SOMASE`, `SOMASES`, `MÉDIASE` e `MÉDIASES`;
- critérios numéricos, comparadores e curingas `*` e `?`;
- buscas `PROCV`, `PROCX`, `ÍNDICE` e `CORRESP`;
- workbooks identificados por handles;
- grafo reverso de dependências por célula;
- cache de resultados e invalidação transitiva seletiva;
- detecção de ciclos;
- alterações em lote, revisão e lista de células afetadas;
- métricas de cache, recálculo, atualizações e arestas;
- espelhamento das edições feitas no runtime JavaScript;
- reconstrução segura do espelho após undo/redo;
- limite de 4.096 células por intervalo e 100.000 células por workbook experimental;
- binário versionado em `static/wasm/superexcel_wasm_engine.wasm`;
- testes diferenciais de IR, testes Rust e execução real do módulo Wasm pelo Node na CI.

Modos disponíveis:

- `off`: somente JavaScript, modo padrão;
- `shadow`: JavaScript permanece autoritativo e Rust é comparado em segundo plano;
- `prefer`: células escalares suportadas são lidas do workbook Rust e recursos não suportados voltam automaticamente ao JavaScript.

Exemplo:

```text
/sheet/123?wasm=shadow
/sheet/123?wasm=prefer
```

Ainda permanecem em JavaScript:

- funções de matrizes dinâmicas completas, como `FILTRO`, `ÚNICO` e `CLASSIFICAR`;
- dependências de intervalos grandes com indexação especializada;
- referências externas a Bases e Planilhas;
- spill autoritativo, histórico, persistência, snapshots e colaboração.

Consulte [`wasm-engine/README.md`](wasm-engine/README.md), [`docs/RUST_WASM_ROADMAP.md`](docs/RUST_WASM_ROADMAP.md) e [`docs/ADR-001-CUSTOM-CALCULATION-ENGINE.md`](docs/ADR-001-CUSTOM-CALCULATION-ENGINE.md).

## Executar localmente

### Requisitos

- Python 3.12 recomendado;
- Node.js 22 recomendado;
- projeto Supabase com as migrations de `supabase/migrations/` aplicadas;
- login Google habilitado no Supabase Auth.

### Instalação

```bash
python -m venv .venv
```

Windows PowerShell:

```powershell
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
npm install --omit=dev
New-Item -ItemType Directory -Force static/vendor | Out-Null
Copy-Item node_modules/@supabase/supabase-js/dist/umd/supabase.js static/vendor/supabase.js
```

Linux/macOS:

```bash
source .venv/bin/activate
pip install -r requirements.txt
npm install --omit=dev
mkdir -p static/vendor
cp node_modules/@supabase/supabase-js/dist/umd/supabase.js static/vendor/supabase.js
```

Configure o ambiente:

```text
SUPABASE_URL=
SUPABASE_SECRET_KEY=
SUPABASE_PUBLISHABLE_KEY=
```

Inicie:

```bash
python app.py
```

Abra `http://localhost:5000`.

## Produção

Gunicorn:

```bash
gunicorn --bind 0.0.0.0:8000 app:app
```

Docker:

```bash
docker build -t super-excel .
docker run --rm -p 8000:8000 --env-file .env super-excel
```

Render:

O `render.yaml` instala as dependências Python e web, copia o cliente Supabase para `static/vendor`, inicia o Gunicorn e usa `/api/health` como health check. O binário Wasm já está versionado como asset estático e não exige toolchain Rust no servidor de produção.

## Conector GitHub

A integração usa GitHub App, confirmação OAuth e tokens temporários de instalação. Ela importa somente arquivos HTML UTF-8 dentro de pastas `templates`.

Variáveis principais:

```text
GITHUB_APP_ID=
GITHUB_APP_SLUG=
GITHUB_APP_PRIVATE_KEY=
GITHUB_APP_WEBHOOK_SECRET=
GITHUB_STATE_SECRET=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_OAUTH_CALLBACK_URL=https://SEU-DOMINIO/github/callback
```

Use `/github/setup` como Setup URL, `/github/callback` como Callback URL e `/webhooks/github` como Webhook URL.

Consulte:

- [`docs/GITHUB_TEMPLATE_CONNECTOR.md`](docs/GITHUB_TEMPLATE_CONNECTOR.md);
- [`docs/GITHUB_HTML_SUBDOMAINS.md`](docs/GITHUB_HTML_SUBDOMAINS.md).

## Testes e validação

A CI oficial utiliza Python 3.12, Node.js 22 e Rust estável.

Comandos principais:

```bash
pip install -r requirements.txt pytest
pytest -q
node --test tests/js/*.test.js
node benchmarks/calculation-benchmarks.js --profile ci
node benchmarks/logical-benchmarks.js --profile ci
node benchmarks/collaboration-simulator.js
cargo test --manifest-path wasm-engine/Cargo.toml
sh scripts/build_wasm.sh
node tests/js/wasm-engine.integration.mjs static/wasm/superexcel_wasm_engine.wasm
```

## Documentação

- [`docs/CURRENT_STATUS.md`](docs/CURRENT_STATUS.md): realidade atual do projeto;
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): arquitetura atual, transição e alvo;
- [`docs/FILE_PIPELINE.md`](docs/FILE_PIPELINE.md): contrato Base -> Planilha -> Base 2 -> Elementar;
- [`docs/ELEMENTAR_WORKBOOKS.md`](docs/ELEMENTAR_WORKBOOKS.md): publicação JSON;
- [`docs/LOGICAL_ENGINE.md`](docs/LOGICAL_ENGINE.md): motor lógico;
- [`docs/RUST_WASM_ROADMAP.md`](docs/RUST_WASM_ROADMAP.md): fases de migração do núcleo;
- [`BENCHMARK.md`](BENCHMARK.md): metas oficiais;
- [`docs/BENCHMARK-RUNBOOK.md`](docs/BENCHMARK-RUNBOOK.md): execução de benchmarks.
