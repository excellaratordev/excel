# Super Excel

Planilha web construída com **HTML, CSS, JavaScript, Flask e um motor de cálculo incremental próprio**. Funciona localmente e pode ser publicada em serviços que executem aplicações Python, como Render, Railway, Fly.io ou qualquer servidor com Docker.

## Recursos

- Grade com 60 linhas e 26 colunas.
- Barra de fórmulas e referências A1.
- Motor de cálculo próprio, esparso, incremental e orientado a dependências.
- 30 fórmulas principais, incluindo `SOMA`, `SE`, `SOMASES`, `PROCX`, `FILTRO`, `ÚNICO` e `CLASSIFICAR`.
- Recálculo seletivo somente das cadeias afetadas.
- Dependências de intervalos indexadas por chunks, sem expandir cada célula no grafo.
- Funções dinâmicas com saída derramada.
- Colar intervalos copiados do Excel.
- Desfazer e refazer.
- Autosave no navegador.
- Persistência no servidor usando Supabase.
- Importação e exportação em JSON.
- Planilhas Elementar para publicar regras e intervalos calculados como APIs JSON versionadas.
- Conector GitHub para espelhar automaticamente `templates/**/*.html` após push ou merge.
- Execução local, Gunicorn, Render e Docker.

## Executar localmente

```bash
python -m venv .venv
```

Windows PowerShell:

```powershell
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python app.py
```

Linux/macOS:

```bash
source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

Abra `http://localhost:5000`.

## Executar como servidor de produção

```bash
pip install -r requirements.txt
gunicorn --bind 0.0.0.0:8000 app:app
```

Abra `http://localhost:8000`.

## Executar com Docker

```bash
docker build -t super-excel .
docker run --rm -p 8000:8000 super-excel
```

## Publicar no Render

O arquivo `render.yaml` já define o build, o comando de inicialização e o health check. Crie um Blueprint no Render apontando para este repositório.

## Conector GitHub

A integração usa um GitHub App com acesso de leitura ao conteúdo do repositório. Ela não armazena tokens pessoais do cliente e confirma por OAuth que o usuário realmente possui acesso à instalação e ao repositório escolhidos.

Após a instalação, o Super Excel faz uma importação inicial e passa a reagir aos webhooks de `push`. Um merge na branch monitorada também gera um `push`.

Configure as variáveis:

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

No GitHub App, use `/github/setup` como Setup URL, `/github/callback` como Callback URL e `/webhooks/github` como Webhook URL.

Aplique a migration `supabase/migrations/20260717033000_create_github_template_connector.sql` e consulte `docs/GITHUB_TEMPLATE_CONNECTOR.md`.

## Planilhas Elementar

Uma Elementar transforma intervalos de outras planilhas em um JSON publicado para o frontend:

```text
pedidos='Planilha de Pedidos'!A1:D100
empresa='Configurações'!B2
dashboard.indicadores='Indicadores'!B2:F2
```

Uma célula gera um valor, uma linha ou coluna gera uma lista e uma tabela com cabeçalhos gera uma lista de objetos. A prévia é calculada no navegador pelo mesmo runtime da planilha; a publicação cria uma versão imutável acessível por endpoint privado ou público.

Aplique a migration `supabase/migrations/20260717050000_create_elementar_workbooks.sql` e consulte `docs/ELEMENTAR_WORKBOOKS.md`.

## Fórmulas

Use `;` como separador de argumentos e `,` como separador decimal.

```excel
=SOMA(A1:A10)
=SE(B2>=1000;"Meta atingida";"Abaixo da meta")
=SOMASES(E2:E20;D2:D20;"Pago";C2:C20;"Fortaleza")
=PROCX(A2;F2:F20;H2:H20;"Não encontrado")
=ÚNICO(B2:B20)
=CLASSIFICAR(A2:D20;4;-1)
```

O runtime atual é implementado dentro do próprio repositório e não depende de motores de planilha de terceiros. Sua interface foi desenhada para permitir a futura compilação do núcleo em Rust/WebAssembly sem alterar a grade, a colaboração ou o formato das operações.

## Arquitetura do motor

```text
fórmula
  ↓
parser próprio
  ↓
AST
  ↓
grafo de dependências por célula e intervalo
  ↓
invalidação seletiva
  ↓
avaliação sob demanda + cache
```

Consulte `docs/ARCHITECTURE.md` e `BENCHMARK.md` para as metas oficiais.
