export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string; code?: string };

/** A JSON request to this app's API: GET without a body, POST with one unless `method` says otherwise. */
export async function requestJson<T>(url: string, init: { method?: string; body?: unknown } = {}): Promise<ApiResult<T>> {
  const hasBody = init.body !== undefined;
  try {
    const res = await fetch(url, {
      method: init.method ?? (hasBody ? "POST" : "GET"),
      headers: hasBody ? { "Content-Type": "application/json" } : undefined,
      body: hasBody ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
    });
    const data: unknown = await res.json().catch(() => ({}));
    if (!res.ok) {
      const { error, code } = data as { error?: string; code?: string };
      return { ok: false, status: res.status, error: error ?? `HTTP ${res.status}`, code };
    }
    return { ok: true, data: data as T };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : "Network error" };
  }
}

export function postJson<T>(url: string, body: unknown): Promise<ApiResult<T>> {
  return requestJson<T>(url, { method: "POST", body });
}
