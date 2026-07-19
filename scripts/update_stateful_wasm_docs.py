from pathlib import Path


def replace_required(path: str, old: str, new: str) -> None:
    file_path = Path(path)
    content = file_path.read_text(encoding="utf-8")
    if old not in content:
        raise SystemExit(f"Trecho esperado não encontrado em {path}: {old[:100]!r}")
    file_path.write_text(content.replace(old, new, 1), encoding="utf-8")


replace_required(
    "README.md",
    "A aplicação usa **Flask**, **Supabase**, **HTML/CSS/JavaScript**, um **motor de fórmulas próprio** e uma primeira fatia funcional híbrida em **Rust/WebAssembly**.",
    "A aplicação usa **Flask**, **Supabase**, **HTML/CSS/JavaScript**, um **motor de fórmulas próprio** e um núcleo híbrido stateful em **Rust/WebAssembly** para fórmulas locais suportadas.",
)
replace_required(
    "README.md",
    "- O grafo, cache, invalidação transitiva, funções avançadas e referências externas continuam autoritativos no runtime JavaScript. Rust/Wasm já calcula uma fatia real de fórmulas locais, mas ainda não substitui o núcleo completo.",
    "- Rust/Wasm já mantém workbooks locais, dependências por célula, cache e invalidação transitiva para fórmulas suportadas. Funções avançadas, intervalos grandes, matrizes completas, referências externas, histórico, persistência e colaboração continuam autoritativos no JavaScript.",
)
replace_required(
    "README.md",
    """## Rust/WebAssembly — primeira fatia funcional

O diretório `wasm-engine/` contém um avaliador real de fórmulas locais em Rust compilado para WebAssembly. A integração é híbrida e segura: JavaScript continua disponível como fallback para qualquer recurso ainda não suportado.

Implementado:

- ABI versão `2` com entrada e saída JSON tipadas;
- parser e AST próprios em Rust;
- números, textos, booleanos, referências A1 e intervalos locais;
- operadores aritméticos, concatenação, percentual e comparações;
- matrizes e broadcasting básico;
- `SOMA`, `MÉDIA`, `MÍNIMO`, `MÁXIMO`, `CONT.NÚM`, `SE`, `E`, `OU`, `NÃO`, `SEERRO`, `ABS` e `ARRED`, com aliases em inglês;
- coleta das dependências locais utilizadas na avaliação;
- limite de 4.096 células por intervalo avaliado pelo núcleo experimental;
- binário versionado em `static/wasm/superexcel_wasm_engine.wasm`;
- testes Rust e execução real do módulo Wasm pelo Node na CI.

Modos disponíveis:

- `off`: somente JavaScript, modo padrão;
- `shadow`: JavaScript permanece autoritativo e Rust é comparado em segundo plano;
- `prefer`: Rust calcula fórmulas suportadas e recua automaticamente para JavaScript nas demais.

Exemplo:

```text
/sheet/123?wasm=shadow
/sheet/123?wasm=prefer
```

Ainda permanecem em JavaScript:

- grafo autoritativo, cache e invalidação transitiva;
- funções empresariais avançadas e matrizes dinâmicas completas;
- referências externas a Bases e Planilhas;
- spill autoritativo, undo/redo, persistência e colaboração.
""",
    """## Rust/WebAssembly — workbook stateful incremental

O diretório `wasm-engine/` contém um núcleo stateful em Rust compilado para WebAssembly. Para a fatia local suportada, ele mantém valores, fórmulas, dependências, cache e recálculo seletivo dentro do módulo Wasm. JavaScript continua disponível como referência e fallback.

Implementado:

- ABI versão `3` com entrada e saída JSON tipadas;
- parser e AST próprios em Rust;
- números, textos, booleanos, referências A1 e intervalos locais;
- operadores aritméticos, concatenação, percentual e comparações;
- funções básicas localizadas e aliases em inglês;
- workbooks identificados por handles;
- grafo reverso de dependências por célula;
- cache de resultados e invalidação transitiva seletiva;
- detecção de ciclos;
- alterações em lote, revisão e lista de células afetadas;
- métricas de cache, recálculo, atualizações e arestas;
- espelhamento das edições feitas no runtime JavaScript;
- reconstrução segura do espelho após undo/redo;
- limite de 4.096 células por intervalo e 100.000 células por workbook experimental;
- binário versionado em `static/wasm/superexcel_wasm_engine.wasm`;
- testes Rust e execução real do módulo Wasm pelo Node na CI.

Modos disponíveis:

- `off`: somente JavaScript, modo padrão;
- `shadow`: JavaScript permanece autoritativo e Rust é comparado em segundo plano;
- `prefer`: células escalares suportadas são lidas do workbook Rust e recursos não suportados voltam automaticamente ao JavaScript.

Exemplo:

```text
/sheet/123?wasm=shadow
/sheet/123?wasm=prefer
```

Ainda permanecem em JavaScript:

- funções empresariais avançadas e matrizes dinâmicas completas;
- dependências de intervalos grandes com indexação especializada;
- referências externas a Bases e Planilhas;
- spill autoritativo, histórico, persistência, snapshots e colaboração.
""",
)

replace_required(
    "docs/CURRENT_STATUS.md",
    "- motor de fórmulas próprio, com runtime JavaScript autoritativo e uma primeira fatia híbrida em Rust/WebAssembly;",
    "- motor de fórmulas próprio, com runtime JavaScript de referência e workbook Rust/WebAssembly stateful para a fatia local suportada;",
)
replace_required(
    "docs/CURRENT_STATUS.md",
    "O núcleo funcional está operante, mas a arquitetura ainda está em transição. Rust/WebAssembly já possui parser, AST e avaliação real de uma parte das fórmulas locais, porém grafo, cache, funções avançadas, referências externas e estado autoritativo da planilha continuam no runtime JavaScript.",
    "O núcleo funcional está operante, mas a arquitetura ainda está em transição. Rust/WebAssembly já possui parser, AST, workbooks locais, grafo por célula, cache e invalidação transitiva para a fatia suportada. Funções avançadas, matrizes completas, referências externas, histórico, persistência e colaboração continuam no runtime JavaScript.",
)
replace_required(
    "docs/CURRENT_STATUS.md",
    "O runtime JavaScript em `static/js/calculation/` permanece autoritativo. O navegador pode carregar o avaliador Rust/Wasm em modo `shadow` para comparação ou `prefer` para usar Rust apenas nas fórmulas já suportadas, sempre com fallback automático.",
    "O runtime JavaScript em `static/js/calculation/` permanece como referência geral. O navegador pode manter um workbook Rust/Wasm stateful em modo `shadow` para comparação ou `prefer` para usar valores escalares suportados, sempre com fallback automático.",
)
replace_required(
    "docs/CURRENT_STATUS.md",
    "- primeira fatia funcional em Rust/Wasm para fórmulas locais.",
    "- workbook Rust/Wasm stateful com grafo local, cache e invalidação seletiva para fórmulas suportadas.",
)
replace_required(
    "docs/CURRENT_STATUS.md",
    """## Rust/WebAssembly

O crate em `wasm-engine/` implementa atualmente:

- ABI versão 2;
- alocação e desalocação de memória;
- validação estrutural de envelopes JSON;
- parser e AST próprios em Rust;
- avaliação de números, textos, booleanos, referências A1 e intervalos locais;
- operadores aritméticos, concatenação, percentual e comparações;
- matrizes e broadcasting básico;
- funções `SOMA`, `MÉDIA`, `MÍNIMO`, `MÁXIMO`, `CONT.NÚM`, `SE`, `E`, `OU`, `NÃO`, `SEERRO`, `ABS` e `ARRED`, com aliases em inglês;
- coleta de dependências locais;
- build para `wasm32-unknown-unknown` e execução real do binário na CI;
- integração no navegador com modos `off`, `shadow` e `prefer`.

Ainda não foram migrados para Rust/Wasm:

- grafo autoritativo, cache e invalidação transitiva;
- referências externas a Bases e Planilhas;
- funções empresariais avançadas e matrizes dinâmicas completas;
- spill autoritativo, undo/redo, persistência e colaboração.

O modo padrão permanece `off`. Em `shadow`, JavaScript continua autoritativo e divergências são registradas. Em `prefer`, fórmulas suportadas usam Rust e qualquer recurso não suportado retorna ao JavaScript.
""",
    """## Rust/WebAssembly

O crate em `wasm-engine/` implementa atualmente:

- ABI versão 3;
- alocação e desalocação de memória;
- validação estrutural de envelopes JSON;
- parser e AST próprios em Rust;
- avaliação de números, textos, booleanos, referências A1 e intervalos locais;
- operadores aritméticos, concatenação, percentual e comparações;
- funções básicas localizadas e aliases em inglês;
- registro de workbooks por handles;
- armazenamento de valores e fórmulas locais;
- grafo reverso de dependências por célula;
- cache, detecção de ciclos e invalidação transitiva seletiva;
- alterações em lote, revisão e lista de afetados;
- métricas de cache, recálculo, atualizações e arestas;
- build para `wasm32-unknown-unknown` e execução real do binário na CI;
- integração no navegador com modos `off`, `shadow` e `prefer`.

Ainda não foram migrados para Rust/Wasm:

- dependências de intervalos grandes sem expansão célula por célula;
- referências externas a Bases e Planilhas;
- funções empresariais avançadas e matrizes dinâmicas completas;
- spill autoritativo, histórico, persistência, snapshots e colaboração.

O modo padrão permanece `off`. Em `shadow`, JavaScript continua como resultado autoritativo e divergências são registradas. Em `prefer`, células escalares suportadas usam o workbook Rust e qualquer recurso não suportado retorna ao JavaScript.
""",
)

replace_required(
    "docs/ARCHITECTURE.md",
    """## Rust/WebAssembly: situação real

O crate `wasm-engine/` existe e é compilado pela CI, mas seu escopo é experimental:

- ABI versão 1;
- alocação e desalocação;
- validação superficial de envelopes de operações;
- contratos demonstrativos de tipos de célula em Rust.

Ainda não foram migrados parser, AST, grafo, biblioteca de funções, cache, recálculo incremental, funções dinâmicas ou interoperabilidade completa com o runtime JavaScript. Portanto, JavaScript continua sendo a implementação de referência e de produção.
""",
    """## Rust/WebAssembly: situação real

O crate `wasm-engine/` é compilado pela CI e contém um núcleo experimental stateful:

- ABI versão 3;
- parser e AST em Rust;
- avaliação de fórmulas locais suportadas;
- workbooks identificados por handles;
- grafo reverso de dependências por célula;
- cache de resultados, detecção de ciclos e invalidação transitiva;
- alterações em lote, revisão, lista de afetados e métricas;
- integração `off`, `shadow` e `prefer` com fallback JavaScript.

O grafo Rust atual expande intervalos locais dentro do limite experimental e ainda não substitui funções avançadas, matrizes completas, referências externas, histórico, persistência ou colaboração. JavaScript permanece como referência geral e fallback.
""",
)
replace_required(
    "docs/ARCHITECTURE.md",
    "| Motor completo Rust/Wasm | Não implementado |",
    "| Workbook Rust/Wasm local stateful | Implementado parcialmente; modo padrão ainda é `off` |\n| Motor completo Rust/Wasm | Não implementado |",
)
replace_required(
    "docs/ARCHITECTURE.md",
    "### 4. Avaliar Rust/Wasm com evidência\n\nQualquer adoção exige contrato estruturado, parser e AST equivalentes, avaliação escalar, grafo, biblioteca de funções, intervalos, benchmarks comparativos, feature flag e rollback para o runtime JavaScript.",
    "### 4. Expandir Rust/Wasm com evidência\n\nA base stateful já existe. A ampliação exige IR compartilhada, paridade semântica, funções empresariais, intervalos indexados, matrizes, referências externas, benchmarks comparativos, feature flag e rollback para o runtime JavaScript.",
)
