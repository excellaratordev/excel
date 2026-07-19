# Rust/Wasm do Super Excel — protótipo experimental

## Status atual

Este crate está em estágio **embrionário**. Ele existe para testar uma fronteira mínima entre JavaScript e WebAssembly, mas ainda não contém um motor de cálculo e não é usado para avaliar fórmulas em produção.

O runtime autoritativo atual continua em `static/js/calculation/`.

## O que existe

A versão atual implementa apenas uma ABI experimental identificada como `1`:

- `superexcel_abi_version() -> u32`
- `superexcel_alloc(len) -> pointer`
- `superexcel_dealloc(pointer, len)`
- `superexcel_validate_operation(pointer, len) -> 0 | 1`

O adaptador do navegador está em `static/js/wasm/engine-contract.js`. Ele instancia um módulo Wasm, confere a versão da ABI, copia um envelope JSON UTF-8 para a memória linear e chama a função de validação.

O CI atualmente garante apenas que:

- os testes unitários básicos do crate passam;
- o crate compila para `wasm32-unknown-unknown`;
- um arquivo `.wasm` é produzido.

## Limitações importantes

`superexcel_validate_operation` não realiza parsing estrutural completo de JSON. A validação atual verifica somente tamanho, UTF-8, delimitadores externos e presença textual dos campos `id` e `kind`. Portanto, ela é uma prova de contrato de memória, não uma validação de negócio ou segurança.

Os tipos `CellValue`, `CellCoordinate` e `CellPatch` ainda são apenas modelos internos de demonstração. Eles não são serializados pela ABI, não alimentam a grade e não alteram o estado de uma planilha.

## O que ainda não existe

O crate ainda não implementa:

- tokenização e parser de fórmulas;
- AST ou representação intermediária;
- referências A1 e intervalos;
- grafo de dependências;
- invalidação e recálculo seletivos;
- biblioteca de funções;
- coerção de tipos e tratamento de erros;
- ciclos, cache, matrizes dinâmicas, undo e redo;
- persistência, colaboração ou sincronização;
- buffers binários compactos para lotes de células;
- integração com o runtime JavaScript;
- benchmarks de paridade ou superioridade;
- mecanismo de fallback e rollback.

## Critérios antes de uso real

Rust/Wasm só poderá substituir alguma parte do runtime JavaScript quando houver:

1. contrato de dados estruturado e versionado;
2. testes de semântica compartilhados entre JavaScript e Rust;
3. paridade funcional mensurável;
4. benchmarks reproduzíveis de latência e memória;
5. integração incremental, sem bloquear a interface;
6. compatibilidade com planilhas existentes;
7. fallback e rollback claros.

Até esses critérios serem atendidos, este diretório deve ser tratado como laboratório arquitetural, não como motor de produção.
