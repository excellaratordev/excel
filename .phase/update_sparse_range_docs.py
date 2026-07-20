from pathlib import Path

path = Path(__file__).resolve().parents[1] / "docs/RUST_WASM_ROADMAP.md"
text = path.read_text(encoding="utf-8")
text = text.replace(
    "## Fase 4 — grafo de intervalos grandes\n\nEstado: **implementado nesta entrega**.",
    "## Fase 4 — grafo de intervalos grandes\n\nEstado: **implementado**.",
    1,
)
text = text.replace(
    "- o índice compacta o grafo, mas a avaliação ainda percorre e materializa as posições do intervalo até o limite stateful.",
    "- o índice compacta o grafo; a materialização densa do cálculo foi eliminada posteriormente na Fase 5.",
    1,
)
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
if marker not in text:
    raise RuntimeError("roadmap sparse phase marker not found")
text = text.replace(marker, replacement, 1)
text = text.replace("## Fase 6 — runtime autoritativo", "## Fase 7 — runtime autoritativo", 1)
path.write_text(text, encoding="utf-8")
