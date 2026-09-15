const TOKEN_KEY = "botzin.config.token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, options);

  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { error?: string; message?: string };
      message = body.error ?? body.message ?? message;
    } catch {
      // ignore json parse failure
    }
    throw new ApiError(response.status, message);
  }

  const text = await response.text();
  return text ? (JSON.parse(text) as T) : ({} as T);
}

function authHeaders(): HeadersInit {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Server-sent events over fetch instead of EventSource: EventSource cannot carry
 * the bearer header, and putting the token in the query string would leak it into
 * every access log. Returns a disposer.
 */
export function apiStream<T>(path: string, onMessage: (value: T) => void, onError: (message: string) => void): () => void {
  const controller = new AbortController();
  void (async () => {
    try {
      const response = await fetch(path, { headers: authHeaders(), signal: controller.signal });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        // SSE frames are separated by a blank line; anything else is a comment.
        let split = buffer.indexOf("\n\n");
        while (split !== -1) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
          if (data) {
            try { onMessage(JSON.parse(data) as T); } catch { onError("Evento inválido recebido."); }
          }
          split = buffer.indexOf("\n\n");
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) onError(error instanceof Error ? error.message : "Conexão perdida.");
    }
  })();
  return () => controller.abort();
}

export async function apiFetch<T>(url: string, options: RequestInit = {}): Promise<T> {
  return request<T>(url, {
    ...options,
    headers: { ...options.headers, ...authHeaders() },
  });
}

export async function apiFetchBlob(url: string): Promise<Blob> {
  const response = await fetch(url, { headers: authHeaders() });
  if (!response.ok) throw new ApiError(response.status, `HTTP ${response.status}`);
  return response.blob();
}

export async function apiPost<T>(url: string, body: unknown): Promise<T> {
  return apiFetch<T>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function apiUpload<T>(url: string, formData: FormData): Promise<T> {
  return apiFetch<T>(url, { method: "POST", body: formData });
}

export function buildPayload(formData: FormData): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of formData.entries()) {
    if (value instanceof File) {
      payload[key] = value;
    } else {
      payload[key] = value === "" ? null : value;
    }
  }
  return payload;
}
