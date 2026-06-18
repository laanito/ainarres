import { BASE_URL } from "../config";

// Poll the PostgREST root until it answers, so the suite is robust to the stack
// still warming up after `make up` (PostgREST starts after the migrate one-shot).
export async function waitForReady(timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE_URL}/`);
      if (res.ok) return;
      lastErr = new Error(`status ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`PostgREST not ready at ${BASE_URL} within ${timeoutMs}ms: ${lastErr}`);
}

type RpcOpts = { token?: string; body?: unknown };

export function rpc(name: string, { token, body = {} }: RpcOpts = {}): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${BASE_URL}/rpc/${name}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

// GET a PostgREST resource (table/view), e.g. restGet("board?lane=eq.m5", { token }).
export function restGet(path: string, { token }: { token?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${BASE_URL}/${path}`, { headers });
}
