# Conector GitHub para templates HTML

## Escopo do MVP

Cada projeto do Super Excel pode conectar um repositório GitHub e uma branch.

A sincronização aceita somente arquivos que:

- tenham extensão `.html`;
- estejam dentro de uma pasta chamada `templates`;
- sejam UTF-8;
- respeitem os limites configurados no servidor.

A importação inicial varre o repositório inteiro. Depois disso, webhooks de `push` atualizam apenas os arquivos adicionados, modificados ou removidos. Um merge na branch monitorada também gera um `push`, portanto entra no mesmo fluxo.

## Segurança

A integração usa um **GitHub App**, não um token pessoal do cliente.

O fluxo de instalação possui duas validações:

1. o estado iniciado pelo Super Excel é assinado e expira;
2. depois da instalação, o usuário autoriza o GitHub App por OAuth e o backend confirma que aquela conta realmente possui acesso à instalação e ao repositório selecionados.

O `installation_id` recebido na Setup URL nunca é aceito sozinho.

O banco armazena somente:

- ID da instalação;
- repositório;
- branch;
- estado da sincronização;
- conteúdo e metadados dos HTMLs importados.

O token OAuth do usuário não é persistido. Tokens de instalação são temporários, gerados pelo backend e mantidos apenas em memória até perto da expiração.

As rotas de configuração exigem:

- `admin` para conectar ou desconectar;
- `editor` para solicitar sincronização manual;
- `viewer` para consultar o estado e os arquivos.

O webhook valida `X-Hub-Signature-256` antes de ler o evento.

## Configuração do GitHub App

Crie um GitHub App com:

- **Setup URL:** `https://SEU-DOMINIO/github/setup`;
- **Callback URL:** `https://SEU-DOMINIO/github/callback`;
- **Webhook URL:** `https://SEU-DOMINIO/webhooks/github`;
- **Webhook secret:** um valor aleatório forte;
- **Repository permissions / Contents:** `Read-only`;
- **Repository permissions / Metadata:** `Read-only`;
- **Subscribe to events:** `Push`.

Variáveis de ambiente obrigatórias:

```text
GITHUB_APP_ID=
GITHUB_APP_SLUG=
GITHUB_APP_PRIVATE_KEY=
GITHUB_APP_WEBHOOK_SECRET=
GITHUB_STATE_SECRET=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
```

A chave privada pode ser configurada com quebras de linha reais ou com `\n`.

Em produção, configure explicitamente a mesma Callback URL cadastrada no GitHub App:

```text
GITHUB_OAUTH_CALLBACK_URL=https://SEU-DOMINIO/github/callback
```

Variáveis opcionais:

```text
GITHUB_REQUEST_TIMEOUT=20
GITHUB_STATE_TTL_SECONDS=900
GITHUB_MAX_HTML_FILES=500
GITHUB_MAX_HTML_FILE_BYTES=1048576
GITHUB_MAX_TOTAL_HTML_BYTES=26214400
GITHUB_MAX_ARCHIVE_BYTES=52428800
```

## Banco

Aplicar a migration:

```text
supabase/migrations/20260717033000_create_github_template_connector.sql
```

Tabelas:

- `github_connections`: uma conexão por projeto;
- `github_template_files`: espelho dos HTMLs;
- `github_webhook_deliveries`: idempotência e auditoria mínima dos webhooks.

As três tabelas usam RLS. O backend opera por chave de serviço e continua aplicando as permissões do projeto antes de qualquer operação.

## Endpoints

```text
POST   /api/github/connect
GET    /github/setup
GET    /github/callback
GET    /api/github/connection?project_id=...
POST   /api/github/sync
DELETE /api/github/connection
POST   /webhooks/github
```

## Fluxo de conexão

1. O administrador informa o repositório e a branch no Super Excel.
2. O backend gera um estado assinado e abre a instalação do GitHub App.
3. O GitHub redireciona para `/github/setup` com o ID da instalação.
4. O backend gera um segundo estado assinado e inicia o OAuth do usuário.
5. O callback troca o código por um token temporário do usuário.
6. O backend consulta os repositórios daquela instalação usando o token do usuário.
7. Somente depois dessa confirmação é gerado o token temporário da instalação e iniciada a importação.

## Comportamento de sincronização

### Inicial ou manual

1. Gera um token temporário da instalação.
2. Obtém o commit atual da branch.
3. Baixa um ZIP autenticado do repositório.
4. Filtra somente `templates/**/*.html`.
5. Faz upsert dos arquivos encontrados.
6. Remove arquivos que não existem mais no repositório.

### Push ou merge

1. Valida assinatura e ID único da entrega.
2. Confirma instalação, repositório e branch.
3. Soma os caminhos alterados de todos os commits do payload.
4. Busca somente HTMLs adicionados ou modificados.
5. Exclui os HTMLs removidos.
6. Quando o payload está incompleto ou o push é forçado, executa sincronização completa.

## Limites atuais

- um repositório por projeto;
- uma branch por conexão;
- somente HTML;
- processamento síncrono do webhook;
- o conteúdo importado é um espelho de leitura; esta versão não envia alterações de volta ao GitHub.
