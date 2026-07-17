# Benchmark e Metas Oficiais

Este documento define as metas técnicas e os critérios de aceitação do projeto **Excel Empresarial**.

O produto deve competir diretamente com **Excel Online** e **Google Sheets** em cálculo, colaboração e versatilidade, mantendo uma arquitetura flexível, incremental e orientada a cadeias/grafos de dependência.

A planilha não deve ser tratada como um arquivo monolítico. O sistema deve carregar, calcular, sincronizar e manter em RAM apenas os dados, blocos, resultados e subgrafos necessários para a operação atual.

---

## 1. Princípios obrigatórios

1. Nenhuma ação local deve aguardar confirmação do servidor para aparecer na interface.
2. Nenhuma planilha grande deve ser carregada integralmente sem necessidade.
3. Nenhuma alteração deve provocar recálculo completo quando apenas parte do grafo foi invalidada.
4. Nenhuma grade deve criar um elemento DOM permanente para cada célula possível.
5. Resultados intermediários devem ser reutilizados quando ainda forem válidos.
6. Dados fora da área visível ou do fluxo ativo devem poder sair da RAM.
7. Roles devem representar conjuntos configuráveis de permissões, e não apenas níveis fixos.
8. Toda otimização deve ser comprovada por métricas reproduzíveis.

---

# 2. Metas de cálculo

## Objetivo

Entregar capacidade de cálculo semelhante ou superior ao Excel Online e Google Sheets em cenários empresariais reais.

## Metas de latência

| Operação | Meta inicial | Meta de excelência |
|---|---:|---:|
| Digitação em célula sem fórmula | até 16 ms | até 8 ms |
| Fórmula simples com poucas dependências | até 16 ms | até 8 ms |
| Alteração com 1.000 dependentes | até 50 ms | até 25 ms |
| Alteração com 10.000 dependentes | até 200 ms | até 100 ms |
| Colar 10.000 células | até 500 ms | até 250 ms |
| Colar 100.000 células | até 2 s | até 1 s |
| Abrir planilha empresarial comum | até 2 s | até 1 s |
| Reabrir planilha já armazenada em cache local | até 700 ms | até 300 ms |
| Scroll da grade | 60 FPS | 120 FPS em dispositivos compatíveis |

## Regras de execução

- Recalcular apenas nós afetados.
- Priorizar células e resultados visíveis.
- Cancelar cálculos obsoletos quando uma nova alteração invalidar o mesmo fluxo.
- Compartilhar subexpressões e resultados intermediários.
- Aplicar atualização por diferença quando a operação permitir.
- Executar operações vetorizadas e em blocos.
- Usar streaming para agregações que não exigem manter o conjunto completo em memória.
- Manter fórmulas, SQL, automações, APIs e Python traduzíveis para uma representação intermediária comum.

## Cenários obrigatórios de benchmark

### Cenário C1 — Cadeia linear

- 100.000 células encadeadas.
- Alterar o primeiro valor.
- Medir tempo de propagação até o último resultado.

### Cenário C2 — Grafo ramificado

- Uma célula alimentando 10.000 resultados independentes.
- Medir recálculo total e atualização visual.

### Cenário C3 — Agregação empresarial

- 1 milhão de registros.
- Filtrar período, status e responsável.
- Somar uma coluna numérica.
- Carregar apenas as colunas utilizadas.

### Cenário C4 — Reutilização de cadeia

- Um filtro comum alimentando cinco indicadores diferentes.
- O filtro deve ser executado apenas uma vez quando o resultado intermediário for reutilizável.

### Cenário C5 — Cálculo por diferença

- Alterar um único registro dentro de uma soma de 1 milhão de registros.
- Atualizar o total pela diferença sem recalcular toda a fonte, quando tecnicamente seguro.

---

# 3. Metas de colaboração em tempo real

## Objetivo

Entregar **zero espera local** e atraso remoto imperceptível para múltiplos usuários trabalhando na mesma planilha.

Não existe latência física igual a zero em rede. O critério do produto é que o usuário nunca perceba bloqueio ou espera durante a edição.

## Metas

| Indicador | Meta inicial | Meta de excelência |
|---|---:|---:|
| Aplicação visual local | até 16 ms | até 8 ms |
| Propagação remota p50 | até 60 ms | até 30 ms |
| Propagação remota p95 | até 150 ms | até 80 ms |
| Propagação remota p99 | até 300 ms | até 150 ms |
| Operações perdidas | 0 | 0 |
| Operações duplicadas aplicadas | 0 | 0 |
| Bloqueio aguardando servidor | nunca | nunca |
| Recuperação após reconexão | automática | automática e sem snapshot completo |

## Requisitos obrigatórios

- Atualização otimista local.
- Broadcast entre abas do mesmo navegador.
- Canal de tempo real entre dispositivos.
- Fila persistente offline.
- Operações idempotentes com identificador único.
- Revisão autoritativa no servidor.
- Presença de usuários.
- Reconciliação automática.
- Proteção da célula que está sendo editada.
- Operações estruturais preparadas para concorrência.
- Checkpoints e deltas para evitar baixar a planilha inteira.

## Cenários obrigatórios de benchmark

### Cenário R1 — Dois usuários

- Dois usuários editando células diferentes durante 10 minutos.
- Nenhuma operação perdida ou duplicada.

### Cenário R2 — Conflito na mesma célula

- Dois usuários alterando a mesma célula quase simultaneamente.
- O resultado final deve seguir uma regra previsível e auditável.

### Cenário R3 — Alta concorrência

- 20 usuários realizando edições contínuas.
- Medir p50, p95 e p99 da propagação.

### Cenário R4 — Queda de conexão

- Um usuário permanece offline por 5 minutos.
- Realiza alterações.
- Reconecta.
- Todas as operações devem ser reconciliadas sem perda.

### Cenário R5 — Lacuna de revisão

- Simular perda temporária de eventos.
- Recuperar apenas o delta ou os chunks necessários.
- Evitar snapshot completo sempre que possível.

---

# 4. Metas de consumo de RAM

## Objetivo

Medir, comparar e reduzir o consumo de memória de cada planilha, cadeia e componente interno.

O painel de desempenho deve permitir identificar qual planilha consome mais RAM e por quê.

## Indicadores por planilha

- RAM total atribuída.
- Dados de células carregados.
- Células preenchidas.
- Células visíveis.
- Chunks ativos.
- Chunks no cache local.
- Motor de fórmulas.
- Grafo de dependências.
- Resultados intermediários.
- Histórico de desfazer/refazer.
- Operações pendentes.
- Elementos DOM ativos.
- Taxa de acerto do cache.
- Custo estimado de reconstrução.
- Tempo médio de cálculo.
- Tempo médio de renderização.

## Metas arquiteturais

| Regra | Meta |
|---|---|
| Células DOM permanentes | somente área visível + margem de virtualização |
| Células vazias armazenadas | não armazenar individualmente |
| Carregamento | por chunks e por subgrafo |
| Dados fora do uso atual | descartáveis da RAM |
| Resultados pequenos e caros | priorizar permanência em cache |
| Resultados grandes e baratos | priorizar descarte |
| Planilha vazia | estrutura esparsa, sem matriz completa de `null` |
| Crescimento de RAM | proporcional aos dados realmente usados |

## Painel comparativo esperado

| Planilha | RAM | Cálculo médio | Renderização | Cache hit | Fórmulas | Nós do grafo |
|---|---:|---:|---:|---:|---:|---:|
| Financeiro | — | — | — | — | — | — |
| Estoque | — | — | — | — | — | — |
| Produção | — | — | — | — | — | — |

## Alertas automáticos

O sistema deve avisar quando detectar:

- excesso de células vazias carregadas;
- excesso de elementos DOM;
- fórmulas lendo intervalos inteiros sem necessidade;
- baixa reutilização do cache;
- cadeias circulares;
- histórico consumindo memória excessiva;
- resultados intermediários duplicados;
- snapshots completos frequentes;
- chunks grandes demais;
- planilha com desempenho pior após uma alteração de código.

---

# 5. Metas de roles e permissões

## Objetivo

Permitir que cada projeto defina exatamente o que cada usuário pode visualizar, editar, executar, exportar, criar ou excluir.

## Roles padrão

- `viewer`
- `editor`
- `admin`
- `owner`

Essas roles devem continuar existindo como modelos iniciais, mas não podem limitar o sistema.

## Modelo final

Uma role deve ser um conjunto de capacidades configuráveis.

### Capacidades mínimas

```text
project.view
project.rename
project.delete

workbook.create
workbook.view
workbook.rename
workbook.delete
workbook.export

sheet.create
sheet.view
sheet.edit
sheet.delete

cell.edit
formula.edit
format.edit
structure.edit

automation.view
automation.edit
automation.run

members.view
members.manage
roles.manage

data.import
data.export
history.view
history.restore
```

## Escopos de permissão

As permissões devem poder valer para:

- projeto inteiro;
- planilha;
- aba;
- tabela;
- visualização;
- coluna;
- intervalo;
- registro;
- registros pertencentes ao próprio usuário;
- ação específica.

## Metas de segurança

| Teste | Meta |
|---|---|
| Ação sem permissão bloqueada no backend | 100% |
| Ação sem permissão ocultada ou desabilitada na interface | 100% |
| Mudança de role refletida | até 5 s inicialmente |
| Tentativa negada auditada | 100% |
| Owner removido acidentalmente | impossível |
| Permissão apenas visual aplicada | sem possibilidade de edição por API |

---

# 6. Telemetria obrigatória

Toda versão relevante deve registrar:

- tempo de abertura;
- tempo de cálculo;
- tempo de renderização;
- quantidade de nós recalculados;
- quantidade de células renderizadas;
- tamanho das operações;
- latência local;
- latência remota p50, p95 e p99;
- falhas de sincronização;
- snapshots completos;
- consumo de RAM;
- tamanho dos caches;
- taxa de acerto do cache;
- operações perdidas ou duplicadas;
- violações de permissão bloqueadas.

---

# 7. Ambiente padrão de benchmark

Todo resultado deve informar:

- commit testado;
- navegador e versão;
- sistema operacional;
- processador;
- RAM disponível;
- latência de rede simulada;
- quantidade de usuários;
- quantidade de células preenchidas;
- quantidade de fórmulas;
- quantidade de dependências;
- tamanho da planilha;
- estado do cache;
- média de pelo menos 5 execuções;
- p50, p95 e p99 quando aplicável.

Resultados sem essas informações não devem ser usados como comparação oficial.

---

# 8. Critérios de aprovação por fase

## Fase 1 — Instrumentação

- Painel de telemetria funcionando.
- Tempo de cálculo medido.
- Tempo de renderização medido.
- Latência de colaboração medida.
- RAM estimada por componente.

## Fase 2 — Grade e cálculo incremental

- Grade virtualizada.
- Estrutura esparsa.
- Renderização somente das células afetadas e visíveis.
- Nenhuma matriz completa de células vazias.
- Grafo de dependências mensurável.

## Fase 3 — Colaboração robusta

- Operações idempotentes.
- Reconexão sem perda.
- Teste com 20 usuários aprovado.
- Recuperação por delta ou chunks.
- Métricas p50, p95 e p99 dentro das metas.

## Fase 4 — RAM e cadeias

- Comparação entre planilhas.
- Cache por custo e frequência.
- Descarte de chunks inativos.
- Reutilização de resultados intermediários.
- Alertas de regressão de memória.

## Fase 5 — Permissões configuráveis

- Roles personalizadas.
- Capacidades configuráveis.
- Escopos por recurso.
- Auditoria de ações permitidas e negadas.
- Validação integral no backend.

---

# 9. Regra de regressão

Uma alteração não deve ser aprovada quando provocar qualquer uma destas condições sem justificativa explícita:

- aumento superior a 10% no tempo de cálculo;
- aumento superior a 10% no tempo de renderização;
- aumento superior a 10% no consumo de RAM;
- piora superior a 20 ms na latência remota p95;
- surgimento de operações perdidas ou duplicadas;
- necessidade de snapshot completo em cenário antes resolvido por delta;
- quebra de qualquer permissão existente.

---

# 10. Objetivo final

O Excel Empresarial deve entregar:

```text
Cálculo
→ incremental, sob demanda e orientado a grafos

Colaboração
→ otimista, multicanal e sem bloquear a interface

RAM
→ mensurável, comparável e proporcional ao uso real

Permissões
→ configuráveis por capacidade e por recurso
```

O sucesso do projeto não será medido pela quantidade de funcionalidades adicionadas, mas pela capacidade de executar fluxos empresariais complexos com baixa latência, baixo consumo de memória, colaboração confiável e controle preciso de acesso.
