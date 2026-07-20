from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def update(path, replacements):
    target = ROOT / path
    text = target.read_text(encoding="utf-8")
    for old, new, label in replacements:
        if old not in text:
            raise RuntimeError(f"marker not found in {path}: {label}")
        text = text.replace(old, new, 1)
    target.write_text(text, encoding="utf-8")


update("README.md", [
    ("## Rust/WebAssembly — ABI 6, IR v2 e avaliação esparsa", "## Rust/WebAssembly — ABI 7, IR v2, matrizes dinâmicas e spill verificável", "heading"),
    ("A ABI 6 mantém a IR JSON versão 2", "A ABI 7 mantém a IR JSON versão 2", "ABI paragraph"),
    ("- ABI versão `6` e IR de fórmulas versão `2`;", "- ABI versão `7` e IR de fórmulas versão `2`;", "ABI bullet"),
    ("- buscas `PROCV`, `PROCX`, `ÍNDICE` e `CORRESP`;", "- buscas `PROCV`, `PROCX`, `ÍNDICE` e `CORRESP`;\n- matrizes dinâmicas `FILTRO`, `ÚNICO` e `CLASSIFICAR`, com aliases em inglês;\n- resultados matriciais tipados de até 10.000 células;\n- plano de spill `ready`, `blocked` ou `scalar`, com área, matriz e células bloqueadoras;", "dynamic bullets"),
    ("- métricas de cache, recálculo, arestas, ranges esparsos, células resolvidas e posições cuja materialização foi evitada;", "- métricas de cache, recálculo, arestas, ranges esparsos, células resolvidas, spill planejado e conflitos;", "metrics"),
    ("- funções de matrizes dinâmicas completas, como `FILTRO`, `ÚNICO` e `CLASSIFICAR`;\n- referências externas a Bases e Planilhas;\n- spill autoritativo, histórico, persistência, snapshots e colaboração.", "- aplicação autoritativa do spill na grade e propagação de seus alvos pelo Rust;\n- matrizes dinâmicas acima dos limites experimentais e operações matriciais ainda não cobertas;\n- referências externas a Bases e Planilhas;\n- histórico, persistência, snapshots e colaboração.", "remaining JS"),
])

update("docs/CURRENT_STATUS.md", [
    ("- ABI versão 6 e IR de fórmulas versão 2;", "- ABI versão 7 e IR de fórmulas versão 2;", "ABI"),
    ("- `PROCV`, `PROCX`, `ÍNDICE` e `CORRESP`;", "- `PROCV`, `PROCX`, `ÍNDICE` e `CORRESP`;\n- `FILTRO`, `ÚNICO` e `CLASSIFICAR` com retorno matricial tipado;\n- plano stateful de spill com dimensões, área, matriz, bloqueadores e `#DESPEJAR!`;", "dynamic functions"),
    ("- métricas de cache, recálculo, arestas, ranges esparsos, células resolvidas e posições evitadas/percorridas;", "- métricas de cache, recálculo, arestas, ranges esparsos, células resolvidas, planos de spill e conflitos;", "metrics"),
    ("- matrizes dinâmicas completas e spill autoritativo;", "- aplicação autoritativa do spill pelo Rust e matrizes dinâmicas acima dos limites experimentais;", "remaining dynamic"),
])

update("docs/ARCHITECTURE.md", [
    ("- ABI versão 6 e IR de fórmulas versão 2;", "- ABI versão 7 e IR de fórmulas versão 2;", "ABI"),
    ("- avaliação de fórmulas locais básicas, condicionais e de busca;", "- avaliação de fórmulas locais básicas, condicionais, de busca e matrizes dinâmicas `FILTRO`, `ÚNICO` e `CLASSIFICAR`;", "dynamic evaluation"),
    ("- alterações em lote, revisão, lista de afetados e métricas;", "- plano de spill verificável com área, dimensões, matriz e bloqueadores, sem assumir a aplicação na grade;\n- alterações em lote, revisão, lista de afetados e métricas;", "spill architecture"),
    ("A IR não cobre referências externas, e o núcleo ainda não substitui matrizes dinâmicas, spill, histórico, persistência ou colaboração.", "A IR não cobre referências externas. O núcleo já calcula a primeira fatia de matrizes dinâmicas e detecta conflitos de spill, mas o JavaScript ainda aplica o spill na grade e permanece autoritativo para histórico, persistência e colaboração.", "reality paragraph"),
    ("| Workbook Rust/Wasm local stateful, IR v2 e ranges esparsos | Implementado parcialmente; inclui funções empresariais, mas o modo padrão ainda é `off` |", "| Workbook Rust/Wasm stateful, IR v2, ranges esparsos e plano de spill | Implementado parcialmente; matrizes dinâmicas iniciais existem, mas o modo padrão ainda é `off` |", "maturity"),
    ("A base stateful, a IR v2, as funções empresariais e a avaliação esparsa de ranges já existem. A próxima ampliação exige buffers tipados para resultados matriciais, matrizes dinâmicas, referências externas, benchmarks comparativos, feature flag e rollback para o runtime JavaScript.", "A base stateful, a IR v2, as funções empresariais, a avaliação esparsa e as matrizes dinâmicas iniciais já existem. A próxima ampliação exige tornar spill e seus alvos autoritativos, adicionar referências externas, benchmarks comparativos, feature flag e rollback para o runtime JavaScript.", "next frontier"),
])

update("docs/RUST_WASM_ROADMAP.md", [
    ("## Fase 5 — avaliação esparsa de ranges\n\nEstado: **implementado nesta entrega**.", "## Fase 5 — avaliação esparsa de ranges\n\nEstado: **implementado**.", "phase 5"),
    ("## Fase 6 — matrizes, spill e referências externas\n\nEstado: **planejado**.\n\n- `FILTRO`, `ÚNICO` e `CLASSIFICAR`;\n- broadcasting completo;\n- spill e conflitos de área;\n- referências externas a Bases e Planilhas;\n- IR com origem externa, revisão e tipos especializados;\n- valores tipados e buffers compactos;\n- invalidação seletiva de fontes externas por revisão.\n\nCritério de saída: matrizes e referências externas produzem os mesmos resultados, tipos e áreas afetadas do runtime JavaScript.", "## Fase 6 — matrizes, spill e referências externas\n\nEstado: **implementado parcialmente nesta entrega**.\n\nImplementado:\n\n- ABI versão 7, mantendo IR versão 2;\n- `FILTRO`, `ÚNICO` e `CLASSIFICAR` com aliases em inglês;\n- arrays tipados em avaliações stateless e stateful;\n- limite experimental de 10.000 células por matriz dinâmica ou spill;\n- export `superexcel_workbook_get_spill`;\n- plano `ready`, `blocked` ou `scalar`;\n- área, dimensões, matriz, valor da origem e lista de bloqueadores;\n- `#DESPEJAR!` quando a área possui células ocupadas;\n- métricas de planos e conflitos.\n\nAinda planejado:\n\n- aplicação autoritativa do spill e registro dos alvos no workbook Rust;\n- broadcasting completo para todas as operações;\n- referências externas a Bases e Planilhas;\n- IR com origem externa, revisão e tipos especializados;\n- invalidação seletiva de fontes externas por revisão.\n\nCritério parcial atingido: funções matriciais locais produzem arrays equivalentes ao JavaScript e o Rust identifica áreas de spill livres ou bloqueadas. O critério completo depende de spill autoritativo e referências externas.", "phase 6"),
    ("7. Matrizes não se tornam autoritativas enquanto spill e conflitos não estiverem implementados no núcleo.", "7. Matrizes não se tornam autoritativas enquanto o núcleo não aplicar o spill, registrar seus alvos e invalidá-los corretamente; o plano de conflito isolado não é suficiente.", "safety rule"),
])

update("wasm-engine/README.md", [
    ("A ABI versão `6` implementa:", "A ABI versão `7` implementa:", "ABI state"),
    ("- buscas `PROCV`, `PROCX`, `ÍNDICE` e `CORRESP`;", "- buscas `PROCV`, `PROCX`, `ÍNDICE` e `CORRESP`;\n- matrizes dinâmicas `FILTRO`, `ÚNICO` e `CLASSIFICAR`;\n- resultados `array` em JSON, limitados a 10.000 células;\n- plano de spill stateful com estados `ready`, `blocked` e `scalar`;\n- detecção de células bloqueadoras e retorno `#DESPEJAR!`;", "dynamic bullets"),
    ("- métricas de cache, recálculo, ranges esparsos, células resolvidas, posições percorridas e materialização evitada;", "- métricas de cache, recálculo, ranges esparsos, células resolvidas, planos de spill e conflitos;", "metrics"),
    ("## ABI versão 6", "## ABI versão 7", "ABI heading"),
    ("superexcel_workbook_get_cell(handle, pointer, len) -> result_pointer\nsuperexcel_workbook_stats(handle) -> result_pointer", "superexcel_workbook_get_cell(handle, pointer, len) -> result_pointer\nsuperexcel_workbook_get_spill(handle, pointer, len) -> result_pointer\nsuperexcel_workbook_stats(handle) -> result_pointer", "spill export"),
    ("Após `undo` ou `redo`, o espelho Rust é reconstruído a partir do estado serializado pelo runtime JavaScript. O handle também é destruído quando o runtime é encerrado ou o modo Wasm volta para `off`.", "Após `undo` ou `redo`, o espelho Rust é reconstruído a partir do estado serializado pelo runtime JavaScript. O handle também é destruído quando o runtime é encerrado ou o modo Wasm volta para `off`.\n\nPara matrizes locais, o workbook pode retornar o array completo e gerar um plano de spill. O plano informa área, dimensões e bloqueadores, mas não escreve os valores derivados nas células-alvo. Essa aplicação continua no runtime JavaScript.", "spill explanation"),
    ("- `FILTRO`, `ÚNICO`, `CLASSIFICAR` e demais matrizes dinâmicas completas;\n- referências externas a Bases e Planilhas;\n- spill autoritativo;", "- demais matrizes dinâmicas e operações acima dos limites experimentais;\n- referências externas a Bases e Planilhas;\n- aplicação autoritativa do spill e registro dos alvos pelo Rust;", "limits"),
    ("- até 10.000 alterações por lote.", "- até 10.000 alterações por lote;\n- até 10.000 células por matriz dinâmica ou plano de spill.", "safety limit"),
])
