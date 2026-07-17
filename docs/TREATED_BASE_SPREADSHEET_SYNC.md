# Base 2 alimentada por Planilha

A etapa **Base 2** recebe dados tratados de uma **Planilha de cálculo** da etapa 2, mas continua disponível como uma Base relacional editável.

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

## Edição manual

A Base 2 mantém as mesmas ações da Base de entrada:

- adicionar coluna;
- adicionar registro;
- editar valores;
- excluir colunas e registros.

O painel **Planilha** é opcional e funciona como uma forma adicional de preencher ou atualizar a Base 2. Uma nova sincronização do intervalo vinculado pode substituir a estrutura e os registros materializados pela Planilha; portanto, ajustes manuais que precisem ser permanentes devem ser refletidos também na origem quando houver vínculo ativo.

## Sincronização calculada

A Planilha publica apenas os intervalos exigidos pelas Bases 2 dependentes. Os valores calculados ficam em `treated_base_source_snapshots`. Quando uma célula relevante muda, a Base 2 é rematerializada automaticamente.

## Interface

- Desktop: Base 2 e Planilha de origem lado a lado.
- Mobile: painel em tela cheia, controles com área de toque ampliada e modo explícito **Selecionar área**.
- A grade de origem é virtualizada e carregada em páginas de linhas e colunas.
- O painel suporta clique, arraste, toque e arraste.
- Os botões **Coluna** e **Registro** permanecem disponíveis em desktop e mobile.

## Limites

- 5.000 linhas por Planilha calculada.
- 300 colunas.
- 100.000 células por vínculo.
- Snapshot calculado de até 4 MB.
