import { Bell, Bot, Menu, PenLine, RefreshCw, Search } from "lucide-react";

/** The annotation UI is a separate host service (`npm run annotations:dev`). */
export const ANNOTATION_UI_URL = `http://${globalThis.location?.hostname ?? "127.0.0.1"}:4310`;
import type { User } from "../types.ts";
import type { PageId } from "./Sidebar.tsx";

const PAGE_NAMES: Record<PageId, string> = { dashboard: "Dashboard", entities: "Entidades", ops: "Operações", learning: "Aprendizado", catalog: "Catálogo", config: "Configurações" };
interface Props { user: User | null; onRefresh: () => void; currentPage?: PageId; onMenu?: () => void; }

export function TopBar({ user, onRefresh, currentPage = "dashboard", onMenu }: Props) {
  return <header className="topbar">
    {!user ? <div className="topbar-login-brand"><span className="brand-mark"><Bot size={21} /></span><strong>Botzin</strong></div> : <>
      <div className="topbar-context">
        <button className="mobile-menu" onClick={onMenu} aria-label="Abrir menu"><Menu size={20} /></button>
        <div><div className="breadcrumb"><span>Workspace</span><span>/</span><strong>{PAGE_NAMES[currentPage]}</strong></div></div>
      </div>
      <div className="topbar-actions">
        <label className="global-search"><Search size={16} /><input aria-label="Busca global" placeholder="Buscar no sistema..." /><kbd>⌘ K</kbd></label>
        <a className="topbar-tool" href={ANNOTATION_UI_URL} target="_blank" rel="noreferrer" title="Abrir o anotador humano (porta 4310)">
          <PenLine size={15} />Anotação humana
        </a>
        <button className="icon-button" onClick={onRefresh} title="Atualizar dados" aria-label="Atualizar dados"><RefreshCw size={17} /></button>
        <button className="icon-button notification-button" title="Notificações" aria-label="Notificações"><Bell size={17} /><span /></button>
        <span className="environment-badge"><i />Local</span>
      </div>
    </>}
  </header>;
}
