'use strict';

// Minimal HTTPS client for the z.ai GLM Coding Plan usage endpoint.
// No dependencies; the API key is used only for the Authorization header and
// never appears in errors, logs, or returned data.
//
// Contract verified against community tooling that queries the same endpoint:
//   GET {host}/api/monitor/usage/quota/limit
//   Authorization: Bearer <key>   (one retry without the prefix on 401)
// The key is only ever sent to the one configured host (zaiQuota.host);
// there is deliberately no cross-host fallback.
//   200 { success: true, data: { level, limits: [...] } }
//   200 { success: false, code, msg }   (e.g. expired/invalid token)

const https = require('https');

const PATH = '/api/monitor/usage/quota/limit';
const HOSTS = ['api.z.ai', 'open.bigmodel.cn']; // first is the default
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_BODY_BYTES = 1024 * 1024;

function classified(reason, message) {
  return Object.assign(new Error(message), { reason });
}

function requestJson(host, authorization, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let deadline = null;
    const finish = (fn, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(deadline);
      fn(value);
    };

    const req = https.request(
      {
        host,
        path: PATH,
        method: 'GET',
        headers: { Authorization: authorization, Accept: 'application/json' },
        timeout: timeoutMs,
      },
      (res) => {
        // A disconnected response does not necessarily emit a request error
        // or timeout. Always settle it so the monitor can poll again.
        const interrupted = () => finish(reject, classified('network', 'z.ai usage response was interrupted.'));
        res.on('error', interrupted);
        res.on('aborted', interrupted);
        res.on('close', () => { if (!res.complete) interrupted(); });
        let receivedBytes = 0;
        let body = '';
        res.on('data', (chunk) => {
          receivedBytes += Buffer.byteLength(chunk);
          body += chunk;
          if (receivedBytes > MAX_BODY_BYTES) {
            finish(reject, classified('http', 'z.ai usage response was too large.'));
            req.destroy();
          }
        });
        res.on('end', () => {
          if (settled) {
            return;
          }
          let parsed;
          try {
            parsed = JSON.parse(body);
          } catch {
            finish(reject, classified('bad-json', 'z.ai usage endpoint returned a non-JSON response.'));
            return;
          }
          finish(resolve, { status: res.statusCode, body: parsed });
        });
      }
    );

    const onTimeout = () => {
      finish(reject, classified('timeout', 'z.ai usage endpoint timed out.'));
      req.destroy();
    };
    req.on('timeout', onTimeout);
    // Socket inactivity timeouts alone do not bound DNS/TLS or trickle reads.
    deadline = setTimeout(onTimeout, timeoutMs);
    req.on('error', (err) => {
      finish(reject, classified('network', 'Usage endpoint network request failed.'));
    });
    req.end();
  });
}

// Auth failures in a 200 { success: false } body. Matched narrowly so
// unrelated messages such as "token limit exceeded" are not mistaken for a
// rejected key.
const AUTH_MESSAGE =
  /unauthori[sz]ed|authenticat|\b(invalid|expired)\b.{0,20}\b(key|token)\b|\b(key|token)\b.{0,20}\b(invalid|expired)\b/i;

function classifyBody(res) {
  const body = res.body;
  if (body && typeof body === 'object' && body.success === false) {
    const code = typeof body.code === 'number' ? body.code : 0;
    const msg = typeof body.msg === 'string' ? body.msg : 'unknown error';
    if (code === 401 || code === 403 || AUTH_MESSAGE.test(msg)) {
      return { error: classified('unauthorized', 'z.ai rejected the API key.') };
    }
    return { error: classified('api', 'z.ai usage API error.') };
  }
  if (!body || typeof body !== 'object' || !body.data) {
    return { error: classified('api', 'z.ai usage response had no data field.') };
  }
  return { body };
}

// One request attempt with a specific Authorization header.
// Returns { body } on success or { error, transient } on failure.
async function attempt(host, authorization, timeoutMs) {
  let res;
  try {
    res = await requestJson(host, authorization, timeoutMs);
  } catch (err) {
    // host unreachable/slow is transient; bad-json etc. is not
    return { error: err, transient: err.reason === 'network' || err.reason === 'timeout' };
  }
  if (res.status === 401 || res.status === 403) {
    return { error: classified('unauthorized', `z.ai rejected the API key (HTTP ${res.status}).`), transient: false };
  }
  if (res.status === 429) {
    return { error: classified('rate-limited', 'z.ai usage endpoint rate-limited the request.'), transient: false };
  }
  if (res.status !== 200) {
    return { error: classified('http', `z.ai usage endpoint on ${host} returned HTTP ${res.status}.`), transient: false };
  }
  const result = classifyBody(res);
  if (result.error) {
    // The gateway intermittently answers 200 with a "404 NOT_FOUND" error
    // body; retrying usually succeeds.
    const transient = result.error.reason === 'api' && (res.body.code === 404 || /404/.test(String(res.body.msg)));
    return { error: result.error, transient };
  }
  return { body: result.body };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Fetches usage with the user's z.ai API key from one host (an entry of
// HOSTS; anything else falls back to the default). Resolves { body, host }.
// Rejects with err.reason in ('unauthorized' | 'rate-limited' | 'http' |
//  'bad-json' | 'api' | 'timeout' | 'network').
async function fetchUsage(apiKey, options = {}) {
  const host = HOSTS.includes(options.host) ? options.host : HOSTS[0];
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  let outcome;
  for (const authorization of [`Bearer ${apiKey}`, apiKey]) {
    for (let attemptNo = 0; attemptNo < 2; attemptNo += 1) {
      outcome = await attempt(host, authorization, timeoutMs);
      if (!outcome.transient) {
        break;
      }
      if (attemptNo === 0) {
        await sleep(400); // transient gateway error; one quick retry
      }
    }
    if (outcome.body) {
      return { body: outcome.body, host };
    }
    if (outcome.error.reason !== 'unauthorized') {
      break; // only an auth rejection is worth retrying without the prefix
    }
  }
  throw outcome.error;
}

module.exports = { fetchUsage, PATH, HOSTS, AUTH_MESSAGE };
