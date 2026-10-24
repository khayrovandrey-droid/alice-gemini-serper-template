import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/index.js';
import { packState, unpackState } from '../lib/state.js';

function response() {
  return { statusCode: 200, headers: {}, payload: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    json(data) { this.payload = data; return this; },
    end() { return this; }
  };
}
function body(command = '', state = {}, isNew = false) {
  return { version: '1.0', session: { session_id: 'test', message_id: 1, new: isNew },
    request: { type: 'SimpleUtterance', command }, state: { session: state } };
}
test('Vercel Node adapter returns health and safe configuration flags', async () => {
  const res = response();
  await handler({ method: 'GET' }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.revision, 'voice-repair-20261024-r2');
  assert.equal(typeof res.payload.configured.gemini, 'boolean');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.ok(!JSON.stringify(res.payload).includes('API_KEY='));
});
test('Node adapter preserves the Alice protocol and response timing header', async () => {
  const res = response();
  await handler({ method: 'POST', body: body('', {}, true) }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.version, '1.0');
  assert.equal(res.payload.response.end_session, false);
  assert.match(res.payload.response.text, /Привет/);
  assert.match(res.headers['server-timing'], /webhook;dur=/);
});
test('legacy history migrates, remains repeatable and stays under the byte limit', async () => {
  const legacy = { history: [{ role: 'user', text: 'Я Андрей' }, { role: 'model', text: 'Привет, Андрей.' }] };
  const res = response();
  await handler({ method: 'POST', body: body('повтори', legacy) }, res);
  assert.equal(res.payload.response.tts, 'Привет, Андрей.');
  assert.deepEqual(unpackState(res.payload.session_state).h, [['Я Андрей', 'Привет, Андрей.']]);
  assert.ok(Buffer.byteLength(JSON.stringify(res.payload.session_state)) <= 1024);
});
test('Node adapter handles reset, goodbye and unsupported methods locally', async () => {
  const state = packState([['Вопрос', 'Ответ']]);
  const reset = response();
  await handler({ method: 'POST', body: body('забудь всё', state) }, reset);
  assert.deepEqual(unpackState(reset.payload.session_state).h, []);
  const stop = response();
  await handler({ method: 'POST', body: body('выход', state) }, stop);
  assert.equal(stop.payload.response.end_session, true);
  const invalid = response();
  await handler({ method: 'PUT' }, invalid);
  assert.equal(invalid.statusCode, 405);
});
test('invalid JSON and malformed Alice envelopes are rejected', async () => {
  const broken = response();
  await handler({ method: 'POST', body: '{bad' }, broken);
  assert.equal(broken.statusCode, 400);
  const missing = response();
  await handler({ method: 'POST', body: {} }, missing);
  assert.equal(missing.statusCode, 400);
});
