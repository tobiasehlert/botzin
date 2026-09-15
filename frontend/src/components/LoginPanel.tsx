import { useState, type FormEvent } from "react";
import { AlertCircle, Bot, LoaderCircle, LockKeyhole, UserRound } from "lucide-react";
import { Field, Input } from "./Field.tsx";
import { Button } from "./ui.tsx";

interface Props { onLogin: (username: string, password: string) => Promise<void>; }
export function LoginPanel({ onLogin }: Props) {
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  async function handleSubmit(e: FormEvent<HTMLFormElement>) { e.preventDefault(); const data = new FormData(e.currentTarget); setBusy(true); setError(""); try { await onLogin(String(data.get("username")), String(data.get("password"))); } catch (err) { setError(err instanceof Error ? err.message : "Erro ao entrar"); } finally { setBusy(false); } }
  return <div className="login-layout">
    <aside className="login-story">
      <div><h1>Automação inteligente.<br /><span>Controle absoluto.</span></h1><p>Centralize operações, aprendizado e monitoramento do seu ecossistema em um só lugar.</p></div>
    </aside>
    <main className="login-panel">
      <form onSubmit={handleSubmit} className="login-card">
        <span className="brand-mark"><Bot size={22} /></span><h2>Bem-vindo de volta</h2><p className="login-subtitle">Use suas credenciais para acessar o workspace.</p>
        <div className="login-fields">
          <Field label="Usuário" required><div className="input-with-icon"><UserRound size={16} /><Input name="username" autoComplete="username" required placeholder="Seu usuário" autoFocus /></div></Field>
          <Field label="Senha" required><div className="input-with-icon"><LockKeyhole size={16} /><Input name="password" type="password" autoComplete="current-password" required placeholder="Sua senha" /></div></Field>
        </div>
        {error && <p className="login-error" role="alert"><AlertCircle size={15} />{error}</p>}
        <Button type="submit" variant="primary" disabled={busy} className="w-full">{busy && <LoaderCircle className="animate-spin" size={16} />}{busy ? "Autenticando..." : "Entrar no sistema"}</Button>
        <p className="login-help">Acesso restrito a usuários autorizados.</p>
      </form>
    </main>
  </div>;
}
