# Detecção de criaturas no OT local

## Resultado

O modelo ativo continua preservado. Um candidato foi treinado por 30 épocas e
avaliado apenas nos frames salvos, conforme solicitado. Ele melhorou, mas ainda
não está pronto para controlar o personagem.

| Avaliação de criaturas | Checkpoint anterior do OT | Novo candidato |
| --- | ---: | ---: |
| Acertos | 0 | 6 |
| Criaturas não encontradas | 11 | 5 |
| Marcações falsas | 0 | 9 |
| Precisão | 0% | 40% |
| Recall | 0% | 54,5% |

Comparação em 87 frames válidos do conjunto de validação existente, com confiança
0,25 e IoU mínimo 0,5. O conjunto contém 11 marcações de criaturas. Não é uma
avaliação de generalização para outras hunts: os frames pertencem à coleta antiga,
cuja divisão não separa sessões de jogo. Os acertos são relativos às anotações
automáticas existentes, que também precisam de revisão humana.

## Evidências e mudanças

- O runtime estava usando `models/candidates/tibia-entities-five.onnx`, entrada
  320 × 320 e confiança mínima 0,15.
- A captura de janela inteira, usada para o layout de quatro quadrantes, reduziu
  os detalhes do mapa. Recortar o frame já reduzido não resolveu o teste inicial.
- O dataset de treino do OT tinha 37 caixas de criaturas, 549 de NPCs e 480 de
  jogadores. O candidato repetiu oito vezes as imagens de treino com criaturas;
  nenhuma imagem de validação entrou no treino.
- Foram encontradas capturas inválidas de 1 × 1 pixel, incluindo 33 das 120 imagens
  de validação. Elas foram excluídas do experimento, sem apagar os originais.
- A coleta agora rejeita imagens pequenas antes de gravar rótulos e permite tentar
  novamente a mesma posição após falha de captura.
- A captura do runtime rejeita imagens pretas e dimensões inválidas. O pipeline
  agora descarta a promessa de captura rejeitada para recuperar a conexão no
  próximo ciclo. As correções foram aplicadas ao agente em modo de observação.
- Quatro testes cobrem rejeição de frames inválidos/pretos, aceitação de imagem
  válida e recuperação após falha. Verificação de tipos passou.

## Artefatos

Exemplos versionados para revisão: [antes](validation-rats/before.png),
[depois](validation-rats/after.png) e [contagem completa](validation-rats/report.json).
Amarelo representa a anotação existente; verde representa a previsão.

Experimento: `storage/runs/local-ot-balanced-20260914-002905/`.

- `comparison.json`: métricas por classe e lista de imagens rejeitadas.
- `fixed-evaluation/report.json`: contagem com limiares fixos da tabela acima.
- `fixed-evaluation/before-*.png` e `after-*.png`: anotações em amarelo e previsões
  em verde, nos mesmos frames.
- `train/weights/best.pt`, `best.onnx`, `best.labels.json`: candidato de três
  classes (criatura, NPC e jogador), entrada 416 × 416.

O ONNX foi executado pelo próprio `OnnxEntityDetector` do Botzin em um frame salvo.
Uma caixa teve confiança de 88% mas ficou abaixo do rato; outro exemplo visual
teve a caixa sobre o rato. Confiança alta não prova localização correta nem
identificação da espécie. O candidato detecta a categoria `creature`.

## Próxima validação necessária

Revisar as caixas incorretas e exemplos de efeitos sobrepostos aos ratos; acrescentar
capturas reais variadas e negativos difíceis. Depois avaliar em uma sessão nova,
com recorte nativo do mapa calibrado. Não promover este candidato apenas pela
melhora da métrica agregada.

Ferramentas: `train-local-ot-balanced.py`, `evaluate-rat-candidate.py` e
`check-onnx-frame.ts`, na pasta `scripts/`.
