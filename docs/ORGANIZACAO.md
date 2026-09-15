# Organização do projeto

## Código e ferramentas

| Pasta | Responsabilidade |
| --- | --- |
| `src/` | Aplicação: percepção, decisão, execução, API e aprendizado |
| `frontend/` | Painel React |
| `annotation-ui/` | Interface usada por `npm run annotations:dev` |
| `scripts/` | Captura OBS, preparação de dados, treinamento e ferramentas locais |
| `tests/` | Testes automatizados |
| `database/`, `prisma/` | Banco de dados e modelos de persistência |
| `docker/`, `.github/`, `.githooks/` | Execução, integração e verificações |
| `docs/` | Planos e documentação complementar |
| `local-ot/` | Servidor local e ambiente de treinamento; possui instruções próprias |

## Dados e resultados

| Pasta | Conteúdo |
| --- | --- |
| `storage/knowledge/` | Fontes, vídeos preparados, frames, anotações e datasets |
| `storage/datasets/` | Datasets adicionais, incluindo OT local |
| `storage/runs/` | Resultados de treinamento |
| `storage/reviews/deteccoes-500/` | CSV de origens usado pela ferramenta de anotação |
| `models/` | Modelos e classes; `candidates/` contém candidatos de treinamento |
| `obsidian-vault/` | Exportação de conhecimento gerada por `npm run vault:export` |

Vídeos de caminhos e hunts são fontes de ensino. Preserve os arquivos e seus
caminhos cadastrados: mover vídeos ou frames isoladamente pode quebrar referências
do banco e das anotações. O mesmo vale para modelos configurados no painel.

## Arquivos gerados e dependências

`dist/` e `public/` contêm saídas de compilação. `node_modules/` e `.venv/`
contêm dependências. Não são código descartado: são necessários para os comandos
que os utilizam e podem estar em uso por processos abertos.

Os pesos `.pt` da raiz podem ser usados ou baixados pelas ferramentas Python.
Ausência de referência literal não comprova que um modelo está sem uso.

## Reorganização de setembro de 2026

- Plano de regras movido da raiz para `docs/`, preservando seu conteúdo.
- CSV `validacao-deteccoes-500/origens.csv` transferido para
  `storage/reviews/deteccoes-500/origens.csv`; consumidor atualizado.
- `.token` excluído do versionamento por conter credencial local.
- Vídeos, anotações, checkpoints e código existente preservados.

Nenhum módulo foi classificado como descartável apenas por não ter importações:
há scripts executados manualmente, caminhos persistidos e configurações externas.
