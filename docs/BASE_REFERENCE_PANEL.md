# Painel Base e referências relacionais

## Objetivo

Permitir que uma Planilha de cálculo consulte uma Base de entrada sem carregar a tabela inteira no navegador.

A interface abre um painel Base à direita da Planilha. Durante a edição de uma fórmula, o usuário pode clicar em uma célula ou arrastar uma faixa no painel. A referência é inserida na posição atual do cursor.

```text
=(C3*A7)/2+'Clientes'!A1
=SOMA('Clientes'!A1:A100)
=FILTRO('Pedidos'!A1:F500;'Pedidos'!F1:F500="Pendente")
```

## Semântica

- `'Base'!A1` é uma referência escalar.
- `'Base'!A1:A3` é uma referência de faixa e retorna uma matriz.
- A coluna `A` é a primeira coluna da Base por `position`.
- A linha `1` é o primeiro registro da Base por `row_order`.
- Nomes são sempre serializados entre aspas simples; uma aspa no nome é escapada como `''`.
- Somente arquivos `base/source` do mesmo projeto podem ser consumidos por `spreadsheet/calculation`.
- A dependência `Base -> Planilha` é sincronizada no banco a partir das fórmulas salvas.

## Carregamento sob demanda

O painel usa paginação e virtualização. O navegador mantém apenas a janela próxima ao viewport.

O motor de cálculo possui um registro esparso de fontes externas. Ao abrir a Planilha:

1. as fórmulas são analisadas;
2. somente os intervalos externos usados são enviados ao backend;
3. o backend valida projeto, tipo e etapa;
4. somente as linhas e colunas necessárias são materializadas;
5. os valores são registrados no runtime;
6. fórmulas dependentes são invalidadas e recalculadas.

A revisão da Base acompanha cada snapshot parcial. Quando a revisão muda, células antigas daquela fonte são descartadas antes da nova hidratação.

## Limites

- até 100 referências por hidratação;
- até 100.000 células externas por requisição;
- até 500 linhas por janela visual;
- nomes duplicados de Bases no mesmo projeto são considerados ambíguos para fórmulas por nome.
