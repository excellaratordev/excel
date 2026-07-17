# Test Time

O **Test Time** mede quanto tempo uma alteração leva para aparecer nas quatro fases do pipeline:

```text
1. Base → 2. Planilha → 3. Base 2 → 4. Elementar
```

## Como usar

1. Abra as quatro fases em abas diferentes.
2. Em qualquer aba, clique em **Test Time**.
3. Crie uma sessão.
4. Em cada aba, selecione uma célula ou intervalo e adicione um grupo à lista.
5. Inicie o teste.
6. Aguarde os grupos exibirem que estão monitorando.
7. Altere um valor na primeira fase.

Todas as abas usam a mesma sessão do projeto. A linha do tempo mostra:

- fase e arquivo;
- grupo monitorado;
- célula ou intervalo;
- horário do navegador com milissegundos fracionários;
- horário em que o PostgreSQL recebeu o evento;
- tempo desde o início do teste;
- diferença para o evento anterior.

## Seleção por fase

- **Base:** seleção diretamente sobre a grade relacional.
- **Planilha:** usa a seleção atual da planilha.
- **Base 2:** seleção diretamente sobre a grade relacional tratada.
- **Elementar:** seleciona as células de declaração e acompanha os respectivos valores do JSON ao vivo.

## Sincronização entre abas

O painel combina:

- `BroadcastChannel` para comunicação imediata entre abas do mesmo navegador;
- persistência compartilhada no PostgreSQL;
- atualização periódica para manter a linha do tempo consistente mesmo entre dispositivos diferentes.

## Tamanho dos grupos

Não existe limite artificial de células por grupo. O intervalo pode usar toda a área disponível na fase monitorada. O custo de leitura e comparação cresce conforme o tamanho da seleção.
