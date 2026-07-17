# Fórmulas de referência na Base 2

A Base 2 aceita referências diretas para células de uma Planilha de cálculo do mesmo projeto:

```text
='Planilha de Pedidos'!A1
='Planilha de Pedidos'!B2
```

## Armazenamento

A expressão e o resultado são mantidos separadamente:

- `base_rows.formulas`: preserva a expressão digitada pelo usuário;
- `base_rows.values`: armazena o valor calculado consumido pela Elementar.

Dessa forma, a grade mostra o resultado, mas ao entrar na célula o usuário continua editando a fórmula original.

## Cálculo

A Base 2 abre a Planilha de origem em um runtime invisível do mesmo navegador. Esse runtime usa o motor normal do Super Excel, inclusive referências da Planilha para a Base de entrada. Quando o resultado muda, a Base 2 atualiza somente a propriedade relacional correspondente.

## Escopo inicial

A Base 2 resolve referências escalares diretas no formato `='Planilha'!A1`. Operações, funções e intervalos continuam sendo calculados dentro da Planilha; a Base 2 deve apontar para a célula que contém o resultado final.
