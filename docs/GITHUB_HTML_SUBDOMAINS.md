# Publicação dos HTMLs do GitHub por subdomínio

## Comportamento

Cada conexão GitHub do Super Excel recebe um identificador DNS estável (`site_slug`).

Exemplo:

```text
repositório: empresa/frontend-cliente
projeto: 42
site_slug: frontend-cliente-42
```

Com o domínio base `sites.superexcel.com.br`, o site será publicado em:

```text
https://frontend-cliente-42.sites.superexcel.com.br/
```

O arquivo `templates/index.html` é usado como página inicial. Caso ele não exista, o primeiro HTML sincronizado em ordem alfabética é usado como entrada.

Os outros arquivos permanecem no mesmo subdomínio:

```text
templates/sobre.html       -> /sobre.html
templates/admin/index.html -> /admin/index.html
```

Também são aceitas rotas sem a extensão:

```text
/sobre -> templates/sobre.html
/admin -> templates/admin/index.html
```

Enquanto o DNS wildcard não estiver configurado, o painel usa automaticamente a rota de prévia:

```text
/_sites/frontend-cliente-42/
```

## Configuração de produção

Configure no serviço web:

```text
GITHUB_SITES_BASE_DOMAIN=sites.superexcel.com.br
GITHUB_SITES_SCHEME=https
```

O domínio base deve ser dedicado aos HTMLs publicados. Evite usar o mesmo host do painel autenticado.

### DNS

Crie um registro wildcard apontando para o serviço que executa o Super Excel:

```text
*.sites.superexcel.com.br  CNAME  SEU-HOST-DE-PRODUCAO
```

Também adicione `sites.superexcel.com.br` e o wildcard como domínios aceitos no provedor de hospedagem, quando exigido.

Um único wildcard atende todos os projetos. Não é necessário criar um registro DNS a cada nova conexão.

## Banco

Aplicar:

```text
supabase/migrations/20260717070000_publish_github_html_subdomains.sql
```

A migration adiciona:

- `github_connections.site_slug`;
- `github_connections.site_enabled`;
- `github_template_files.site_path`;
- índices e triggers para manter os endereços automaticamente.

## Segurança

Os HTMLs são servidos em origem separada do painel principal.

As respostas incluem:

- `X-Content-Type-Options: nosniff`;
- `Cross-Origin-Opener-Policy: same-origin`;
- `Referrer-Policy: strict-origin-when-cross-origin`;
- bloqueio de câmera, microfone e geolocalização por padrão;
- ETag baseado no blob sincronizado;
- cache curto para refletir atualizações do GitHub rapidamente.

O conteúdo continua sendo um espelho somente de leitura. Alterações são feitas no GitHub e chegam por sincronização manual ou webhook.

## Endpoints

```text
GET /api/github/site?project_id=42
GET /_sites/<site_slug>/
GET /_sites/<site_slug>/<caminho-html>
```

Quando `GITHUB_SITES_BASE_DOMAIN` estiver configurado, as mesmas páginas também respondem pelo host wildcard.
