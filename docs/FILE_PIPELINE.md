# Pipeline de arquivos

O Super Excel organiza arquivos empresariais em quatro etapas obrigatórias:

1. **Base de entrada** (`base` / `source`): visualização tabular de registros persistidos no banco relacional. Não aceita fórmulas.
2. **Planilhas de cálculo** (`spreadsheet` / `calculation`): camada responsável pelas fórmulas e regras de negócio.
3. **Base tratada** (`base` / `treated`): registros já calculados e estabilizados para consumo. Não aceita fórmulas.
4. **Elementar** (`elementar` / `publication`): transforma dados tratados em JSON publicado para sites e integrações.

A Base de entrada e a Base tratada usam o mesmo motor relacional. O estágio muda a responsabilidade do arquivo, não sua tecnologia.

## Direção permitida

```text
Base de entrada -> Planilhas -> Base tratada -> Elementar
```

Novas dependências devem avançar exatamente uma etapa. O objetivo é impedir cadeias arbitrárias entre planilhas, reduzir recálculos repetidos e manter as regras de negócio concentradas na camada de cálculo.
