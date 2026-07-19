# Pipeline de arquivos

O Super Excel organiza dados e regras de negócio em quatro etapas:

```text
Base -> Planilha -> Base 2 -> Elementar
  1        2          3           4
entrada   cálculo    tratado    publicação
```

Este documento descreve o comportamento implementado no código atual. O resumo geral está em `docs/CURRENT_STATUS.md`.

## Identidades válidas

| Interface | `file_kind` | `pipeline_stage` | Armazenamento principal |
|---|---|---|---|
| Base | `base` | `source` | relacional |
| Planilha | `spreadsheet` | `calculation` | payload esparso |
| Base 2 | `base` | `treated` | relacional |
| Elementar | `elementar` | `publication` | definição + publicações JSON |

Combinações diferentes dessas quatro identidades são rejeitadas.

## Ordem de criação

A ordem é validada pelo banco por projeto:

1. uma Base pode ser criada sem predecessora;
2. a primeira Planilha exige pelo menos uma Base;
3. a primeira Base 2 exige pelo menos uma Planilha;
4. a primeira Elementar exige pelo menos uma Base 2.

A validação garante que as camadas anteriores existam. Ela não cria automaticamente vínculos entre todos os arquivos.

## Dependências permitidas

Novas dependências devem avançar uma única etapa:

```text
source -> calculation
calculation -> treated
treated -> publication
```

Não são permitidos vínculos diretos como:

```text
Base -> Base 2
Base -> Elementar
Planilha -> Elementar
Elementar -> etapa anterior
```

Os vínculos implementados também exigem que origem e destino pertençam ao mesmo projeto.

## Etapa 1 — Base de entrada

A Base de entrada é uma tabela relacional persistida em:

```text
base_columns
base_rows
```

### Comportamento atual

- colunas tipadas como texto, número, booleano, data, data/hora ou JSON;
- registros paginados;
- criação, edição e exclusão de colunas e registros;
- revisão otimista de registros;
- até 200 colunas por Base nas rotas atuais;
- até 500 registros por página ou operação em lote;
- até 256 KB por valor.

### Valores iniciados por `=`

Uma Base não executa fórmulas. Entretanto, o sistema atual aceita e preserva literalmente qualquer texto iniciado por `=`, inclusive em colunas declaradas como número, booleano, data, data/hora ou JSON.

Exemplo armazenado como dado:

```text
=SOMA(A1:A2)
```

Esse conteúdo não cria dependências e não é calculado na Base de entrada.

## Etapa 2 — Planilha de cálculo

A Planilha concentra fórmulas e regras de negócio.

### Armazenamento

Novas Planilhas usam payload versão 2 esparso:

```json
{
  "version": 2,
  "storage": "sparse",
  "rows": 60,
  "cols": 26,
  "cells": [
    {"r": 0, "c": 0, "v": 10},
    {"r": 0, "c": 1, "v": "=A1*2"}
  ]
}
```

As dimensões 60 x 26 são o tamanho inicial lógico, não uma matriz fixa ou totalmente alocada.

### Cálculo

O runtime JavaScript próprio oferece:

- parser e AST;
- referências A1 e intervalos;
- grafo de dependências;
- cache e invalidação seletiva;
- detecção de ciclos;
- funções dinâmicas e saída derramada;
- biblioteca lógica com curto-circuito;
- desfazer e refazer;
- métricas internas.

### Referências a Bases

Uma Planilha pode consumir somente Bases de entrada do mesmo projeto.

Exemplos:

```excel
='Clientes'!A1
=SOMA('Pedidos'!D2:D100)
```

O navegador solicita apenas as células externas referenciadas. O backend limita cada materialização a:

- até 100 referências;
- até 100.000 células externas no total;
- janelas de leitura de até 500 registros.

Quando a revisão de uma Base muda, o runtime atualiza a origem externa e invalida somente as fórmulas locais dependentes.

## Etapa 3 — Base 2 tratada

A Base 2 usa o mesmo modelo relacional da Base de entrada, mas representa dados tratados para consumo downstream.

### Edição manual

A Base 2 atual permanece editável:

- adicionar, alterar e excluir colunas;
- adicionar, alterar e excluir registros;
- armazenar valores comuns;
- armazenar fórmulas próprias.

Ela não é uma tabela obrigatoriamente bloqueada ou imutável.

### Materialização opcional de Planilha

Uma Base 2 pode ser vinculada a um intervalo de uma Planilha da etapa 2 do mesmo projeto.

Fluxo:

1. o usuário escolhe a Planilha;
2. seleciona um intervalo;
3. define se a primeira linha contém cabeçalhos;
4. o backend recebe os valores calculados mais recentes;
5. o intervalo é transformado em colunas e registros relacionais.

Limites atuais da seleção:

- até 5.000 linhas;
- até 300 colunas;
- até 100.000 células;
- prévia de até 240 linhas por 60 colunas por janela.

A sincronização é opcional. Uma Base 2 sem vínculo continua funcionando como Base relacional editável.

**Atenção:** cada materialização vinculada exclui todas as colunas e registros atuais da Base 2 e os recria a partir do intervalo selecionado. Edições manuais feitas no destino podem ser perdidas na próxima sincronização.

### Fórmulas na Base 2

Em registros da Base 2:

- o texto da fórmula é armazenado em `base_rows.formulas`;
- o último resultado calculado é armazenado em `base_rows.values`;
- referências diretas a Planilhas são aceitas, por exemplo:

```excel
='Resumo Financeiro'!B12
```

A separação permite que Elementar e outras integrações consumam o resultado calculado sem perder a expressão original.

## Etapa 4 — Elementar

A Elementar transforma intervalos de Bases 2 em JSON versionado.

### Origens permitidas

A implementação atual aceita somente:

- arquivos `base`;
- na etapa `treated`;
- pertencentes ao mesmo projeto da Elementar.

Uma Elementar não consome diretamente Bases de entrada ou Planilhas.

### Fluxo

1. a Elementar contém declarações de chave e intervalo;
2. o backend resolve os nomes somente entre as Bases 2 do projeto;
3. apenas as linhas e colunas solicitadas são carregadas;
4. o navegador gera a prévia JSON;
5. a publicação valida revisões da Elementar e das Bases 2;
6. uma versão imutável é gravada;
7. o endpoint privado ou público passa a servir essa versão.

### Atualização automática

As dependências por intervalo são persistidas. Depois que uma Elementar está configurada, alterações em uma Base 2 podem:

- montar um snapshot apenas dos intervalos utilizados;
- identificar Elementares afetadas;
- republicar somente as saídas cujo JSON mudou;
- manter a versão atual quando o resultado permanece igual.

Uma falha de republicação não desfaz a gravação relacional da Base 2; o processamento pode ficar adiado.

### Limites atuais

- 100 declarações;
- 20 Bases 2 de origem;
- 100.000 células solicitadas;
- linhas até 5.000 no processo configurado pela aplicação;
- 20 MB de payloads de origem;
- 2 MB de JSON publicado.

Consulte `docs/ELEMENTAR_WORKBOOKS.md`.

## Observabilidade do pipeline

O Test Time funciona nas quatro etapas.

Ele permite:

- criar uma sessão por projeto;
- selecionar grupos de células ou intervalos;
- identificar a etapa de cada grupo;
- registrar eventos numa linha do tempo compartilhada;
- observar propagação entre Base, Planilha, Base 2 e Elementar.

O Test Time é uma ferramenta de observabilidade. Ele não altera as regras do pipeline.

## Regras práticas

### Use Base para

- dados brutos;
- cadastros;
- importações normalizadas;
- registros empresariais que não precisam de cálculo local.

### Use Planilha para

- fórmulas;
- regras de negócio;
- cruzamentos entre Bases;
- indicadores e cálculos intermediários.

### Use Base 2 para

- estabilizar resultados em formato relacional;
- receber materializações de intervalos calculados;
- manter dados tratados para publicação, considerando que novas sincronizações substituem o conteúdo materializado.

### Use Elementar para

- entregar JSON a sites e aplicativos;
- versionar uma saída pública ou privada;
- desacoplar o frontend das estruturas internas de cálculo.
