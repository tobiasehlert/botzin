import { useEffect, useState, type FormEvent } from "react";
import { CollapsibleCard } from "../components/CollapsibleCard.tsx";
import { Field, Input, Select, Textarea } from "../components/Field.tsx";
import { FormBody, useFormSubmit } from "../components/FormSection.tsx";
import { SectionNav } from "../components/SectionNav.tsx";
import { apiFetch } from "../api.ts";
import type { AppState, KnowledgeCoverage, KnowledgeSearchResult } from "../types.ts";

interface Props {
  state: AppState;
  onRefresh: () => void;
}

const TABS = [
  { id: "cobertura", label: "O que a IA sabe" },
  { id: "metodos", label: "Métodos e sessões" },
  { id: "fontes", label: "Fontes de ensino" },
] as const;

export function LearningSection({ state, onRefresh }: Props) {
  const [tab, setTab] = useState<string>(TABS[0].id);
  return (
    <section id="sec-learning" className="px-5 py-6">
      <SectionNav tabs={TABS} active={tab} onSelect={setTab} label="Seções de aprendizado" />

      <div hidden={tab !== "cobertura"}>
        <KnowledgeExplorerCard cataloguedSources={state.learningSources.length} />
      </div>
      <div hidden={tab !== "metodos"}>
        <LearningMethodCard state={state} onRefresh={onRefresh} />
        <LearningSessionCard state={state} onRefresh={onRefresh} />
      </div>
      <div hidden={tab !== "fontes"}>
        <LearningSourceCard onRefresh={onRefresh} />
        <VideoUploadCard onRefresh={onRefresh} />
        <LearningMethodSourceCard state={state} onRefresh={onRefresh} />
      </div>
    </section>
  );
}

function KnowledgeExplorerCard({ cataloguedSources }: { cataloguedSources: number }) {
  const [coverage, setCoverage] = useState<KnowledgeCoverage | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<KnowledgeSearchResult[]>([]);
  const [message, setMessage] = useState("Carregando cobertura...");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void apiFetch<KnowledgeCoverage>("/api/knowledge/coverage")
      .then((value) => {
        setCoverage(value);
        setMessage(value.indexedDocuments > 0 ? "Índice pronto para consulta." : "Execute npm run knowledge:ingest para gerar o índice.");
      })
      .catch((error: unknown) => setMessage(error instanceof Error ? error.message : "Falha ao carregar cobertura."));
  }, []);

  const search = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const normalized = query.trim();
    if (!normalized) return;
    setBusy(true);
    setMessage("Pesquisando somente nas fontes indexadas...");
    try {
      const response = await apiFetch<{ results: KnowledgeSearchResult[] }>(
        `/api/knowledge/search?q=${encodeURIComponent(normalized)}&limit=8`
      );
      setResults(response.results);
      setMessage(response.results.length > 0
        ? `${response.results.length} trecho(s) encontrado(s).`
        : "A IA ainda não possui uma fonte indexada para responder isso.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Falha na pesquisa.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <CollapsibleCard icon="?" iconKind="source" title="O que a IA sabe?" wide>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KnowledgeMetric label="Fontes cadastradas" value={cataloguedSources} />
        <KnowledgeMetric label="Documentos indexados" value={coverage?.indexedDocuments ?? 0} />
        <KnowledgeMetric label="Trechos pesquisáveis" value={coverage?.indexedChunks ?? 0} />
        <KnowledgeMetric label="Documentos revisados" value={coverage?.reviewedDocuments ?? 0} />
      </div>
      <form className="mt-4 flex gap-2" onSubmit={(event) => void search(event)}>
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          maxLength={200}
          placeholder="Ex.: o que analisar antes de começar uma hunt?"
          aria-label="Pergunta para a base de conhecimento"
        />
        <button
          type="submit"
          disabled={busy || !query.trim()}
          className="rounded-[6px] border border-border bg-panel px-4 py-1.5 text-[13px] font-medium disabled:opacity-50"
        >
          {busy ? "Buscando..." : "Pesquisar"}
        </button>
      </form>
      <p className="mt-2 text-[12px] text-muted">{message}</p>
      {results.length > 0 && (
        <div className="mt-3 space-y-2">
          {results.map((result) => (
            <article key={result.id} className="rounded-[6px] border border-border bg-bg p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-[13px] font-semibold">{result.title}</h3>
                <span className="text-[11px] text-muted">
                  {formatKnowledgeTime(result.startSeconds)} {result.gameVersion ? `• cliente ${result.gameVersion}` : ""} {result.reviewed ? "• revisado" : "• transcrição não revisada"}
                </span>
              </div>
              <p className="mt-1 text-[12px] leading-5 text-muted">{result.text}</p>
              {result.freshnessWarning && (
                <p className="mt-2 rounded-[4px] border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px] leading-4 text-amber-200">
                  {result.freshnessWarning}
                </p>
              )}
              {result.url && <a className="mt-2 inline-block text-[12px] text-accent hover:underline" href={result.url} target="_blank" rel="noreferrer">Abrir fonte no momento citado</a>}
            </article>
          ))}
        </div>
      )}
    </CollapsibleCard>
  );
}

function KnowledgeMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-[6px] border border-border bg-bg p-3">
      <div className="text-[18px] font-semibold">{value}</div>
      <div className="text-[11px] text-muted">{label}</div>
    </div>
  );
}

function formatKnowledgeTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.floor(seconds % 60);
  return `${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`;
}

function LearningMethodCard({ state, onRefresh }: Props) {
  const { handleSubmit, busy, msg } = useFormSubmit({ url: "/api/learning-methods", onSuccess: onRefresh });
  return (
    <CollapsibleCard icon="L" iconKind="method" title="Método de aprendizado" wide>
      <FormBody onSubmit={handleSubmit} busy={busy} msg={msg} submitLabel="Salvar metodo">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Nome" className="sm:col-span-2"><Input name="name" required placeholder="Demo manual EK hunt" /></Field>
          <Field label="Peso"><Input name="weight" type="number" step="0.1" defaultValue="1" /></Field>
          <Field label="Tipo">
            <Select name="methodType">
              <option value="manual-rules">Regras manuais</option>
              <option value="human-demonstration">Demonstracao humana</option>
              <option value="replay">Replay de sessoes</option>
              <option value="human-feedback">Feedback humano</option>
              <option value="hunt-telemetry">Telemetria de hunt</option>
              <option value="external-knowledge">Conhecimento externo</option>
            </Select>
          </Field>
          <Field label="Escopo">
            <Select name="scope">
              <option value="global">Global</option>
              <option value="hunt">Hunt</option>
              <option value="character">Char</option>
              <option value="party">Party</option>
            </Select>
          </Field>
          <Field label="Modo">
            <Select name="mode">
              <option value="observe">Observar</option>
              <option value="suggest">Sugerir</option>
              <option value="execute">Executar</option>
            </Select>
          </Field>
          <Field label="Hunt (opcional)">
            <Select name="huntId">
              <option value="">Nenhuma</option>
              {state.hunts.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}
            </Select>
          </Field>
          <Field label="Char (opcional)">
            <Select name="characterId">
              <option value="">Nenhum</option>
              {state.characters.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
          <Field label="Config JSON" className="sm:col-span-3">
            <Textarea name="configJson" placeholder='{"source":"obs","recordInputs":true}' />
          </Field>
          <Field label="Notas" className="sm:col-span-3"><Textarea name="notes" /></Field>
        </div>
      </FormBody>
    </CollapsibleCard>
  );
}

function LearningSessionCard({ state, onRefresh }: Props) {
  const { handleSubmit, busy, msg } = useFormSubmit({ url: "/api/learning-sessions", onSuccess: onRefresh });
  return (
    <CollapsibleCard icon="S" iconKind="session" title="Sessão de ensino" wide>
      <FormBody onSubmit={handleSubmit} busy={busy} msg={msg} submitLabel="Salvar sessao">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Metodo">
            <Select name="methodId" required>
              <option value="">Selecionar...</option>
              {state.learningMethods.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </Select>
          </Field>
          <Field label="Atribuicao (opcional)">
            <Select name="assignmentId">
              <option value="">Nenhuma</option>
              {state.assignments.map(a => <option key={a.id} value={a.id}>{a.id}</option>)}
            </Select>
          </Field>
          <Field label="Status">
            <Select name="status">
              <option value="recording">Gravando</option>
              <option value="reviewing">Revisando</option>
              <option value="approved">Aprovada</option>
              <option value="rejected">Rejeitada</option>
              <option value="archived">Arquivada</option>
            </Select>
          </Field>
          <Field label="Nome" className="sm:col-span-3">
            <Input name="name" required placeholder="Treino hunt dragon 01" />
          </Field>
          <Field label="Resumo JSON" className="sm:col-span-3">
            <Textarea name="summaryJson" placeholder='{"xpHour":0,"profit":0}' />
          </Field>
          <Field label="Notas" className="sm:col-span-3"><Textarea name="notes" /></Field>
        </div>
      </FormBody>
    </CollapsibleCard>
  );
}

function LearningSourceCard({ onRefresh }: { onRefresh: () => void }) {
  const { handleSubmit, busy, msg } = useFormSubmit({ url: "/api/learning-sources", onSuccess: onRefresh });
  return (
    <CollapsibleCard icon="F" iconKind="source" title="Fonte de ensino" wide>
      <FormBody onSubmit={handleSubmit} busy={busy} msg={msg} submitLabel="Salvar fonte">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Nome" className="sm:col-span-2"><Input name="name" required placeholder="Video hunt EK dragons" /></Field>
          <Field label="Tipo">
            <Select name="sourceType">
              <option value="video">Video</option>
              <option value="image">Imagem/frame</option>
              <option value="text">Texto</option>
              <option value="web-page">Pagina web</option>
              <option value="market-snapshot">Snapshot market</option>
              <option value="obs-recording">Gravacao OBS</option>
              <option value="replay">Replay</option>
              <option value="telemetry">Telemetria</option>
              <option value="manual-note">Nota manual</option>
            </Select>
          </Field>
          <Field label="Status">
            <Select name="status">
              <option value="pending">Pendente</option>
              <option value="processing">Processando</option>
              <option value="ready">Pronto</option>
              <option value="failed">Falhou</option>
              <option value="archived">Arquivado</option>
            </Select>
          </Field>
          <Field label="Confianca">
            <Select name="trustLevel">
              <option value="medium">Media</option>
              <option value="low">Baixa</option>
              <option value="high">Alta</option>
              <option value="verified">Verificada</option>
            </Select>
          </Field>
          <Field label="URI ou caminho" className="sm:col-span-3">
            <Input name="uri" placeholder="C:\videos\hunt.mp4 ou https://..." />
          </Field>
          <Field label="Hash"><Input name="contentHash" /></Field>
          <Field label="Idioma"><Input name="language" placeholder="pt-BR" /></Field>
          <Field label="Capturado em"><Input name="capturedAt" type="datetime-local" /></Field>
          <Field label="Metadata JSON" className="sm:col-span-3">
            <Textarea name="metadataJson" placeholder='{"hunt":"dragons"}' />
          </Field>
          <Field label="Notas" className="sm:col-span-3"><Textarea name="notes" /></Field>
        </div>
      </FormBody>
    </CollapsibleCard>
  );
}

function VideoUploadCard({ onRefresh }: { onRefresh: () => void }) {
  const { handleSubmit, busy, msg } = useFormSubmit({ url: "/api/learning-sources/upload-video", onSuccess: onRefresh, upload: true });
  return (
    <CollapsibleCard icon="V" iconKind="upload" title="Upload de vídeo de hunt" wide>
      <FormBody onSubmit={handleSubmit} busy={busy} msg={msg} submitLabel="Enviar video">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Nome" className="sm:col-span-2">
            <Input name="name" required placeholder="Hunt EK dragons 2026-06-16" />
          </Field>
          <Field label="Arquivo">
            <input
              name="video"
              type="file"
              required
              accept="video/mp4,video/webm,video/quicktime,video/x-matroska,video/x-msvideo,.mp4,.mkv,.mov,.avi,.webm"
              className="w-full rounded-[6px] border border-border bg-bg px-2 py-1.5 text-[13px] text-muted cursor-pointer"
            />
          </Field>
          <Field label="Tipo">
            <Select name="sourceType">
              <option value="video">Video</option>
              <option value="obs-recording">Gravacao OBS</option>
            </Select>
          </Field>
          <Field label="Confianca">
            <Select name="trustLevel">
              <option value="high">Alta</option>
              <option value="medium">Media</option>
              <option value="verified">Verificada</option>
              <option value="low">Baixa</option>
            </Select>
          </Field>
          <Field label="Hunt"><Input name="hunt" placeholder="Dragon Lair" /></Field>
          <Field label="Quest"><Input name="quest" /></Field>
          <Field label="Idioma"><Input name="language" defaultValue="pt-BR" /></Field>
          <Field label="Capturado em"><Input name="capturedAt" type="datetime-local" /></Field>
          <Field label="Notas" className="sm:col-span-3"><Textarea name="notes" /></Field>
        </div>
      </FormBody>
    </CollapsibleCard>
  );
}

function LearningMethodSourceCard({ state, onRefresh }: Props) {
  const { handleSubmit, busy, msg } = useFormSubmit({ url: "/api/learning-method-sources", onSuccess: onRefresh });
  return (
    <CollapsibleCard icon="V" iconKind="link" title="Vínculo fonte → método" wide>
      <FormBody onSubmit={handleSubmit} busy={busy} msg={msg} submitLabel="Vincular fonte">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Metodo">
            <Select name="methodId" required>
              <option value="">Selecionar...</option>
              {state.learningMethods.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </Select>
          </Field>
          <Field label="Fonte">
            <Select name="sourceId" required>
              <option value="">Selecionar...</option>
              {state.learningSources.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
          <Field label="Papel">
            <Select name="role">
              <option value="primary">Principal</option>
              <option value="validation">Validacao</option>
              <option value="reference">Referencia</option>
              <option value="negative-example">Exemplo negativo</option>
            </Select>
          </Field>
          <Field label="Peso"><Input name="weight" type="number" step="0.1" defaultValue="1" /></Field>
        </div>
      </FormBody>
    </CollapsibleCard>
  );
}
