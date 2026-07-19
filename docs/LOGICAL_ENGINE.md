# Motor lógico do Super Excel

O motor lógico é um subsistema separado do runtime geral de fórmulas. Ele concentra comparações, coerção booleana, avaliação condicional, tratamento seletivo de erros, aliases pt-BR e métricas de curto-circuito.

## Arquivos

```text
static/js/calculation/
├── formula-parser.js
├── formula-runtime.js
├── logical-library.js
└── logical-localization-ptbr.js
```

- `logical-library.js`: regras, funções, catálogo, comparação vetorizada e avaliação preguiçosa.
- `logical-localization-ptbr.js`: aliases localizados que apontam para a mesma implementação, sem duplicar handlers.
- `formula-runtime.js`: runtime incremental atual e implementação autoritativa em produção. Não existe execução lógica equivalente em Rust/Wasm neste momento.

## Garantias

1. `SE`, `SES`, `E`, `OU`, `SEERRO`, `SENÃODISP` e `PARÂMETRO` avaliam somente os ramos necessários.
2. Operadores `=`, `<>`, `<`, `>`, `<=` e `>=` passam por uma única implementação e suportam broadcasting de matrizes.
3. Erros não selecionados por uma condição não contaminam o resultado.
4. `SENÃODISP` trata somente `#N/D`; outros erros continuam visíveis.
5. Funções de inspeção retornam valores booleanos e podem ser usadas para construir regras empresariais.
6. O catálogo exibido no glossário é derivado do registro lógico e não de uma lista visual independente.
7. Métricas de chamadas, curto-circuitos, ramos avaliados e fallbacks de erro são expostas por `engine.getStats()`.

## Funções lógicas

```text
SE / IF
SES / IFS
E / AND
OU / OR
NÃO / NOT
OUEXCL / XOR
SEERRO / IFERROR
SENÃODISP / IFNA
PARÂMETRO / SWITCH
VERDADEIRO / TRUE
FALSO / FALSE
```

## Funções de inspeção

```text
ÉCÉL.VAZIA / ISBLANK
ÉLÓGICO / ISLOGICAL
ÉNÚM / ISNUMBER
ÉTEXTO / ISTEXT
ÉERRO / ISERROR
ÉERROS / ISERR
ÉNÃO.DISP / ISNA
NÃO.DISP / NA
```

## Compatibilidade pt-BR

As variações abaixo usam os mesmos handlers:

```text
SEERRO = SE.ERRO
SENÃODISP = SE.NÃO.DISP
OUEXCL = OU.EXCL
NÃO.DISP = NA
```

## Matrizes

Comparações e `SE` suportam matrizes derramadas. Um teste como:

```excel
=SE(A1:A100>0;"Positivo";"Não positivo")
```

produz uma matriz vertical sem gravar fórmulas nas células de saída.

## Métricas

O runtime expõe:

```text
logical_calls
logical_short_circuits
logical_condition_branches
logical_error_fallbacks
```

Essas métricas permitem verificar se regras complexas estão evitando trabalho desnecessário.

## Benchmarks

`benchmarks/logical-benchmarks.js` executa:

- L1: grande volume de `SE` com ramo inválido não selecionado;
- L2: curto-circuito em `E` e `OU`;
- L3: comparação vetorizada e `SE` derramado;
- L4: seleção entre muitos casos com `PARÂMETRO`;
- L5: roteamento seletivo de erros.

## Rust/Wasm: hipótese futura, não migração ativa

A migração do motor lógico para Rust/Wasm **não foi iniciada**. O crate atual não possui representação intermediária, instruções lógicas, coerção de tipos, avaliação preguiçosa ou comparação vetorizada.

Uma implementação futura só poderá ser considerada depois que o contrato geral do motor estiver estável. Nesse cenário ainda hipotético:

1. os handlers lógicos poderão se tornar instruções de uma representação intermediária;
2. `SE`, `E`, `OU`, `SEERRO` e equivalentes deverão manter avaliação preguiçosa;
3. comparações vetorizadas poderão usar buffers colunares, caso benchmarks comprovem benefício;
4. o catálogo e os aliases deverão continuar como contrato público;
5. planilhas existentes não poderão precisar alterar suas fórmulas;
6. os mesmos testes de semântica deverão passar em JavaScript e Rust.

Até que isso aconteça, toda a funcionalidade descrita neste documento pertence exclusivamente ao runtime JavaScript.
