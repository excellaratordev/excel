from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path):
    return (ROOT / path).read_text(encoding="utf-8")


def write(path, content):
    (ROOT / path).write_text(content, encoding="utf-8")


def replace_once(content, old, new, label):
    if old not in content:
        raise RuntimeError(f"marker not found: {label}")
    return content.replace(old, new, 1)


# Main README.
path = "README.md"
text = read(path)
text = replace_once(text, "## Rust/WebAssembly — ABI 5, IR v2 e índice de intervalos", "## Rust/WebAssembly — ABI 6, IR v2 e avaliação esparsa", "README heading")
text = replace_once(text, "A ABI 5 expõe a IR JSON versão 2", "A ABI 6 mantém a IR JSON versão 2", "README ABI paragraph")
text = replace_once(text, "- ABI versão `5` e IR de fórmulas versão `2`;", "- ABI versão `6` e IR de fórmulas versão `2`;", "README ABI bullet")
text = replace_once(
    text,
    "- grafo reverso para referências diretas e índice de intervalos em buckets 256×32;\n- cache de resultados e invalidação transitiva seletiva;",
    "- grafo reverso para referências diretas e índice de intervalos em buckets 256×32;\n- índice ordenado de células ocupadas e avaliador esparso para ranges acima de 4.096 posições;\n- agregações simples resolvendo somente células ocupadas;\n- funções condicionais e buscas percorrendo posições sem construir matrizes densas;\n- cache de resultados e invalidação transitiva seletiva;",
    "README sparse bullets",
)
text = replace_once(
    text,
    "- métricas de cache, recálculo, atualizações e arestas;",
    "- métricas de cache, recálculo, arestas, ranges esparsos, células resolvidas e posições cuja materialização foi evitada;",
    "README metrics",
)
text = replace_once(
    text,
    "- avaliação stateless limitada a 4.096 posições; workbook stateful aceita intervalos de até 100.000 posições;",
    "- avaliação stateless limitada a 4.096 posições; workbook stateful aceita ranges de até 100.000 posições sem buffer denso para a fatia esparsa suportada;",
    "README range limits",
)
write(path, text)

# Crate README.
path = "wasm-engine/README.md"
text = read(path)
text = replace_once(text, "A ABI versão `5` implementa:", "A ABI versão `6` implementa:", "crate ABI state")
text = replace_once(text, "- IR JSON de fórmulas versão `1`;", "- IR JSON de fórmulas versão `2`, com referências diretas e retângulos separados;", "crate IR bullet")
text = replace_once(text, "- referências A1 e intervalos locais limitados a 4.096 células por fórmula;", "- referências A1 e ranges locais de até 4.096 posições no avaliador stateless e 100.000 no workbook stateful;", "crate range limits")
text = replace_once(
    text,
    "- grafo reverso para referências diretas e índice de intervalos em buckets 256×32;\n- cache de resultados por célula;",
    "- grafo reverso para referências diretas e índice de intervalos em buckets 256×32;\n- índice `BTreeMap` das células ocupadas por coordenada;\n- avaliador stateful esparso para ranges acima de 4.096 posições;\n- agregações simples que leem apenas células ocupadas;\n- critérios e buscas que preservam posições em branco sem criar matrizes densas;\n- cache de resultados por célula;",
    "crate sparse bullets",
)
text = replace_once(text, "- métricas de cache, recálculo, atualizações e arestas;", "- métricas de cache, recálculo, ranges esparsos, células resolvidas, posições percorridas e materialização evitada;", "crate metrics")
text = replace_once(text, "## ABI versão 5", "## ABI versão 6", "crate ABI heading")
text = replace_once(text, "## IR de fórmulas versão 1", "## IR de fórmulas versão 2", "crate IR heading")
text = replace_once(text, '  "ir_version": 1,\n  "dependencies": ["A1", "A2", "A3", "B1", "B2", "B3", "C1", "C2", "C3"],', '  "ir_version": 2,\n  "dependencies": [],\n  "range_dependencies": [\n    {"top": 0, "bottom": 2, "left": 0, "right": 0},\n    {"top": 0, "bottom": 2, "left": 1, "right": 1},\n    {"top": 0, "bottom": 2, "left": 2, "right": 2}\n  ],', "crate IR example")
text = replace_once(
    text,
    "Ao consultar uma fórmula, o núcleo reutiliza o cache quando válido, resolve apenas as dependências necessárias, detecta ciclos e invalida somente a célula alterada e seus dependentes transitivos.",
    "Ao consultar uma fórmula, o núcleo reutiliza o cache quando válido, resolve apenas as dependências necessárias, detecta ciclos e invalida somente a célula alterada e seus dependentes transitivos. Para ranges grandes, `SOMA`, `MÉDIA`, `MÍNIMO`, `MÁXIMO` e `CONT.NÚM` visitam somente células ocupadas. Funções condicionais e buscas preservam índices implícitos em branco por streaming, sem alocar uma matriz com 100.000 elementos.",
    "crate sparse explanation",
)
write(path, text)

# Current status.
path = "docs/CURRENT_STATUS.md"
text = read(path)
text = replace_once(text, "- ABI versão 5 e IR de fórmulas versão 2;", "- ABI versão 6 e IR de fórmulas versão 2;", "status ABI")
text = replace_once(
    text,
    "- grafo reverso de referências diretas e índice de intervalos em buckets 256×32;\n- cache, detecção de ciclos e invalidação transitiva seletiva;",
    "- grafo reverso de referências diretas e índice de intervalos em buckets 256×32;\n- índice ordenado de células ocupadas e avaliação esparsa de ranges grandes;\n- agregações simples que ignoram posições vazias sem materializá-las;\n- critérios e buscas por streaming posicional sem buffer denso;\n- cache, detecção de ciclos e invalidação transitiva seletiva;",
    "status sparse bullets",
)
text = replace_once(text, "- métricas de cache, recálculo, atualizações e arestas;", "- métricas de cache, recálculo, arestas, ranges esparsos, células resolvidas e posições evitadas/percorridas;", "status metrics")
write(path, text)

# Architecture.
path = "docs/ARCHITECTURE.md"
text = read(path)
text = replace_once(text, "- ABI versão 5 e IR de fórmulas versão 2;", "- ABI versão 6 e IR de fórmulas versão 2;", "architecture ABI")
text = replace_once(
    text,
    "- grafo reverso de referências diretas e índice de intervalos em buckets 256×32;\n- cache de resultados, detecção de ciclos e invalidação transitiva;",
    "- grafo reverso de referências diretas e índice de intervalos em buckets 256×32;\n- índice ordenado de células ocupadas e avaliador esparso para ranges grandes;\n- agregações sobre células ocupadas e streaming posicional para critérios/buscas;\n- cache de resultados, detecção de ciclos e invalidação transitiva;",
    "architecture sparse bullets",
)
text = replace_once(
    text,
    "O grafo Rust não expande intervalos em arestas por célula; ele seleciona candidatos por bucket e confirma a sobreposição exata. A IR não cobre referências externas, e o núcleo ainda não substitui matrizes dinâmicas, spill, intervalos grandes indexados, histórico, persistência ou colaboração.",
    "O grafo Rust não expande intervalos em arestas por célula; ele seleciona candidatos por bucket e confirma a sobreposição exata. O avaliador stateful também evita buffers densos em ranges grandes: agregações simples visitam somente células ocupadas, enquanto critérios e buscas percorrem posições implicitamente. A IR não cobre referências externas, e o núcleo ainda não substitui matrizes dinâmicas, spill, histórico, persistência ou colaboração.",
    "architecture reality paragraph",
)
text = replace_once(text, "| Workbook Rust/Wasm local stateful e IR v1 |", "| Workbook Rust/Wasm local stateful, IR v2 e ranges esparsos |", "architecture maturity")
text = replace_once(text, "- a IR versão 1 cobre fórmulas locais", "- a IR versão 2 cobre fórmulas locais e ranges compactos", "architecture IR frontier")
text = replace_once(text, "A base stateful, a IR v1 e as funções empresariais iniciais já existem. A próxima ampliação exige buffers compactos,", "A base stateful, a IR v2, as funções empresariais e a avaliação esparsa de ranges já existem. A próxima ampliação exige buffers tipados para resultados matriciais,", "architecture next frontier")
write(path, text)

# Roadmap.
path = "docs/RUST_WASM_ROADMAP.md"
text = read(path)
text = replace_once(text, "## Fase 3 — IR compartilhada e funções empresariais\n\nEstado: **implementado nesta entrega**.", "## Fase 3 — IR compartilhada e funções empresariais\n\nEstado: **implementado**.", "roadmap phase 3")
text = replace_once(text, "## Fase 4 — grafo de intervalos grandes\n\nEstado: **implementado nesta entrega**.", "## Fase 4 — grafo de intervalos grandes\n\nEstado: **implementado**.", "roadmap phase 4")
marker = """Critério de saída atingido: um intervalo de 100.000 posições usa um descritor de dependência e menos de 512 buckets, preservando recálculo seletivo.

## Fase 5 — matrizes, spill e referências externas"""
replacement = """Critério de saída atingido: um intervalo de 100.000 posições usa um descritor de dependência e menos de 512 buckets, preservando recálculo seletivo.

## Fase 5 — avaliação esparsa de ranges

Estado: **implementado nesta entrega**.

- ABI versão 6, mantendo IR versão 2;
- índice ordenado das células ocupadas por coordenada;
- dispatch automático para o avaliador stateful esparso acima de 4.096 posições;
- `SOMA`, `MÉDIA`, `MÍNIMO`, `MÁXIMO` e `CONT.NÚM` visitando somente células ocupadas;
- funções condicionais e buscas preservando posições vazias por streaming;
- fallback explícito para operações matriciais grandes ainda não suportadas;
- métricas de ranges esparsos, células resolvidas, posições percorridas e materialização evitada.

Critério de saída atingido: `SOMA(A1:A100000)` com duas células ocupadas resolve apenas essas duas células e registra pelo menos 99.998 posições cuja materialização foi evitada; `SOMASES` mantém a semântica posicional sem criar matriz densa.

## Fase 6 — matrizes, spill e referências externas"""
text = replace_once(text, marker, replacement, "roadmap sparse phase")
text = replace_once(text, "## Fase 6 — runtime autoritativo", "## Fase 7 — runtime autoritativo", "roadmap runtime phase")
write(path, text)
