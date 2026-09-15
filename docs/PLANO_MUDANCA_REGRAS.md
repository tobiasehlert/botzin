# Plano revisado para mudanca das regras

## Status

| Fase | Situacao | Onde |
| --- | --- | --- |
| 1 - Estado central | Pronta | `src/decision/game-state.ts` |
| 2 - Contrato das regras | Pronta | `src/decision/rule-engine.ts` |
| 3 - Vida e mana | Pronta | `src/decision/rules/survival-rules.ts` |
| 4 - Vocacao | Pronta via dados | `bot_hunt_skill_rules` + `planSpellCast` valida vocacao e level |
| 5 - Criaturas | Pronta | `src/decision/creature-knowledge.ts`, `src/decision/rules/combat-rules.ts` |
| 6 - Itens e suprimentos | Pronta | `src/decision/rules/item-rules.ts` |
| 7 - Upar | Avaliacao pronta | `src/decision/rules/leveling-rules.ts` |
| 8 - Motor central | Pronta | `src/decision/rule-engine.ts` |
| 9 - Validacao | Pronta | `src/decision/action-validator.ts` |
| 10 - Migracao | Em `observe` | `BOTZIN_DECISION_MODE`, `BOTZIN_DECISION_RULE_MODES` |

Decisoes tomadas na implementacao:

- Regras por vocacao nao viraram arquivo: as linhas de `bot_hunt_skill_rules` ja
  descrevem magia, prioridade e janelas de HP, mana e quantidade de criaturas, e
  a vocacao e o level sao validados por `planSpellCast`.
- O elemento da magia sai das palavras (`flam`, `frigo`, `vis`...) e e comparado
  com `damageModifiers` do catalogo: magia que a criatura absorve nao e proposta
  e magia contra fraqueza ganha prioridade.
- Suprimentos e stamina reusam `evaluateHuntOperation`, o mesmo avaliador que o
  coletor de telemetria ja usa.
- A selecao automatica de hunt continua fora, como o plano pede; a regra de
  evolucao apenas avalia a hunt em andamento pela telemetria ja gravada.
- A especie vem do `CreatureSpeciesClassifier`, que o `OnnxEntityDetector` ja
  aplica no fim do `detect()`. Sem o arquivo do modelo ele vira no-op e as
  criaturas ficam sem especie, entao as regras de catalogo ficam inertes.

Falta para ligar `execute` com seguranca: leitura de HP, mana, stamina e
supplies na tela (`operationObservation`), mapeamento de coordenadas do frame
para a tela e o transporte HID no Raspberry. Fuga, retorno e reposicao registram
a decisao mas ainda nao enviam deslocamento.

### Configuracao por run (`routeSnapshotJson`)

```json
{
  "minStaminaMinutes": 2340,
  "refill": { "capacityBelow": 200, "supplies": { "ultimate mana potion": { "returnAt": 300, "buyTo": 1200 } } },
  "survival": { "emergencyHealthPercent": 30, "healHealthPercent": 65, "manaPotionPercent": 45, "maxReadingAgeMs": 2000 },
  "creatures": { "allowSpecies": [], "ignoreSpecies": [], "dangerousSpecies": [], "maxThreat": 600, "maxCreatures": 6 },
  "loot": { "enabled": true, "allowItems": [], "ignoreItems": [], "maxDistance": 200, "onlyWhenSafe": true },
  "leveling": { "minimumXpPerHour": 250000, "minimumProfit": 0, "requireHuntLevel": true }
}
```

### Variaveis de ambiente

```text
BOTZIN_DECISION_MODE=observe|suggest|execute
BOTZIN_DECISION_RULE_MODES=heal:execute,attack-target:observe
```

## Objetivo

Transformar a decisao atual em um sistema central com regras especializadas, reaproveitando os catalogos, sprites, detectores e classificadores existentes.

```text
Percepcao existente
      |
      v
Estado central
      |
      v
Regras de emergencia
      |
      v
Regras da vocacao
      |
      v
Regras de combate
      |
      v
Regras de suprimentos e itens
      |
      v
Regras de evolucao e hunt
      |
      v
Validacao
      |
      v
Sugestao ou execucao
```

## Fase 1 - Padronizar o estado do jogo

Criar um `GameState` contendo:

- Vocacao e level.
- Vida e mana atual e maxima.
- Criaturas detectadas e respectivas especies.
- Quantidade de criaturas proximas.
- Alvo atual.
- Itens e suprimentos conhecidos.
- Situacao de combate.
- Confianca e idade da percepcao.
- Hunt e estrategia ativas.

Arquivos sugeridos:

```text
src/state/game-state.ts
src/state/game-state-builder.ts
src/state/game-state-store.ts
```

O `GameStateBuilder` devera combinar a percepcao existente com a configuracao do personagem e o catalogo.

## Fase 2 - Criar o contrato das regras

Todas as regras devem usar a mesma entrada e produzir propostas padronizadas:

```ts
interface DecisionRule {
  id: string;
  priority: number;
  evaluate(state: GameState): ActionProposal | null;
}

interface ActionProposal {
  action: BotAction;
  priority: number;
  reason: string;
  source: string;
  expiresAt: number;
}
```

Cada proposta precisa explicar por que foi criada. Isso facilitara a visualizacao no painel e os testes.

Arquivos sugeridos:

```text
src/decision/rules/decision-rule.ts
src/decision/actions/bot-action.ts
src/decision/actions/action-proposal.ts
```

## Fase 3 - Regras de vida e mana

Implementar primeiro porque sao as regras mais criticas:

- Cura emergencial.
- Cura normal.
- Recuperacao de mana.
- Evitar desperdicio de pocao.
- Respeitar cooldown.
- Fugir quando nao houver cura.
- Parar se a leitura estiver desatualizada ou incerta.

Exemplo de configuracao:

```ts
{
  emergencyHealthPercent: 30,
  healHealthPercent: 65,
  manaPotionPercent: 45,
  minimumSupplyCount: 20
}
```

Arquivos sugeridos:

```text
src/decision/rules/survival/emergency-heal-rule.ts
src/decision/rules/survival/heal-rule.ts
src/decision/rules/survival/mana-rule.ts
src/decision/rules/survival/escape-rule.ts
```

Essas regras sempre devem ter prioridade sobre combate e loot.

## Fase 4 - Regras por vocacao

Criar regras separadas para cada vocacao, utilizando o catalogo de magias ja existente:

```text
src/decision/rules/vocations/knight-rules.ts
src/decision/rules/vocations/paladin-rules.ts
src/decision/rules/vocations/druid-rules.ts
src/decision/rules/vocations/sorcerer-rules.ts
src/decision/rules/vocations/monk-rules.ts
```

Cada conjunto devera considerar:

- Level minimo.
- Mana disponivel.
- Distancia desejada.
- Quantidade de criaturas.
- Elemento ou tipo de dano.
- Magias disponiveis.
- Regras especificas da hunt.

Comecar apenas com a vocacao do personagem usado nos testes.

## Fase 5 - Adaptar as regras de criaturas

Reaproveitar o detector, classificador e catalogo existentes.

As novas regras deverao:

- Confirmar a especie pela confianca minima.
- Escolher o alvo mais seguro.
- Consultar fraquezas e resistencias.
- Limitar a quantidade maxima de criaturas.
- Ignorar criaturas fora da configuracao da hunt.
- Fugir de criaturas perigosas ou desconhecidas.
- Nao atacar players, NPCs ou summons.

Arquivos sugeridos:

```text
src/decision/rules/combat/target-selection-rule.ts
src/decision/rules/combat/attack-rule.ts
src/decision/rules/combat/reposition-rule.ts
src/decision/rules/combat/unsafe-creature-rule.ts
```

O arquivo existente `hunt-operation-policy.ts` pode ser dividido gradualmente nessas regras, preservando o comportamento atual durante a migracao.

## Fase 6 - Regras de itens e suprimentos

Reaproveitar os sprites e o catalogo de itens existentes.

Implementar:

- Lista de loot permitido.
- Lista de itens ignorados.
- Valor minimo para coleta.
- Prioridade para itens raros.
- Verificacao de seguranca antes de coletar.
- Quantidade minima de pocoes, runas e municao.
- Regra de retorno para reposicao.

Arquivos sugeridos:

```text
src/decision/rules/items/loot-rule.ts
src/decision/rules/items/rare-item-rule.ts
src/decision/rules/items/supply-rule.ts
src/decision/rules/items/resupply-rule.ts
```

A coleta nunca devera superar cura, fuga ou combate imediato.

## Fase 7 - Regras para upar

Utilizar a telemetria de hunt existente para escolher ou avaliar hunts:

- XP por hora.
- Lucro.
- Consumo de suprimentos.
- Quantidade de situacoes criticas.
- Adequacao ao level e a vocacao.
- Quantidade de criaturas suportada.
- Tempo de deslocamento.

Arquivos sugeridos:

```text
src/decision/rules/leveling/hunt-selection-rule.ts
src/decision/rules/leveling/hunt-efficiency-rule.ts
src/decision/rules/leveling/leave-hunt-rule.ts
```

Inicialmente, a hunt continua sendo escolhida manualmente. A selecao automatica entra somente depois que houver telemetria confiavel.

## Fase 8 - Criar o motor central de regras

O motor devera:

1. Executar todas as regras aplicaveis.
2. Remover propostas invalidas.
3. Ordenar por prioridade.
4. Resolver conflitos.
5. Escolher apenas uma acao.
6. Registrar propostas aceitas e recusadas.

Prioridades:

| Faixa | Categoria |
| ---: | --- |
| 900-1000 | Parada e emergencia |
| 700-899 | Vida, mana e fuga |
| 500-699 | Combate |
| 300-499 | Posicionamento e suprimentos |
| 100-299 | Loot e evolucao |
| 0-99 | Acoes opcionais |

Arquivo sugerido:

```text
src/decision/rule-engine.ts
```

## Fase 9 - Validacao antes da execucao

Criar uma camada independente que confirme:

- Percepcao recente.
- Confianca suficiente.
- Mana e HP compativeis.
- Magia permitida para level e vocacao.
- Hotkey configurada.
- Cooldown encerrado.
- Modo da regra: `observe`, `suggest` ou `execute`.
- Limite de comandos por periodo.

Arquivo sugerido:

```text
src/decision/action-validator.ts
```

Mesmo que uma regra erre, o validador deve impedir a acao perigosa.

## Fase 10 - Migracao gradual

Nao substituir todas as regras de uma vez:

1. Manter a estrategia atual funcionando.
2. Adicionar o novo motor em modo paralelo.
3. Registrar a decisao antiga e a decisao nova.
4. Comparar divergencias.
5. Ativar somente vida e mana.
6. Ativar uma vocacao.
7. Ativar combate.
8. Ativar suprimentos.
9. Ativar loot.
10. Ativar evolucao.

Usar os modos ja existentes:

```text
observe -> apenas registra
suggest -> mostra o que faria
execute -> envia comandos
```

## Testes obrigatorios

Criar cenarios deterministicos:

- HP critico e mana cheia.
- HP e mana baixos simultaneamente.
- Sem pocoes disponiveis.
- Criatura desconhecida.
- Muitas criaturas proximas.
- Magia sem level suficiente.
- Magia sem mana suficiente.
- Loot raro durante emergencia.
- Percepcao antiga ou com baixa confianca.
- Conflito entre cura e ataque.
- Vocacao incompativel com a magia.

## Criterios de conclusao

A mudanca estara pronta quando:

- Todas as decisoes tiverem origem e justificativa.
- Emergencia sempre superar combate e loot.
- Nenhuma magia incompativel puder ser executada.
- O novo motor reproduzir resultados consistentes.
- Os testes cobrirem cada regra critica.
- O modo `observe` funcionar sem alterar o jogo.
- A execucao puder ser habilitada individualmente por regra.

## Primeira entrega recomendada

A primeira entrega deve conter somente:

1. Estado central.
2. Motor de regras.
3. Regras de vida e mana.
4. Regras de uma vocacao.
5. Combate basico.

O sistema existente de criaturas, catalogos e sprites deve ser reaproveitado integralmente.
