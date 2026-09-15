# Monitor em quatro janelas

Execute na raiz do projeto:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/run-desktop-monitor.ps1
```

O layout coloca o OTClient no alto à esquerda, a projeção da fonte `Tibia Preview`
do OBS no alto à direita, as decisões embaixo à esquerda e o frame analisado com
detecções embaixo à direita. A janela principal do OBS fica atrás das demais; a projeção
é uma janela do próprio OBS, sem iniciar gravação ou transmissão.

O agente é iniciado em modo `observe`. O monitor não controla o personagem nem
transforma uma proposta em ação executada. O cliente precisa estar aberto e
conectado ao jogo para mostrar gameplay.

As duas janelas de monitoramento leem `storage/desktop-monitor.json`, publicado
atomicamente pelo agente com a decisão e o mesmo frame que a produziu. Dados com
mais de cinco segundos são marcados como sem atualização. Fechar uma janela de
monitoramento fecha a outra, mas não encerra o agente, o OBS ou o jogo.

Se já existir um agente, o lançador o preserva. Para alimentar estas janelas,
esse agente precisa ter sido iniciado com `BOTZIN_MONITOR_PATH` apontando para
`storage/desktop-monitor.json`.

O cliente local recebeu um ajuste em seu `otclientrc.lua` para permitir janela
menor. A captura foi reenquadrada para a janela inteira; antes de habilitar
execução por mouse, recalibre o recorte e o mapeamento de coordenadas.
