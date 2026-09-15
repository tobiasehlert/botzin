import { CollapsibleCard } from "../components/CollapsibleCard.tsx";
import { useState } from "react";
import { Field, GroupLabel, Input, Select, Textarea } from "../components/Field.tsx";
import { FormBody, useFormSubmit } from "../components/FormSection.tsx";
import { SectionNav } from "../components/SectionNav.tsx";
import { SpellIconGrid } from "../components/SpellIconGrid.tsx";
import type { AppState } from "../types.ts";

interface Props {
  state: AppState;
  onRefresh: () => void;
}

const TABS = [
  { id: "cadastros", label: "Contas e chars" },
  { id: "maquinas", label: "Máquinas" },
  { id: "hunts", label: "Hunts e skills" },
  { id: "magias", label: "Magias" },
] as const;

export function EntitiesSection({ state, onRefresh }: Props) {
  const [tab, setTab] = useState<string>(TABS[0].id);
  const grid = "grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-4";
  return (
    <section id="sec-entities" className="px-5 py-6">
      <SectionNav tabs={TABS} active={tab} onSelect={setTab} label="Seções de entidades" />

      <div className={grid} hidden={tab !== "cadastros"}>
        <AccountCard onRefresh={onRefresh} />
        <CharCard state={state} onRefresh={onRefresh} />
      </div>

      {/* Alone in its tab so the ~20 machine fields get the full width. */}
      <div className={grid} hidden={tab !== "maquinas"}>
        <MachineCard state={state} onRefresh={onRefresh} />
      </div>

      <div className={grid} hidden={tab !== "hunts"}>
        <HuntCard onRefresh={onRefresh} />
        <SkillCard onRefresh={onRefresh} />
      </div>

      <div className={grid} hidden={tab !== "magias"}>
        <ClientSpellBindingCard state={state} onRefresh={onRefresh} />
        <CollapsibleCard icon="✨" iconKind="skill" title="Ícones das magias" wide>
          <SpellIconGrid />
        </CollapsibleCard>
      </div>
    </section>
  );
}

function ClientSpellBindingCard({ state, onRefresh }: Props) {
  const { handleSubmit, busy, msg } = useFormSubmit({ url: "/api/client-spell-bindings", onSuccess: onRefresh });
  return (
    <CollapsibleCard icon="K" iconKind="skill" title="Magias no cliente">
      <FormBody onSubmit={handleSubmit} busy={busy} msg={msg} submitLabel="Salvar hotkey">
        <Field label="Personagem">
          <Select name="characterId" required>
            <option value="">Selecionar...</option>
            {state.characters.map(character => <option key={character.id} value={character.id}>{character.name}</option>)}
          </Select>
        </Field>
        <Field label="Magia">
          <Select name="skillId" required>
            <option value="">Selecionar...</option>
            {state.skills.map(skill => <option key={skill.id} value={skill.id}>{skill.name} ({skill.manaCost ?? 0} mana)</option>)}
          </Select>
        </Field>
        <Field label="Hotkey do cliente"><Input name="hotkey" required placeholder="F1 ou CTRL+F1" /></Field>
        <Field label="Slot Multi-Action">
          <Select name="multiActionSlot" defaultValue="1">
            <option value="1">I — primeira ação</option>
            <option value="2">II — se I estiver indisponível</option>
            <option value="3">III — se I e II estiverem indisponíveis</option>
          </Select>
        </Field>
        <Field label="Modo de uso">
          <Select name="castMode">
            <option value="hotkey">Hotkey configurada</option>
            <option value="spell-words">Palavras da magia</option>
          </Select>
        </Field>
        <Field label="Alvo">
          <Select name="targetMode">
            <option value="current-target">Alvo atual</option>
            <option value="self">Próprio personagem</option>
            <option value="crosshair">Crosshair</option>
          </Select>
        </Field>
        <Field label="Verificada em"><Input name="lastVerifiedAt" type="datetime-local" /></Field>
        <Field label="Notas"><Textarea name="notes" placeholder="Revalidar após importar hotkeys ou atualizar o cliente" /></Field>
      </FormBody>
    </CollapsibleCard>
  );
}

function AccountCard({ onRefresh }: { onRefresh: () => void }) {
  const { handleSubmit, busy, msg } = useFormSubmit({ url: "/api/accounts", onSuccess: onRefresh });
  return (
    <CollapsibleCard icon="C" iconKind="account" title="Conta">
      <FormBody onSubmit={handleSubmit} busy={busy} msg={msg} submitLabel="Salvar conta">
        <Field label="Nome"><Input name="name" required /></Field>
        <Field label="Login"><Input name="loginIdentifier" required /></Field>
        <Field label="Referencia secreta"><Input name="secretReference" placeholder="vault:tibia/main" /></Field>
        <Field label="Notas"><Textarea name="notes" /></Field>
      </FormBody>
    </CollapsibleCard>
  );
}

function CharCard({ state, onRefresh }: Props) {
  const { handleSubmit, busy, msg } = useFormSubmit({ url: "/api/characters", onSuccess: onRefresh });
  return (
    <CollapsibleCard icon="P" iconKind="char" title="Char">
      <FormBody onSubmit={handleSubmit} busy={busy} msg={msg} submitLabel="Salvar char">
        <Field label="Conta">
          <Select name="accountId" required>
            <option value="">Selecionar...</option>
            {state.accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
        </Field>
        <Field label="Nome"><Input name="name" required /></Field>
        <Field label="World"><Input name="world" /></Field>
        <Field label="Vocacao"><Input name="vocation" /></Field>
        <Field label="Level"><Input name="level" type="number" min="1" /></Field>
      </FormBody>
    </CollapsibleCard>
  );
}

function MachineCard({ state, onRefresh }: Props) {
  const [machineId, setMachineId] = useState("");
  const machine = state.machines.find((item) => String(item.id) === machineId);
  const runtime = machine?.runtimeConfig;
  const { handleSubmit, busy, msg } = useFormSubmit({ url: machine ? `/api/machines/${machine.id}` : "/api/machines", onSuccess: onRefresh });
  return (
    <CollapsibleCard icon="M" iconKind="machine" title="Configuração da máquina" wide>
      <Field label="Máquina cadastrada">
        <Select value={machineId} onChange={(event) => setMachineId(event.target.value)}>
          <option value="">Nova máquina</option>
          {state.machines.map((item) => <option key={item.id} value={item.id}>{item.name} [{item.nodeId}]</option>)}
        </Select>
      </Field>
      <div className="mt-3" key={machine?.id ?? "new"}>
      <FormBody onSubmit={handleSubmit} busy={busy} msg={msg} submitLabel={machine ? "Atualizar máquina" : "Salvar máquina"}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Node ID"><Input name="nodeId" required placeholder="pc-main" defaultValue={machine?.nodeId ?? "pc-main"} /></Field>
        <Field label="Nome"><Input name="name" required defaultValue={machine?.name ?? "Computador principal"} /></Field>
        <Field label="Funcao">
          <Select name="role" defaultValue={machine?.role ?? "perception"}>
            <option value="perception">Percepcao</option>
            <option value="coordinator">Coordenador</option>
            <option value="raspberry-executor">Raspberry executor</option>
          </Select>
        </Field>
        <Field label="Host preferido"><Input name="preferredHost" placeholder="192.168.0.10" defaultValue={machine?.preferredHost ?? ""} /></Field>
        <Field label="Host coordenador"><Input name="coordinatorHost" defaultValue={runtime?.coordinatorHost ?? "127.0.0.1"} /></Field>
        <Field label="Porta coordenador"><Input name="coordinatorPort" type="number" defaultValue={runtime?.coordinatorPort ?? 4573} /></Field>
        </div>

        <GroupLabel>Captura do OBS</GroupLabel>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Fonte de frames"><Select name="frameSource" defaultValue={runtime?.frameSource ?? "obs"}><option value="obs">OBS</option><option value="mock">Simulação</option></Select></Field>
        <Field label="WebSocket do OBS"><Input name="obsWebSocketUrl" defaultValue={runtime?.obsWebSocketUrl ?? "ws://127.0.0.1:4455"} /></Field>
        <Field label="Fonte do OBS"><Input name="obsSourceName" defaultValue={runtime?.obsSourceName ?? "Tibia Preview"} /></Field>
        <Field label="Senha do OBS"><Input name="obsWebSocketPassword" type="password" placeholder={machine?.obsWebSocketPasswordConfigured ? "Configurada — deixe vazio para manter" : "Senha do WebSocket"} /></Field>
        <Field label="Processo do OBS"><Input name="obsProcessName" defaultValue={runtime?.obsProcessName ?? "obs64.exe"} /></Field>
        <Field label="Processo do Tibia"><Input name="tibiaProcessName" defaultValue={runtime?.tibiaProcessName ?? "client.exe"} /></Field>
        <Field label="Fonte do Tibia"><Input name="tibiaSourceName" defaultValue={runtime?.tibiaSourceName ?? "Tibia"} /></Field>
        </div>

        <GroupLabel>Detector local</GroupLabel>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Detector"><Select name="detector" defaultValue={runtime?.detector ?? "onnx"}><option value="onnx">ONNX</option><option value="mock">Simulação</option></Select></Field>
        <Field label="Modelo ONNX"><Input name="onnxModelPath" defaultValue={runtime?.onnxModelPath ?? "models/candidates/tibia-entities-five.onnx"} /></Field>
        <Field label="Labels ONNX"><Input name="onnxLabelsPath" defaultValue={runtime?.onnxLabelsPath ?? "models/candidates/tibia-entities-five.labels.json"} /></Field>
        <Field label="Largura"><Input name="onnxInputWidth" type="number" defaultValue={runtime?.onnxInputWidth ?? 320} /></Field>
        <Field label="Altura"><Input name="onnxInputHeight" type="number" defaultValue={runtime?.onnxInputHeight ?? 320} /></Field>
        <Field label="Confiança (0–1)"><Input name="detectionConfidence" type="number" min="0" max="1" step="0.01" defaultValue={runtime?.detectionConfidence ?? 0.35} /></Field>
        <Field label="IoU (0–1)"><Input name="detectionIou" type="number" min="0" max="1" step="0.01" defaultValue={runtime?.detectionIou ?? 0.45} /></Field>
        <Field label="Intervalo de captura (ms)"><Input name="runFrameIntervalMs" type="number" defaultValue={runtime?.runFrameIntervalMs ?? 10000} /></Field>
        </div>

        <GroupLabel>Rede e executor</GroupLabel>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Bind da rede"><Input name="networkBindHost" defaultValue={runtime?.networkBindHost ?? "0.0.0.0"} /></Field>
        <Field label="Redes preferidas"><Input name="networkPreferredKinds" defaultValue={runtime?.networkPreferredKinds.join(",") ?? "ethernet,wifi"} /></Field>
        <Field label="Hosts anunciados"><Input name="networkAdvertiseHosts" defaultValue={runtime?.networkAdvertiseHosts.join(",") ?? ""} /></Field>
        <Field label="Host Raspberry"><Input name="raspberryHost" defaultValue={runtime?.raspberryHost ?? "127.0.0.1"} /></Field>
        <Field label="Porta Raspberry"><Input name="raspberryPort" type="number" defaultValue={runtime?.raspberryPort ?? 4574} /></Field>
        <Field label="Notas de conexão" className="sm:col-span-3"><Textarea name="connectionNotes" defaultValue={machine?.connectionNotes ?? ""} /></Field>
        </div>
      </FormBody>
      </div>
    </CollapsibleCard>
  );
}

function HuntCard({ onRefresh }: { onRefresh: () => void }) {
  const { handleSubmit, busy, msg } = useFormSubmit({ url: "/api/hunts", onSuccess: onRefresh });
  return (
    <CollapsibleCard icon="H" iconKind="hunt" title="Hunt">
      <FormBody onSubmit={handleSubmit} busy={busy} msg={msg} submitLabel="Salvar hunt">
        <Field label="Nome"><Input name="name" required /></Field>
        <Field label="Cidade"><Input name="city" /></Field>
        <Field label="Perfil de rota"><Input name="routeProfile" /></Field>
        <Field label="Level minimo"><Input name="minLevel" type="number" min="1" /></Field>
        <Field label="Notas"><Textarea name="notes" /></Field>
      </FormBody>
    </CollapsibleCard>
  );
}

function SkillCard({ onRefresh }: { onRefresh: () => void }) {
  const { handleSubmit, busy, msg } = useFormSubmit({ url: "/api/skills", onSuccess: onRefresh });
  return (
    <CollapsibleCard icon="S" iconKind="skill" title="Skill">
      <FormBody onSubmit={handleSubmit} busy={busy} msg={msg} submitLabel="Salvar skill">
        <Field label="Nome"><Input name="name" required placeholder="Exori" /></Field>
        <Field label="Palavras"><Input name="spellWords" placeholder="exori" /></Field>
        <Field label="Hotkey"><Input name="hotkey" placeholder="F1" /></Field>
        <Field label="Categoria">
          <Select name="category">
            <option value="attack">Ataque</option>
            <option value="healing">Cura</option>
            <option value="support">Suporte</option>
            <option value="utility">Utilidade</option>
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Custo de mana"><Input name="manaCost" type="number" min="0" defaultValue="0" /></Field>
          <Field label="Level minimo"><Input name="requiredLevel" type="number" min="0" defaultValue="0" /></Field>
        </div>
        <Field label="Vocacoes (virgula)"><Input name="allowedVocations" required placeholder="knight,elite knight" /></Field>
        <Field label="Cooldown ms"><Input name="cooldownMs" type="number" min="0" defaultValue="1000" /></Field>
        <Field label="Notas"><Textarea name="notes" /></Field>
      </FormBody>
    </CollapsibleCard>
  );
}
