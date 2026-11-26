// fetch() wrapper with a timeout and friendly errors.

export class HttpError extends Error {
  constructor(message, status, body, headers) {
    super(message);
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

export async function fetchJSON(url, { headers = {}, timeout = 20000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let res;
  try {
    res = await fetch(url, { headers, signal: ctrl.signal, cache: 'no-store' });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new HttpError('The request timed out. Check your connection and try again.', 0);
    if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new HttpError('You appear to be offline.', 0);
    throw new HttpError('Could not reach ' + new URL(url).host + '. Check your connection.', 0);
  }
  clearTimeout(timer);
  let body = null;
  const text = await res.text();
  try { body = text ? JSON.parse(text) : null; } catch (e) { body = text; }
  if (!res.ok) {
    const msg = (body && (body.message || body.error)) || res.statusText || 'Request failed';
    throw new HttpError(String(msg), res.status, body, res.headers);
  }
  return { data: body, headers: res.headers };
}
