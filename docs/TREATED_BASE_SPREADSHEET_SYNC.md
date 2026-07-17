# Base 2 alimentada por Planilha

A etapa **Base 2** recebe dados tratados de uma **Planilha de cálculo** da etapa 2.

## Fluxo

```text
Base de entrada -> Planilha -> Base 2 -> Elementar
```

1. Abra uma Base 2.
2. Use o painel **Planilha**.
3. Escolha a Planilha de origem.
4. Clique ou arraste um intervalo.
5. Defina se a primeira linha será usada como cabeçalho.
6. Clique em **Usar na Base 2**.

O vínculo é persistido em `treated_base_bindings`. A Base 2 recebe colunas tipadas e registros relacionais materializados nas tabelas `base_columns` e `base_rows`.

## Sincronização calculada

A Planilha publica apenas os intervalos exigidos pelas Bases 2 dependentes. Os valores calculados ficam em `treated_base_source_snapshots`. Quando uma célula relevante muda, a Base 2 é rematerializada automaticamente.

A tabela tratada é somente leitura para usuários. Alterações devem ser feitas na Planilha de origem ou no intervalo vinculado.

## Interface

- Desktop: Base 2 e Planilha de origem lado a lado.
- Mobile: painel em tela cheia, controles com área de toque ampliada e modo explícito **Selecionar área**.
- A grade de origem é virtualizada e carregada em páginas de linhas e colunas.
- O painel suporta clique, arraste, toque e arraste.

## Limites

- 5.000 linhas por Planilha calculada.
- 300 colunas.
- 100.000 células por vínculo.
- Snapshot calculado de até 4 MB.
