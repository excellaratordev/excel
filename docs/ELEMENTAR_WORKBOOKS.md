# Planilhas Elementar

Uma planilha **Elementar** transforma intervalos calculados de outras planilhas em um documento JSON versionado para consumo por HTMLs e aplicativos.

## Sintaxe

Cada declaração ocupa uma célula:

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

Para usar apóstrofo no nome da planilha, duplique-o. Células iniciadas por `#` ou `//` são comentários.

## Conversão

- uma célula gera valor escalar;
- uma linha ou coluna gera uma lista;
- uma matriz cuja primeira linha contém cabeçalhos únicos gera uma lista de objetos;
- outras matrizes geram listas de listas;
- pontos no nome do elemento criam objetos aninhados.

Exemplo:

```text
pedidos='Planilha de Pedidos'!A1:D100
```

```json
{
  "pedidos": [
    {"numero": 1001, "cliente": "Make", "status": "Produção", "valor": 3500}
  ]
}
```

## Publicação

1. Crie uma **Nova Elementar** ou transforme uma planilha existente.
2. Escreva as declarações.
3. Gere a **Prévia JSON**.
4. O navegador carrega somente as origens citadas e calcula suas fórmulas com o runtime do Super Excel.
5. Revise e publique.

Cada publicação é imutável e registra a revisão da Elementar, as revisões das origens, as declarações, o JSON, o usuário, o horário e a versão. Se uma origem mudar entre a prévia e a publicação, o servidor rejeita o envio.

## Endpoints

Privado, exigindo sessão e acesso ao projeto:

```text
GET /api/elementar/data/<slug>
```

Público, com token rotacionável e CORS:

```text
GET /public/elementar/<token>
```

As respostas incluem `ETag`, `X-Elementar-Version`, `X-Elementar-Published-At` e `Cache-Control`.

```javascript
const response = await fetch('https://SEU-DOMINIO/public/elementar/SEU_TOKEN');
const data = await response.json();
console.log(data.pedidos);
```

## Permissões

- `viewer`: consulta configuração e endpoint privado;
- `editor`: ativa, configura, pré-visualiza, publica e desativa;
- `admin` ou `owner`: também troca o token público.

A Elementar pode referenciar planilhas de qualquer projeto acessível ao publicador. Nomes duplicados ficam bloqueados até se tornarem inequívocos.

## Limites iniciais

- 100 declarações;
- 20 origens;
- 100.000 células por prévia;
- 20 MB de payloads de origem;
- 2 MB de JSON publicado.

## Banco

```text
supabase/migrations/20260717050000_create_elementar_workbooks.sql
```

A migration cria `elementar_configs` e `elementar_publications`, com RLS habilitada.
