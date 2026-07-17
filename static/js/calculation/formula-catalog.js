(() => {
  'use strict';

  const items = [
    {
      name: 'SOMA', aliases: ['SUM'], category: 'Matemática',
      description: 'Soma números, células ou intervalos.',
      syntax: 'SOMA(número1; [número2]; ...)',
      example: '=SOMA(B2:B20)',
    },
    {
      name: 'MÉDIA', aliases: ['AVERAGE'], category: 'Matemática',
      description: 'Calcula a média aritmética dos valores numéricos.',
      syntax: 'MÉDIA(número1; [número2]; ...)',
      example: '=MÉDIA(B2:B20)',
    },
    {
      name: 'MÁXIMO', aliases: ['MAX'], category: 'Matemática',
      description: 'Retorna o maior valor numérico.',
      syntax: 'MÁXIMO(número1; [número2]; ...)',
      example: '=MÁXIMO(B2:B20)',
    },
    {
      name: 'MÍNIMO', aliases: ['MIN'], category: 'Matemática',
      description: 'Retorna o menor valor numérico.',
      syntax: 'MÍNIMO(número1; [número2]; ...)',
      example: '=MÍNIMO(B2:B20)',
    },
    {
      name: 'SE', aliases: ['IF'], category: 'Lógica',
      description: 'Retorna um resultado quando a condição é verdadeira e outro quando é falsa.',
      syntax: 'SE(condição; valor_se_verdadeiro; valor_se_falso)',
      example: '=SE(B2>=1000;"Meta atingida";"Abaixo da meta")',
    },
    {
      name: 'SES', aliases: ['IFS'], category: 'Lógica',
      description: 'Testa várias condições em sequência e retorna o primeiro resultado verdadeiro.',
      syntax: 'SES(condição1; resultado1; [condição2; resultado2]; ...)',
      example: '=SES(B2>=1000;"Alta";B2>=500;"Média";VERDADEIRO();"Baixa")',
    },
    {
      name: 'E', aliases: ['AND'], category: 'Lógica',
      description: 'Retorna verdadeiro somente quando todas as condições são verdadeiras.',
      syntax: 'E(condição1; [condição2]; ...)',
      example: '=E(B2>0;C2="Pago")',
    },
    {
      name: 'OU', aliases: ['OR'], category: 'Lógica',
      description: 'Retorna verdadeiro quando pelo menos uma condição é verdadeira.',
      syntax: 'OU(condição1; [condição2]; ...)',
      example: '=OU(C2="Pago";C2="Parcial")',
    },
    {
      name: 'SEERRO', aliases: ['IFERROR'], category: 'Lógica',
      description: 'Substitui o resultado quando a expressão produz um erro.',
      syntax: 'SEERRO(valor; valor_se_erro)',
      example: '=SEERRO(A2/B2;0)',
    },
    {
      name: 'CONT.NÚM', aliases: ['COUNT'], category: 'Contagem',
      description: 'Conta somente células que contêm números.',
      syntax: 'CONT.NÚM(valor1; [valor2]; ...)',
      example: '=CONT.NÚM(B2:B100)',
    },
    {
      name: 'CONT.VALORES', aliases: ['COUNTA'], category: 'Contagem',
      description: 'Conta todas as células não vazias.',
      syntax: 'CONT.VALORES(valor1; [valor2]; ...)',
      example: '=CONT.VALORES(A2:A100)',
    },
    {
      name: 'CONT.SE', aliases: ['COUNTIF'], category: 'Contagem',
      description: 'Conta células que atendem a um critério.',
      syntax: 'CONT.SE(intervalo; critério)',
      example: '=CONT.SE(C2:C100;"Pago")',
    },
    {
      name: 'CONT.SES', aliases: ['COUNTIFS'], category: 'Contagem',
      description: 'Conta linhas que atendem a vários critérios ao mesmo tempo.',
      syntax: 'CONT.SES(intervalo1; critério1; [intervalo2; critério2]; ...)',
      example: '=CONT.SES(C2:C100;"Pago";B2:B100;">1000")',
    },
    {
      name: 'SOMASE', aliases: ['SUMIF'], category: 'Condicional',
      description: 'Soma valores quando um intervalo atende ao critério informado.',
      syntax: 'SOMASE(intervalo_do_critério; critério; [intervalo_da_soma])',
      example: '=SOMASE(C2:C100;"Pago";B2:B100)',
    },
    {
      name: 'SOMASES', aliases: ['SUMIFS'], category: 'Condicional',
      description: 'Soma valores que atendem a vários critérios.',
      syntax: 'SOMASES(intervalo_da_soma; intervalo1; critério1; ...)',
      example: '=SOMASES(D2:D100;B2:B100;"Fortaleza";C2:C100;"Pago")',
    },
    {
      name: 'MÉDIASE', aliases: ['AVERAGEIF'], category: 'Condicional',
      description: 'Calcula a média dos valores que atendem a um critério.',
      syntax: 'MÉDIASE(intervalo_do_critério; critério; [intervalo_da_média])',
      example: '=MÉDIASE(C2:C100;"William";B2:B100)',
    },
    {
      name: 'MÉDIASES', aliases: ['AVERAGEIFS'], category: 'Condicional',
      description: 'Calcula a média dos valores que atendem a vários critérios.',
      syntax: 'MÉDIASES(intervalo_da_média; intervalo1; critério1; ...)',
      example: '=MÉDIASES(D2:D100;B2:B100;"Fortaleza";C2:C100;"Pago")',
    },
    {
      name: 'PROCV', aliases: ['VLOOKUP'], category: 'Busca',
      description: 'Procura um valor na primeira coluna de uma tabela e retorna outra coluna.',
      syntax: 'PROCV(valor_procurado; tabela; índice_da_coluna; correspondência_aproximada)',
      example: '=PROCV(A2;F2:H20;3;FALSO())',
    },
    {
      name: 'PROCX', aliases: ['XLOOKUP'], category: 'Busca',
      description: 'Procura em um intervalo e retorna o valor correspondente de outro intervalo.',
      syntax: 'PROCX(valor_procurado; intervalo_de_busca; intervalo_de_retorno; [se_não_encontrado])',
      example: '=PROCX(A2;F2:F20;H2:H20;"Não encontrado")',
    },
    {
      name: 'ÍNDICE', aliases: ['INDEX'], category: 'Busca',
      description: 'Retorna o valor localizado em uma linha e coluna de um intervalo.',
      syntax: 'ÍNDICE(intervalo; linha; [coluna])',
      example: '=ÍNDICE(D2:D100;5)',
    },
    {
      name: 'CORRESP', aliases: ['MATCH'], category: 'Busca',
      description: 'Retorna a posição de um valor dentro de um intervalo.',
      syntax: 'CORRESP(valor_procurado; intervalo; [tipo_de_correspondência])',
      example: '=CORRESP(A2;F2:F100;0)',
    },
    {
      name: 'FILTRO', aliases: ['FILTER'], category: 'Matrizes',
      description: 'Retorna somente as linhas ou colunas que atendem à condição.',
      syntax: 'FILTRO(intervalo; condição; [se_vazio])',
      example: '=FILTRO(A2:D20;D2:D20="Pendente";"Sem resultados")',
    },
    {
      name: 'ÚNICO', aliases: ['UNIQUE'], category: 'Matrizes',
      description: 'Retorna valores ou linhas sem duplicidade.',
      syntax: 'ÚNICO(intervalo)',
      example: '=ÚNICO(B2:B20)',
    },
    {
      name: 'CLASSIFICAR', aliases: ['SORT'], category: 'Matrizes',
      description: 'Ordena um intervalo por coluna e direção.',
      syntax: 'CLASSIFICAR(intervalo; [índice]; [ordem]; [por_coluna])',
      example: '=CLASSIFICAR(A2:D20;4;-1)',
    },
    {
      name: 'CONCAT', aliases: [], category: 'Texto',
      description: 'Junta textos e valores sem adicionar separador automaticamente.',
      syntax: 'CONCAT(texto1; [texto2]; ...)',
      example: '=CONCAT(A2;" - ";B2)',
    },
    {
      name: 'TEXTO.JUNTAR', aliases: ['TEXTJOIN'], category: 'Texto',
      description: 'Junta vários textos utilizando um separador.',
      syntax: 'TEXTO.JUNTAR(delimitador; ignorar_vazios; texto1; ...)',
      example: '=TEXTO.JUNTAR(", ";VERDADEIRO();A2:A10)',
    },
    {
      name: 'ESQUERDA', aliases: ['LEFT'], category: 'Texto',
      description: 'Extrai caracteres do início de um texto.',
      syntax: 'ESQUERDA(texto; [quantidade])',
      example: '=ESQUERDA(A2;3)',
    },
    {
      name: 'DIREITA', aliases: ['RIGHT'], category: 'Texto',
      description: 'Extrai caracteres do final de um texto.',
      syntax: 'DIREITA(texto; [quantidade])',
      example: '=DIREITA(A2;4)',
    },
    {
      name: 'TEXTO', aliases: ['TEXT'], category: 'Texto',
      description: 'Converte um número em texto usando o formato informado.',
      syntax: 'TEXTO(valor; formato)',
      example: '=TEXTO(B2;"R$ #.##0,00")',
    },
    {
      name: 'HOJE', aliases: ['TODAY'], category: 'Data',
      description: 'Retorna a data atual sem incluir o horário.',
      syntax: 'HOJE()',
      example: '=HOJE()',
    },
    {
      name: 'VERDADEIRO', aliases: ['TRUE'], category: 'Constantes',
      description: 'Retorna o valor lógico verdadeiro.',
      syntax: 'VERDADEIRO()',
      example: '=VERDADEIRO()',
    },
    {
      name: 'FALSO', aliases: ['FALSE'], category: 'Constantes',
      description: 'Retorna o valor lógico falso.',
      syntax: 'FALSO()',
      example: '=FALSO()',
    },
  ].map(item => Object.freeze({ ...item, aliases: Object.freeze([...item.aliases]) }));

  const categories = [...new Set(items.map(item => item.category))];

  window.SuperExcelFormulaCatalog = Object.freeze({
    version: 1,
    items: Object.freeze(items),
    categories: Object.freeze(categories),
    count: items.length,
  });
})();