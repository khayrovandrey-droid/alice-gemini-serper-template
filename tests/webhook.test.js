import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { handleAlice, postWebhook, health, spokenText, MODEL } from '../lib/alice.js';
import { packState, unpackState, STATE_LIMIT } from '../lib/state.js';
import { searchPlan, extractSearch } from '../lib/search.js';

const env = { GEMINI_API_KEY: 'test-gemini-key', SERPER_API_KEY: 'test-serper-key' };
const silent = { error() {} };
function payload(command = '', state, isNew = false) {
  return { version: '1.0', meta: { timezone: 'Asia/Magadan' },
    session: { new: isNew, session_id: 'test-session', message_id: isNew ? 0 : 1, skill_id: 'test-skill' },
    request: { type: 'SimpleUtterance', command, original_utterance: command, nlu: { intents: {} } },
    state: { session: state || {} } };
}
function modelAnswer(text) { return Response.json({ candidates: [{ content: { parts: [{ text }] } }] }); }
function request(body, headers = { 'Content-Type': 'application/json' }) {
  return new Request('https://example.vercel.app/api', { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
}

test('launch and health work before the keys are added', async () => {
  const result = await handleAlice(payload('', undefined, true), { env: {} });
  assert.equal(result.version, '1.0');
  assert.equal(result.response.end_session, false);
  assert.match(result.response.text, /Привет/);
  assert.ok(result.session_state);
  assert.deepEqual(health({}).configured, { gemini: false, serper: false });
  assert.equal(health(env).status, 'ready');
});

test('missing keys produce valid Alice responses without outgoing requests', async () => {
  const fetchImpl = () => { throw new Error('Should not call the network'); };
  const gemini = await handleAlice(payload('Расскажи сказку'), { env: {}, fetchImpl });
  assert.match(gemini.response.text, /добавьте ключ Gemini/);
  const serper = await handleAlice(payload('Погода в Магадане'), { env: { GEMINI_API_KEY: 'x' }, fetchImpl });
  assert.match(serper.response.text, /ключ Serper/);
});

test('UTF-8 Cyrillic conversation round-trips within the complete 1-KiB envelope', () => {
  const turns = [['Меня зовут Андрей, я из Магадана.', 'Приятно познакомиться, Андрей.'], ['Как меня зовут?', 'Вас зовут Андрей.']];
  const state = packState(turns, 'погода в Магадане');
  assert.ok(Buffer.byteLength(JSON.stringify(state)) <= STATE_LIMIT);
  assert.deepEqual(unpackState(state), { h: turns, q: 'погода в Магадане' });
});

test('long incompressible histories are pruned in bytes and keep the latest exchange', () => {
  const turns = Array.from({ length: 30 }, (_, i) => [`Реплика ${i} ${randomBytes(600).toString('hex')}`, `Ответ ${i} ${randomBytes(300).toString('hex')}`]);
  const state = packState(turns, randomBytes(180).toString('hex'));
  assert.ok(Buffer.byteLength(JSON.stringify(state)) <= 1000);
  const decoded = unpackState(state);
  assert.ok(decoded.h.length > 0);
  assert.match(decoded.h.at(-1)[0], /^Реплика 29 /);
  assert.match(decoded.h.at(-1)[1], /^Ответ 29 /);
});

test('corrupt state and a compressed bomb are discarded safely', () => {
  for (const state of [null, { v: 2, z: 'abc' }, { v: 1, z: '!!!!' },
    { v: 1, z: deflateRawSync(Buffer.from(' '.repeat(100_000))).toString('base64url') }]) {
    assert.deepEqual(unpackState(state), { h: [], q: '' });
  }
});

test('context is sent back to Gemini, without requiring any warm process memory', async () => {
  let call;
  const state = packState([['Меня зовут Андрей.', 'Запомнила.']]);
  const result = await handleAlice(payload('Как меня зовут?', state), { env, logger: silent,
    fetchImpl: async (url, init) => { call = { url, init, body: JSON.parse(init.body) }; return modelAnswer('Вас зовут Андрей.'); } });
  assert.match(call.url, new RegExp(MODEL));
  assert.equal(call.init.headers['x-goog-api-key'], env.GEMINI_API_KEY);
  assert.ok(!call.url.includes(env.GEMINI_API_KEY));
  assert.deepEqual(call.body.contents.map(x => x.role), ['user', 'model', 'user']);
  assert.equal(call.body.contents[0].parts[0].text, 'Меня зовут Андрей.');
  assert.equal(call.body.generationConfig.thinkingConfig.thinkingLevel, 'minimal');
  assert.equal(result.response.tts, 'Вас зовут Андрей.');
  assert.equal(unpackState(result.session_state).h.length, 2);
});

test('new sessions discard previously supplied history', async () => {
  const state = packState([['Секрет прошлого разговора', 'Старый ответ']]);
  let contents;
  await handleAlice(payload('Почему небо синее?', state, true), { env, logger: silent,
    fetchImpl: async (_, init) => { contents = JSON.parse(init.body).contents; return modelAnswer('Из-за рассеяния света.'); } });
  assert.equal(contents.length, 1);
  assert.equal(contents[0].parts[0].text, 'Почему небо синее?');
});

test('reset, help, repeat and exit preserve the protocol without API calls', async () => {
  const state = packState([['Привет', 'Привет, Андрей.']], 'погода');
  const options = { env: {}, fetchImpl() { throw new Error('Unexpected fetch'); } };
  assert.equal((await handleAlice(payload('повтори', state), options)).response.text, 'Привет, Андрей.');
  const help = await handleAlice(payload('помощь', state), options);
  assert.deepEqual(unpackState(help.session_state).h, unpackState(state).h);
  const reset = await handleAlice(payload('забудь всё', state), options);
  assert.deepEqual(unpackState(reset.session_state).h, []);
  const exit = await handleAlice(payload('выход', state), options);
  assert.equal(exit.response.end_session, true);
  assert.deepEqual(unpackState(exit.session_state).h, []);
});

test('Yandex built-in intents and ButtonPressed are understood', async () => {
  const p = payload('', packState([['Вопрос', 'Ответ.']]));
  p.request.nlu.intents = { 'YANDEX.REPEAT': {} };
  assert.equal((await handleAlice(p, { env: {} })).response.text, 'Ответ.');
  p.request = { type: 'ButtonPressed', payload: { command: 'новый разговор' } };
  assert.deepEqual(unpackState((await handleAlice(p, { env: {} })).session_state).h, []);
});

test('search routing handles Russian queries and contextual follow-ups', () => {
  for (const query of ['Погода в Магадане', 'Что сегодня в новостях?', 'Сколько стоит доллар?', 'Найди в интернете сайт больницы', 'Кто сейчас президент Франции?']) {
    assert.equal(searchPlan(query).required, true, query);
  }
  for (const query of ['Почему небо синее?', 'Найди сумму двух и трёх', 'Как меня зовут?', 'Расскажи сказку']) {
    assert.equal(searchPlan(query).required, false, query);
  }
  const followup = searchPlan('А завтра?', 'Погода в Магадане');
  assert.match(followup.query, /Магадане.*завтра/su);
  assert.equal(followup.topic, 'Погода в Магадане');
});

test('fresh queries call Serper first and pass its evidence and links to Gemini', async () => {
  const calls = [];
  const result = await handleAlice(payload('Погода в Магадане'), { env, logger: silent,
    fetchImpl: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      if (url.includes('serper.dev')) return Response.json({ organic: [{ title: 'Прогноз', snippet: 'В Магадане минус два градуса.', link: 'https://example.org/weather' }] });
      return modelAnswer('В Магадане минус два градуса.');
    } });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://google.serper.dev/search');
  assert.equal(calls[0].init.headers['X-API-KEY'], env.SERPER_API_KEY);
  assert.equal(calls[0].body.hl, 'ru');
  assert.match(calls[1].body.contents.at(-1).parts[0].text, /минус два градуса/);
  assert.equal(result.response.buttons[0].url, 'https://example.org/weather');
  assert.equal(unpackState(result.session_state).q, 'Погода в Магадане');
});

test('unsafe source links are excluded', () => {
  const data = extractSearch({ organic: [{ title: 'bad', snippet: 'bad', link: 'javascript:alert(1)' },
    { title: 'ok', snippet: 'fact', link: 'https://example.org/info' }] });
  assert.equal(data.sources.length, 1);
  assert.ok(!data.context.includes('javascript:'));
});

test('failed search never falls back to unverified fresh facts', async () => {
  let calls = 0;
  const old = packState([['Меня зовут Андрей', 'Привет, Андрей.']]);
  const result = await handleAlice(payload('Погода в Магадане', old), { env, logger: silent,
    fetchImpl: async () => { calls++; return new Response('secret upstream body', { status: 401 }); } });
  assert.equal(calls, 1);
  assert.match(result.response.text, /Не удалось проверить/);
  assert.deepEqual(unpackState(result.session_state).h, unpackState(old).h);
});

test('global deadline bounds a provider ignoring cancellation and retains state', async () => {
  const old = packState([['Я Андрей', 'Привет, Андрей.']]);
  const started = Date.now();
  const result = await handleAlice(payload('Почему небо синее?', old), { env, logger: silent, budgetMs: 160,
    fetchImpl: async () => new Promise(() => {}) });
  assert.ok(Date.now() - started < 400);
  assert.match(result.response.text, /слишком много времени/);
  assert.deepEqual(unpackState(result.session_state).h, unpackState(old).h);
});

test('deadline also covers stalled response bodies', async () => {
  const started = Date.now();
  const result = await handleAlice(payload('Расскажи сказку'), { env, logger: silent, budgetMs: 130,
    fetchImpl: async () => ({ ok: true, json: () => new Promise(() => {}) }) });
  assert.ok(Date.now() - started < 500);
  assert.match(result.response.text, /слишком много времени/);
});

test('provider quota errors are concise and never leak error bodies or keys', async () => {
  const logs = [];
  const result = await handleAlice(payload('Объясни гравитацию'), { env,
    logger: { error: x => logs.push(x) }, fetchImpl: async () => new Response('secret: test-gemini-key', { status: 429 }) });
  assert.match(result.response.text, /лимита/);
  assert.ok(!JSON.stringify({ result, logs }).includes('test-gemini-key'));
  assert.equal(JSON.parse(logs[0]).status, 429);
});

test('empty or thought-only Gemini responses do not pollute conversation memory', async () => {
  const result = await handleAlice(payload('Расскажи сказку'), { env, logger: silent,
    fetchImpl: async () => Response.json({ candidates: [{ content: { parts: [{ thought: true, text: 'private reasoning' }] } }] }) });
  assert.ok(!result.response.text.includes('private reasoning'));
  assert.deepEqual(unpackState(result.session_state).h, []);
});

test('voice output strips markup and stays under 600 characters', () => {
  const value = spokenText('**Ответ** [источник](https://example.org) <speaker audio="bad"> 👍 ' + 'Очень длинное предложение. '.repeat(80));
  assert.ok(Array.from(value).length <= 600);
  assert.ok(!/\*|https?:|<speaker/u.test(value));
});

test('independent sessions do not share conversation state', async () => {
  const seen = [];
  const fetchImpl = async (_, init) => { const text = JSON.stringify(JSON.parse(init.body).contents); seen.push(text); return modelAnswer('Понятно.'); };
  await Promise.all([
    handleAlice(payload('Расскажи сказку', packState([['Я Андрей', 'Привет.']])), { env, logger: silent, fetchImpl }),
    handleAlice(payload('Объясни гравитацию', packState([['Я Елена', 'Привет.']])), { env, logger: silent, fetchImpl })
  ]);
  assert.ok(seen[0].includes('Андрей') && !seen[0].includes('Елена'));
  assert.ok(seen[1].includes('Елена') && !seen[1].includes('Андрей'));
});

test('a delayed Gemini model uses the backup and cancels the losing request', async () => {
  const signals = [];
  let winner;
  const started = Date.now();
  const result = await handleAlice(payload('Расскажи сказку'), { env, logger: silent, budgetMs: 250, backupDelayMs: 10,
    onModel(value) { winner = value; },
    fetchImpl: async (url, init) => {
      signals.push(init.signal);
      if (url.includes(MODEL)) return new Promise(() => {});
      return modelAnswer('Жили-были три поросёнка.');
    } });
  assert.equal(signals.length, 2);
  assert.equal(winner, 'gemini-3.1-flash-lite');
  assert.equal(signals[0].aborted, true);
  assert.ok(Date.now() - started < 200);
  assert.match(result.response.text, /поросёнка/);
});

test('HTTP webhook validates content type, JSON, size and Alice envelope', async () => {
  assert.equal((await postWebhook(request('{broken'))).status, 400);
  assert.equal((await postWebhook(request({}))).status, 400);
  assert.equal((await postWebhook(request('{}', { 'Content-Type': 'text/plain' }))).status, 415);
  assert.equal((await postWebhook(request(' '.repeat(33000)))).status, 413);
  const response = await postWebhook(request(payload('', undefined, true)), { env: {} });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('server-timing'), /^webhook;dur=\d+(?:\.\d+)?$/u);
  const body = await response.json();
  assert.equal(body.version, '1.0');
  assert.equal(typeof body.response.tts, 'string');
});
