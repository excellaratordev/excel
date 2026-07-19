# Super Excel

Plataforma web multiusuário para organizar dados, regras de negócio e publicação de aplicações empresariais usando um pipeline de quatro etapas:

```text
Base -> Planilha -> Base 2 -> Elementar
entrada   cálculo    tratado   publicação
```

A aplicação usa **Flask**, **Supabase**, **HTML/CSS/JavaScript**, um **motor de fórmulas próprio** e um protótipo **embrionário e experimental** em **Rust/WebAssembly**.

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
- CI com testes Python, JavaScript, benchmarks e compilação Wasm.

## O que ainda não está pronto

- O motor de fórmulas autoritativo continua em JavaScript. O crate Rust/Wasm atual é apenas um experimento de ABI e memória; ele não calcula fórmulas, não mantém estado de planilha e não está conectado ao caminho de produção.
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

## Rust/WebAssembly — estágio embrionário

O diretório `wasm-engine/` **não contém um motor de planilhas**. Ele é um laboratório arquitetural mínimo para testar se o navegador consegue carregar um módulo Wasm e trocar um pequeno envelope de dados com ele.

O que existe hoje:

- ABI experimental versão `1`;
- funções de alocação e desalocação de memória linear;
- verificação superficial de um envelope UTF-8 contendo os textos `id` e `kind`;
- adaptador JavaScript que instancia o módulo e confere a versão da ABI;
- três testes Rust básicos;
- build para `wasm32-unknown-unknown` na CI.

A validação atual não faz parsing estrutural completo de JSON e não representa validação de negócio ou segurança.

O que ainda não existe em Rust/Wasm:

- parser e AST de fórmulas;
- referências A1 e intervalos;
- grafo de dependências;
- biblioteca de funções e coerção de tipos;
- recálculo, invalidação, cache e detecção de ciclos;
- matrizes dinâmicas, undo e redo;
- estado de workbook ou persistência;
- integração com a grade, colaboração ou runtime JavaScript;
- buffers binários compactos para grandes lotes;
- benchmarks que demonstrem vantagem sobre JavaScript;
- fallback e rollback para ativação segura.

Portanto, Rust/Wasm não é uma migração ativa nem uma parte funcional do produto. É somente uma possibilidade futura. Qualquer adoção dependerá de contrato estruturado, testes de paridade, ganho mensurável de desempenho e memória, compatibilidade com planilhas existentes e rollback seguro.

Consulte [`wasm-engine/README.md`](wasm-engine/README.md) e [`docs/ADR-001-CUSTOM-CALCULATION-ENGINE.md`](docs/ADR-001-CUSTOM-CALCULATION-ENGINE.md).

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

O `render.yaml` instala as dependências Python e web, copia o cliente Supabase para `static/vendor`, inicia o Gunicorn e usa `/api/health` como health check.

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
cargo build --manifest-path wasm-engine/Cargo.toml --target wasm32-unknown-unknown --release
```

## Documentação

- [`docs/CURRENT_STATUS.md`](docs/CURRENT_STATUS.md): realidade atual do projeto;
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): arquitetura atual, transição e alvo;
- [`docs/FILE_PIPELINE.md`](docs/FILE_PIPELINE.md): contrato Base -> Planilha -> Base 2 -> Elementar;
- [`docs/ELEMENTAR_WORKBOOKS.md`](docs/ELEMENTAR_WORKBOOKS.md): publicação JSON;
- [`docs/LOGICAL_ENGINE.md`](docs/LOGICAL_ENGINE.md): motor lógico;
- [`BENCHMARK.md`](BENCHMARK.md): metas oficiais;
- [`docs/BENCHMARK-RUNBOOK.md`](docs/BENCHMARK-RUNBOOK.md): execução de benchmarks.
