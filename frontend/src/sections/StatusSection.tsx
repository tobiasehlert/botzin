import type { AppState, Assignment, HuntSkillRule, LearningMethod, LearningMethodSource, LearningSession, LearningSource, Skill } from "../types.ts";

interface Props {
  state: AppState;
  statusMsg: string;
}

export function StatusSection({ state, statusMsg }: Props) {
  return (
    <section id="sec-status" className="px-5 py-6">
      <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
        Configuração atual
      </h2>
      {statusMsg && (
        <p className="mb-4 text-[12px] text-muted">{statusMsg}</p>
      )}
      {/* items-start: without it every card stretches to the tallest in its row. */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] items-start gap-4">
        <ListCard title="Contas" items={state.accounts} render={a => a.name} />
        <ListCard title="Chars" items={state.characters} render={c => `${c.name} (${c.vocation ?? "?"}) lv${c.level ?? "?"}`} />
        <ListCard title="Máquinas" items={state.machines} render={m => `${m.name} [${m.nodeId}]`} />
        <ListCard title="Hunts" items={state.hunts} render={h => h.name} />
        <ListCard title="Skills" items={state.skills} render={renderSkill} />
        <ListCard title="Atribuições" items={state.assignments} render={a => renderAssignment(a, state)} />
        <ListCard title="Regras de skill" items={state.huntSkillRules} render={r => renderHuntSkillRule(r, state)} />
        <ListCard title="Métodos de aprendizado" items={state.learningMethods} render={m => renderLearningMethod(m)} />
        <ListCard title="Fontes de ensino" items={state.learningSources} render={renderLearningSource} />
        <ListCard title="Vínculos fonte-método" items={state.learningMethodSources} render={r => renderLearningMethodSource(r, state)} />
        <ListCard title="Sessões de ensino" items={state.learningSessions} render={s => renderLearningSession(s, state)} />
      </div>
    </section>
  );
}

/**
 * Each list scrolls inside its own card. Rendering every row unbounded made the
 * grid row as tall as its tallest card — 193 skills and 69 hunts turned this page
 * into ~28 screens of scroll, most of it empty space beside the long lists.
 */
function ListCard<T>({ title, items, render }: { title: string; items: T[]; render: (item: T) => string }) {
  return (
    <div className="flex max-h-[340px] flex-col overflow-hidden rounded-[10px] border border-border bg-surface">
      <h3 className="flex items-center justify-between gap-2 border-b border-border bg-surface-2 px-3.5 py-2.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">
        {title}
        <span className="rounded-full bg-surface-3 px-2 py-0.5 text-[10px] tabular-nums text-subtle">{items.length}</span>
      </h3>
      {items.length === 0 ? (
        <p className="px-3.5 py-3 text-[12px] text-subtle">Nenhum item</p>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {items.map((item, i) => (
            <div key={i} className="border-b border-border px-3.5 py-2 text-[12px] last:border-b-0">
              {render(item)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function renderSkill(s: Skill): string {
  const vocations = s.allowedVocations?.join(", ") ?? "";
  const mana = s.manaCost === null ? "mana variável" : `${s.manaCost ?? 0} mana`;
  const level = s.requiredLevel ? `lvl ${s.requiredLevel}` : "desbloqueio especial";
  const words = s.spellWords ? ` — ${s.spellWords}` : "";
  return `${s.name}${words} — ${mana}, ${level} — ${s.category ?? "?"}${vocations ? ` (${vocations})` : ""}`;
}

function renderAssignment(a: Assignment, state: AppState): string {
  const char = state.characters.find(c => c.id === a.characterId)?.name ?? a.characterId;
  const hunt = state.hunts.find(h => h.id === a.huntId)?.name ?? a.huntId;
  const machine = state.machines.find(m => m.id === a.machineId)?.name ?? a.machineId;
  return `${char} @ ${hunt} em ${machine} [${a.status}]`;
}

function renderHuntSkillRule(r: HuntSkillRule, state: AppState): string {
  const hunt = state.hunts.find(h => h.id === r.huntId)?.name ?? r.huntId;
  const skill = state.skills.find(s => s.id === r.skillId)?.name ?? r.skillId;
  return `${hunt} → ${skill} (pri: ${r.priority ?? 100})`;
}

function renderLearningMethod(m: LearningMethod): string {
  return `${m.name} [${m.methodType}]`;
}

function renderLearningSource(s: LearningSource): string {
  return `${s.name} (${s.sourceType})${s.status ? ` [${s.status}]` : ""}`;
}

function renderLearningMethodSource(r: LearningMethodSource, state: AppState): string {
  const method = state.learningMethods.find(m => m.id === r.methodId)?.name ?? r.methodId;
  const source = state.learningSources.find(s => s.id === r.sourceId)?.name ?? r.sourceId;
  return `${method} ← ${source} (${r.role})`;
}

function renderLearningSession(s: LearningSession, state: AppState): string {
  const method = state.learningMethods.find(m => m.id === s.methodId)?.name ?? s.methodId;
  return `${s.name} [${method}] ${s.status}`;
}
