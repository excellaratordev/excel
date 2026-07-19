# Arquivos Elementar

Um arquivo **Elementar** é a quarta etapa do pipeline do Super Excel. Ele transforma intervalos de **Bases 2 tratadas** em um documento JSON versionado para consumo por sites, aplicativos e integrações.

```text
Base -> Planilha -> Base 2 -> Elementar -> JSON
```

Este documento descreve a implementação atual. Para o pipeline completo, consulte `docs/FILE_PIPELINE.md`.

## Regras de origem

A Elementar atual aceita somente origens que sejam:

- `file_kind = base`;
- `pipeline_stage = treated`;
- pertencentes ao mesmo projeto da Elementar.

Portanto:

- uma Base de entrada não pode alimentar diretamente uma Elementar;
- uma Planilha não pode alimentar diretamente uma Elementar;
- uma Base 2 de outro projeto não pode ser usada;
- a regra de negócio deve passar pela camada tratada antes da publicação.

## Sintaxe das declarações

Cada declaração ocupa uma célula do próprio arquivo Elementar:

```text
nome_do_elemento='Nome da Base 2'!A1:D100
```

Exemplos:

```text
empresa='Configurações Tratadas'!B2
clientes='Clientes Tratados'!A2:A100
pedidos='Pedidos Tratados'!A1:D100
dashboard.indicadores='Indicadores Tratados'!B2:F2
```

Regras:

- a chave deve começar com letra ou `_`;
- pontos criam objetos aninhados;
- o nome da origem deve estar entre apóstrofos;
- para usar apóstrofo no nome da Base 2, duplique-o;
- referências absolutas com `$` são aceitas;
- células iniciadas por `#` ou `//` são comentários;
- chaves duplicadas são rejeitadas.

Exemplo com apóstrofo:

```text
clientes='D''Ávila Tratado'!A1:C20
```

## Conversão para JSON

- uma célula gera um valor escalar;
- uma linha ou uma coluna gera uma lista;
- uma matriz cuja primeira linha contém cabeçalhos únicos gera uma lista de objetos;
- outras matrizes geram listas de listas;
- pontos no nome do elemento criam objetos aninhados;
- valores vazios no final de vetores e tabelas são removidos;
- erros de célula impedem a publicação.

Declaração:

```text
pedidos='Pedidos Tratados'!A1:D100
```

Saída possível:

```json
{
  "pedidos": [
    {
      "numero": 1001,
      "cliente": "Make",
      "status": "Produção",
      "valor": 3500
    }
  ]
}
```

## Prévia ao vivo

O painel Elementar mantém uma prévia JSON ao lado do arquivo.

Fluxo atual:

1. as declarações são lidas das células da Elementar;
2. o backend resolve os nomes apenas entre as Bases 2 do projeto;
3. o backend carrega somente as colunas e linhas solicitadas;
4. as origens relacionais são entregues como payloads esparsos;
5. o runtime do navegador converte os intervalos em JSON;
6. a prévia é atualizada após alterações, com debounce e consulta periódica.

O runtime não abre Planilhas arbitrárias nessa etapa. Os valores consumidos já são os valores persistidos nas Bases 2.

## Publicação manual

Para a primeira publicação:

1. crie o arquivo na etapa **Elementar**;
2. escreva as declarações;
3. revise a prévia JSON;
4. escolha o slug e a visibilidade;
5. publique.

A publicação registra:

- revisão da definição Elementar;
- revisões das Bases 2 de origem;
- declarações;
- JSON produzido;
- usuário responsável;
- data e hora;
- número da versão.

Cada versão é imutável. Se a Elementar ou uma Base 2 mudar entre a prévia e o envio, o backend rejeita a publicação e exige uma nova prévia.

## Atualização automática

Após a configuração das dependências, o sistema persiste os intervalos usados por cada Elementar.

Quando uma Base 2 é alterada:

1. o backend identifica as dependências que usam essa Base 2;
2. monta um snapshot somente dos intervalos necessários;
3. recalcula as Elementares afetadas;
4. grava uma nova versão apenas quando o JSON mudou;
5. mantém a versão atual quando o resultado é igual;
6. endpoints e HTMLs consumidores detectam a mudança por ETag ou versão.

A atualização automática é baseada no último valor calculado persistido na Base 2. O texto da fórmula não é publicado no lugar do resultado.

Uma falha na atualização da Elementar não desfaz a edição feita na Base 2. Nesse caso, a publicação pode permanecer pendente ou adiada.

## Endpoints

### Privado

Exige sessão e acesso ao projeto:

```text
GET /api/elementar/data/<slug>
```

### Público

Exige que a visibilidade esteja definida como pública e usa token rotacionável:

```text
GET /public/elementar/<token>
```

Exemplo:

```javascript
const response = await fetch('https://SEU-DOMINIO/public/elementar/SEU_TOKEN');
const data = await response.json();
console.log(data.pedidos);
```

## Cache e controle de versão

As respostas publicadas incluem:

```text
ETag
X-Elementar-Version
X-Elementar-Published-At
Cache-Control
```

O endpoint público também expõe CORS com:

```text
Access-Control-Allow-Origin: *
```

Consumidores podem enviar `If-None-Match` para receber `304 Not Modified` quando não houver nova versão.

## Permissões

Comportamento atual:

- `viewer`: consulta configuração e endpoint privado;
- `editor`: habilita/configura a Elementar, resolve origens, gera prévia e publica;
- `admin` ou `owner`: também pode rotacionar o token público.

Um arquivo Elementar não é convertido de volta para Planilha. Para removê-lo, exclua o arquivo.

## Limites atuais

| Limite | Valor atual |
|---|---:|
| Declarações | 100 |
| Bases 2 de origem | 20 |
| Células solicitadas | 100.000 |
| Linha máxima no processo da aplicação | 5.000 |
| Dados de origem | 20 MB |
| JSON publicado | 2 MB |

Observações:

- o parser de endereço aceita colunas A1 com até três letras;
- uma declaração que ultrapasse as colunas existentes da Base 2 é rejeitada;
- os limites são aplicados antes da publicação;
- a aplicação reduz limites genéricos do módulo para proteger o fluxo atual.

## Banco de dados

Migrations principais:

```text
supabase/migrations/20260717050000_create_elementar_workbooks.sql
supabase/migrations/20260717050500_optimize_elementar_foreign_keys.sql
supabase/migrations/20260717081500_elementar_automatic_publication.sql
supabase/migrations/20260717083000_backfill_elementar_dependencies.sql
supabase/migrations/20260717102000_create_four_stage_file_pipeline.sql
```

Estruturas principais:

- `elementar_configs`;
- `elementar_publications`;
- `elementar_dependencies`;
- `elementar_source_snapshots`;
- `file_dependencies`;
- `base_columns` e `base_rows` para as origens tratadas.

As tabelas possuem políticas de RLS onde definidas pelas migrations. O backend continua verificando acesso ao projeto antes das operações.

## Relação com HTMLs publicados

Templates HTML sincronizados pelo conector GitHub podem consumir uma Elementar pública usando o endpoint com token.

As duas publicações são independentes:

- o GitHub fornece o HTML;
- a Elementar fornece o JSON empresarial;
- o ETag permite atualizar dados sem republicar o HTML;
- alterações no HTML continuam sendo feitas no repositório GitHub.