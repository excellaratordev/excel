# Planilhas Elementar

Uma planilha **Elementar** transforma intervalos calculados de outras planilhas em um documento JSON versionado, pronto para ser consumido por um HTML ou aplicativo.

## Sintaxe

Cada declaração ocupa uma célula e segue este formato:

```text
nome_do_elemento='Nome da Planilha'!A1:D100
```

Exemplos:

```text
empresa='Configurações'!B2
clientes='Clientes'!A2:A100
pedidos='Planilha de Pedidos'!A1:D100
dashboard.indicadores='Indicadores'!B2:F2
```

O nome da planilha usa aspas simples. Para incluir um apóstrofo no nome, duplique-o:

```text
resumo='João''s Dashboard'!A1:B10
```

Linhas iniciadas por `#` ou `//` são tratadas como comentários.

## Conversão para JSON

A forma do intervalo determina a saída:

- uma célula gera um valor escalar;
- uma única linha gera uma lista;
- uma única coluna gera uma lista;
- uma matriz cuja primeira linha possui cabeçalhos únicos gera uma lista de objetos;
- uma matriz sem cabeçalhos válidos gera uma lista de listas.

Exemplo de origem:

| numero | cliente | status | valor |
|---:|---|---|---:|
| 1001 | Make | Produção | 3500 |
| 1002 | Lignis | Entregue | 4200 |

Declaração:

```text
pedidos='Planilha de Pedidos'!A1:D100
```

Saída:

```json
{
  "pedidos": [
    {
      "numero": 1001,
      "cliente": "Make",
      "status": "Produção",
      "valor": 3500
    },
    {
      "numero": 1002,
      "cliente": "Lignis",
      "status": "Entregue",
      "valor": 4200
    }
  ]
}
```

Pontos no nome do elemento criam objetos aninhados. Por exemplo:

```text
dashboard.faturamento='Indicadores'!B2
```

gera:

```json
{
  "dashboard": {
    "faturamento": 120000
  }
}
```

## Fluxo de publicação

1. Crie uma **Nova Elementar** no gerenciador ou transforme uma planilha existente.
2. Escreva as declarações nas células.
3. Clique em **Prévia JSON**.
4. O navegador carrega somente as planilhas citadas, calcula suas fórmulas com o runtime do Super Excel e monta o documento.
5. Erros de fórmula, referências ausentes, nomes ambíguos e conflitos de chaves impedem a publicação.
6. Clique em **Publicar** para criar uma versão imutável.
7. O endpoint continua entregando a última versão publicada enquanto a definição é editada.

A publicação registra a revisão da Elementar, as revisões das origens, as declarações, o JSON final, o usuário, o horário e a versão sequencial. Se uma origem mudar durante a geração, o servidor rejeita a publicação e solicita uma nova prévia.

## Endpoints

### Privado

```text
GET /api/elementar/data/<slug>
```

Exige login e acesso de visualização ao projeto.

### Público

```text
GET /public/elementar/<token>
```

Disponível somente quando a visibilidade está configurada como `public`. A resposta permite CORS e inclui `ETag`, `X-Elementar-Version`, `X-Elementar-Published-At` e `Cache-Control`.

```javascript
const response = await fetch('https://SEU-DOMINIO/public/elementar/SEU_TOKEN');
if (!response.ok) throw new Error('Não foi possível carregar os dados.');
const data = await response.json();
console.log(data.pedidos);
```

## Permissões

- `viewer`: consulta a configuração e consome o endpoint privado;
- `editor`: transforma, configura, pré-visualiza, publica e desativa uma Elementar;
- `admin` ou `owner`: também pode trocar o token público.

Uma Elementar pode usar planilhas de qualquer projeto ao qual o usuário que está publicando tenha acesso. Nomes duplicados entre planilhas acessíveis bloqueiam a publicação até que fiquem inequívocos.

## Limites iniciais

- até 100 declarações;
- até 20 planilhas de origem;
- até 100.000 células selecionadas por prévia;
- até 20 MB somados de payloads de origem;
- até 2 MB no JSON publicado;
- nomes de intervalo A1 com até três letras de coluna.

## Banco de dados

A migration cria `elementar_configs` e `elementar_publications`:

```text
supabase/migrations/20260717050000_create_elementar_workbooks.sql
```
