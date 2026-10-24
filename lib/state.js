import { deflateRawSync, inflateRawSync } from 'node:zlib';

// Yandex limits the entire JSON session_state to 1 KiB, in UTF-8 bytes.
export const STATE_LIMIT = 1000;
const MAX_INFLATED_BYTES = 24_000;
const MAX_TURNS = 8;

export function clip(value, limit) {
  return Array.from(typeof value === 'string' ? value : '').slice(0, limit).join('');
}

function cleanTurns(turns) {
  if (!Array.isArray(turns)) return [];
  return turns.filter(t => Array.isArray(t) && t.length === 2 &&
    typeof t[0] === 'string' && typeof t[1] === 'string')
    .slice(-MAX_TURNS).map(([u, a]) => [clip(u, 1200), clip(a, 600)]);
}

function encode(data) {
  return { v: 1, z: deflateRawSync(Buffer.from(JSON.stringify(data)), { level: 9 }).toString('base64url') };
}

export function unpackState(state) {
  try {
    // Migrate conversations created by the previous uncompressed template.
    if (Array.isArray(state?.history) && !state.z) {
      const h = [];
      let pending;
      for (const item of state.history.slice(-16)) {
        if (!item || typeof item.text !== 'string') continue;
        if (item.role === 'user') pending = item.text;
        else if (item.role === 'model' && pending !== undefined) {
          h.push([pending, item.text]);
          pending = undefined;
        }
      }
      return { h: cleanTurns(h), q: '' };
    }
    if (state?.v !== 1 || typeof state.z !== 'string' || state.z.length > 1300 ||
        !/^[A-Za-z0-9_-]+$/.test(state.z)) return { h: [], q: '' };
    const raw = inflateRawSync(Buffer.from(state.z, 'base64url'), { maxOutputLength: MAX_INFLATED_BYTES });
    const data = JSON.parse(raw.toString('utf8'));
    return { h: cleanTurns(data?.h), q: clip(data?.q, 180) };
  } catch {
    return { h: [], q: '' };
  }
}

export function packState(history, searchTopic = '') {
  const data = { h: cleanTurns(history), q: clip(searchTopic, 180) };
  let state = encode(data);
  while (Buffer.byteLength(JSON.stringify(state), 'utf8') > STATE_LIMIT) {
    if (data.h.length > 1) {
      data.h.shift();
    } else if (data.q.length > 80) {
      data.q = clip(data.q, 80);
    } else if (data.h.length) {
      const [u, a] = data.h[0];
      // Keep the most recent exchange even if a long input is incompressible.
      data.h[0] = [clip(u, Math.floor(Array.from(u).length * 0.8)),
        clip(a, Math.floor(Array.from(a).length * 0.8))];
    } else {
      data.q = '';
    }
    state = encode(data);
  }
  return state;
}
