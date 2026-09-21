export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string; code?: string };

export async function postJson<T>(url: string, body: unknown): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
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
