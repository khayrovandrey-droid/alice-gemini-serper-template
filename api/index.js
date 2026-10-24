import { health, json, postWebhook } from '../lib/alice.js';

export default async function handler(req, res) {
  let response;
  let upstreamError;
  let searched = false;
  let model;
  if (req.method === 'GET' || req.method === 'HEAD') {
    response = json(health());
  } else if (req.method === 'POST') {
    const raw = typeof req.body === 'string' || Buffer.isBuffer(req.body)
      ? req.body : JSON.stringify(req.body ?? {});
    const request = new Request('https://alice-webhook.invalid/api', {
      method: 'POST',
      headers: { 'Content-Type': req.headers?.['content-type'] || 'application/json' },
      body: raw
    });
    response = await postWebhook(request, {
      onUpstreamError(error) { upstreamError = `${error.service}:${error.kind}:${error.status || 0}`; },
      onSearch() { searched = true; },
      onModel(value) { model = value; }
    });
  } else {
    response = json({ error: 'Method not allowed' }, 405, { Allow: 'GET, HEAD, POST' });
  }
  for (const [name, value] of response.headers) res.setHeader(name, value);
  res.setHeader('X-Assistant-Revision', 'voice-repair-20261024-r2');
  if (model) res.setHeader('X-Assistant-Model', model);
  if (upstreamError) res.setHeader('X-Assistant-Error', upstreamError);
  if (searched) res.setHeader('X-Assistant-Search', 'serper');
  if (req.method === 'HEAD') return res.status(response.status).end();
  return res.status(response.status).json(await response.json());
}
