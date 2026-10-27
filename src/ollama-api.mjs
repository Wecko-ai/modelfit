// Minimal client for the local Ollama HTTP API, used by `modelfit bench`. node:http only: fetch
// carries undici's 300 s headers timeout (a 27B prompt on a slow machine can exceed it) and an
// experimental warning on Node 18. The host is OLLAMA_HOST or 127.0.0.1:11434 and must be this
// machine: the bench measures the local hardware and submits its fingerprint, so a remote Ollama
// would pair one machine's speed with another machine's specs.

import http from 'node:http';
import https from 'node:https';

const DEFAULT_PORT = 11434;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '::']);

/**
 * Where the local Ollama server listens, from OLLAMA_HOST ("127.0.0.1:11434", "http://localhost",
 * "0.0.0.0", ":11500", "[::1]:11434") or the default. A bind-all address (0.0.0.0, ::) is reached on
 * loopback. Returns { hostname, port } or { error: 'ollama-host-not-local', host } for any other host.
 */
export function ollamaHost(raw = process.env.OLLAMA_HOST) {
  const value = String(raw ?? '').trim();
  if (!value) return { hostname: '127.0.0.1', port: DEFAULT_PORT };
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value.startsWith(':') ? `127.0.0.1${value}` : value}`);
  } catch {
    return { error: 'ollama-host-not-local', host: value };
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const loopback = LOCAL_HOSTS.has(host) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  if (url.protocol !== 'http:' || !loopback) return { error: 'ollama-host-not-local', host: value };
  const hostname = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
  return { hostname, port: url.port ? Number(url.port) : DEFAULT_PORT };
}

/**
 * Splits a byte stream into JSON objects, one per line (Ollama's streaming format). `push` takes a
 * chunk of text, `end` flushes the last line. A line that is not JSON throws.
 */
export function ndjsonSplitter(onObject) {
  let buffer = '';
  const emit = (line) => {
    const t = line.trim();
    if (t) onObject(JSON.parse(t));
  };
  return {
    push(chunk) {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        emit(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    },
    end() {
      emit(buffer);
      buffer = '';
    },
  };
}

/** Every object of a complete NDJSON text. */
export function parseNdjson(text) {
  const out = [];
  const s = ndjsonSplitter((o) => out.push(o));
  s.push(String(text));
  s.end();
  return out;
}

/**
 * One HTTP request with a JSON body. `onObject` set = the response is NDJSON and each object is
 * handed over as it arrives; otherwise the whole body is parsed once. Resolves { status, json,
 * location } (json is the last object for a stream; location is the redirect target, if any). `idleMs` aborts when no byte arrives for that long,
 * `totalMs` caps the whole exchange.
 */
export function requestJson(target, { method = 'GET', body, onObject, idleMs = 30000, totalMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = typeof target === 'string' ? new URL(target) : null;
    const lib = url?.protocol === 'https:' ? https : http;
    const payload = body === undefined ? null : JSON.stringify(body);
    // Credentials in the URL (a password-protected staging server) become basic auth.
    const auth = url?.username ? `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}` : undefined;
    const options = url
      ? { protocol: url.protocol, hostname: url.hostname.replace(/^\[|\]$/g, ''), port: url.port || undefined, path: `${url.pathname}${url.search}`, auth }
      : { hostname: target.hostname, port: target.port, path: target.path };
    const req = lib.request({
      ...options,
      method,
      headers: {
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    });
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(total);
      fn(value);
    };
    const total = setTimeout(() => req.destroy(new Error(`timed out after ${Math.round(totalMs / 1000)} s`)), totalMs);
    req.setTimeout(idleMs, () => req.destroy(new Error(`no response for ${Math.round(idleMs / 1000)} s`)));
    req.on('error', (err) => finish(reject, err));
    req.on('response', (res) => {
      res.setEncoding('utf8');
      let last = null;
      let text = '';
      const streaming = onObject && res.statusCode === 200;
      const splitter = streaming
        ? ndjsonSplitter((o) => {
            last = o;
            onObject(o);
          })
        : null;
      res.on('data', (chunk) => {
        try {
          if (splitter) splitter.push(chunk);
          else if (text.length < 1024 * 1024) text += chunk;
        } catch (err) {
          req.destroy(err);
        }
      });
      res.on('end', () => {
        try {
          if (splitter) splitter.end();
          else last = text.trim() ? JSON.parse(text) : null;
          finish(resolve, { status: res.statusCode, json: last, location: res.headers.location ?? null });
        } catch {
          finish(resolve, { status: res.statusCode, json: null, location: res.headers.location ?? null });
        }
      });
      res.on('error', (err) => finish(reject, err));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

/** Thin wrapper bound to the local Ollama server. Throws when OLLAMA_HOST is not this machine. */
export function ollamaClient(raw = process.env.OLLAMA_HOST) {
  const host = ollamaHost(raw);
  if (host.error) {
    const err = new Error(`OLLAMA_HOST=${host.host} is not this machine`);
    err.code = host.error;
    throw err;
  }
  const at = (path) => ({ hostname: host.hostname, port: host.port, path });
  const call = async (path, opts) => {
    const res = await requestJson(at(path), opts);
    if (res.status !== 200) {
      const err = new Error(res.json?.error || `Ollama answered HTTP ${res.status} on ${path}`);
      err.status = res.status;
      throw err;
    }
    return res.json;
  };
  return {
    host,
    /** '0.40.6' */
    version: async () => (await call('/api/version', { idleMs: 3000, totalMs: 5000 }))?.version ?? null,
    /** Installed models ({ name, size, digest, details }). */
    tags: async () => (await call('/api/tags', { idleMs: 5000, totalMs: 10000 }))?.models ?? [],
    /** Loaded models ({ name, size, size_vram, digest, context_length?, details }). */
    ps: async () => (await call('/api/ps', { idleMs: 5000, totalMs: 10000 }))?.models ?? [],
    show: (model) => call('/api/show', { method: 'POST', body: { model }, idleMs: 10000, totalMs: 20000 }),
    /** Unloads a model from memory (keep_alive 0), which also drops its prompt cache. */
    unload: (model) => call('/api/generate', { method: 'POST', body: { model, keep_alive: 0, stream: false }, idleMs: 30000, totalMs: 60000 }),
    /**
     * Streams one generation and resolves the final `done: true` object, which carries
     * eval_count, eval_duration, prompt_eval_count, prompt_eval_duration and load_duration.
     */
    generate: async (body, { onToken, idleMs = 180000, totalMs = 900000 } = {}) => {
      let error = null;
      const final = await call('/api/generate', {
        method: 'POST',
        body: { ...body, stream: true },
        idleMs,
        totalMs,
        onObject: (o) => {
          if (o?.error) error = o.error;
          else if (!o?.done && onToken) onToken(o);
        },
      });
      if (error) throw new Error(error);
      if (!final?.done) throw new Error('the stream ended before Ollama reported done');
      return final;
    },
  };
}
