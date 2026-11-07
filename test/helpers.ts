// A stand-in for api.stripe.com: routes by method and path, records every request.
export interface Call {
  method: string;
  path: string;
  params: URLSearchParams;
  headers: Headers;
}

export type Route = (call: Call) => unknown | { status: number; body: unknown };

export function fakeStripe(routes: Record<string, Route>) {
  const calls: Call[] = [];
  const fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const params = method === 'POST' ? new URLSearchParams(String(init.body ?? '')) : url.searchParams;
    const call = { method, path: url.pathname, params, headers: new Headers(init.headers) };
    calls.push(call);
    const route = routes[`${method} ${url.pathname}`];
    if (!route) return Response.json({ error: { message: `No route ${method} ${url.pathname}`, code: 'resource_missing' } }, { status: 404 });
    const out = route(call) as { status?: number; body?: unknown };
    if (out && typeof out === 'object' && typeof out.status === 'number') return Response.json(out.body, { status: out.status });
    return Response.json(out);
  };
  return { calls, fetch: fetch as typeof globalThis.fetch };
}
