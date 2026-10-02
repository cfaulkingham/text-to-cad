// Preserve request context across the artifact hook. A transport failure is not a
// compiler diagnosis; callers can explain it without guessing what the server did.
export class ViewerRequestError extends Error {
  constructor(failure, cause) {
    super(failure.detail, { cause });
    this.name = "ViewerRequestError";
    this.failure = failure;
  }
}

export function serverErrorMessage(payload) {
  const value = payload?.error || payload?.result?.error || payload?.result?.validation?.error;
  if (typeof value === "string") return value.trim();
  return String(value?.message || payload?.message || payload?.reason || "").trim();
}

export async function requestViewerJson(url, options, operation, settings = {}) {
  return (await sendViewerRequest(url, options, operation, settings)).payload;
}

/**
 * A GET for a copy the caller already holds: `etag` is the entity tag that copy came with, sent as
 * `If-None-Match`. A server that finds it current answers 304 with no body, and this answers
 * `{ notModified: true, etag }`; otherwise `{ notModified: false, etag, payload }`, with the tag the
 * new copy came with ("" from a server that sends none, which never answers 304 either).
 */
export async function requestViewerJsonIfChanged(url, options, operation, { etag = "", ...settings } = {}) {
  const tag = String(etag || "");
  const headers = tag ? { ...(options?.headers || {}), "if-none-match": tag } : options?.headers;
  const { response, payload } = await sendViewerRequest(url, { ...options, ...(headers ? { headers } : {}) }, operation,
    { ...settings, notModified: Boolean(tag) });
  const answered = String(response.headers?.get?.("etag") || "");
  return response.status === 304 && tag
    ? { notModified: true, etag: answered || tag }
    : { notModified: false, etag: answered, payload };
}

async function sendViewerRequest(url, options, operation, { timeoutMs = 0, fetch: fetchImpl = globalThis.fetch, notModified = false } = {}) {
  const requestUrl = typeof window !== "undefined" && window.location?.href
    ? new URL(url, window.location.href).href : url;
  const context = { operation, url: requestUrl, method: options?.method || "GET" };
  const parentSignal = options?.signal;
  const timed = Number(timeoutMs) > 0 && context.method === "GET";
  const controller = timed ? new AbortController() : null;
  let timedOut = false;
  let timer = 0;
  const abortFromParent = () => controller?.abort(parentSignal?.reason);
  if (controller && parentSignal) {
    if (parentSignal.aborted) abortFromParent();
    else parentSignal.addEventListener("abort", abortFromParent, { once: true });
  }
  if (controller) {
    timer = globalThis.setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException("Status request timed out", "TimeoutError"));
    }, Number(timeoutMs));
  }
  const requestOptions = controller ? { ...options, signal: controller.signal } : options;
  let response;
  try {
    parentSignal?.throwIfAborted();
    response = await fetchImpl(url, requestOptions);
    parentSignal?.throwIfAborted();
  } catch (cause) {
    if (timer) globalThis.clearTimeout(timer);
    parentSignal?.removeEventListener?.("abort", abortFromParent);
    if (parentSignal?.aborted) throw cause;
    if (timedOut) {
      throw new ViewerRequestError({
        ...context, kind: "timeout",
        detail: `The server did not respond within ${Math.round(Number(timeoutMs) / 1000)} seconds.`
      }, cause);
    }
    if (cause?.name === "AbortError") throw cause;
    throw new ViewerRequestError({ ...context, kind: "network", detail: String(cause?.message || cause) }, cause);
  }
  // A conditional GET the server answered "current" carries no body worth reading; it is read all
  // the same, since a browser logs a response whose (empty) body nobody read as an aborted request.
  if (notModified && response.status === 304) {
    try { await response.text?.(); } catch { /* nothing was in it */ }
    if (timer) globalThis.clearTimeout(timer);
    parentSignal?.removeEventListener?.("abort", abortFromParent);
    return { response, payload: undefined };
  }
  let payload;
  try {
    payload = await response.json();
    parentSignal?.throwIfAborted();
  } catch (cause) {
    if (parentSignal?.aborted) throw cause;
    if (timedOut) {
      throw new ViewerRequestError({
        ...context, kind: "timeout",
        detail: `The server did not respond within ${Math.round(Number(timeoutMs) / 1000)} seconds.`
      }, cause);
    }
    if (cause?.name === "AbortError") throw cause;
    throw new ViewerRequestError({
      ...context, kind: response.ok ? "response" : "http", status: response.status,
      detail: response.ok ? "The server returned an unreadable JSON response." : `HTTP ${response.status} ${response.statusText}`.trim()
    }, cause);
  } finally {
    if (timer) globalThis.clearTimeout(timer);
    parentSignal?.removeEventListener?.("abort", abortFromParent);
  }
  if (!response.ok) {
    throw new ViewerRequestError({
      ...context, kind: payload?.state === "failed" ? "compile" : "http", status: response.status,
      detail: serverErrorMessage(payload) || `HTTP ${response.status} ${response.statusText}`.trim()
    });
  }
  return { response, payload };
}
