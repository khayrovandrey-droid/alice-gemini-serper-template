import { clip } from './state.js';

export function normalize(value) {
  return (typeof value === 'string' ? value : '').toLocaleLowerCase('ru-RU')
    .replace(/ё/g, 'е').replace(/[!?.,;:]+$/gu, '').trim().replace(/\s+/g, ' ');
}

// Local routing avoids an extra LLM round trip inside Alice's 4.5-second limit.
const EXPLICIT = /(?:найди|поищи|погугли|загугли|проверь|проверить|посмотри|узнай).*(?:интернет|сети|сайт|источник)|^(?:найди|поищи|погугли|загугли|проверь в сети|поищи в интернете)(?:\s|$)/u;
const STABLE_TASK = /(?:найди|проверь)\s+(?:сумму|разность|произведение|корень|производную|интеграл|ошибк|рифм|синоним|антоним|площадь|периметр|значение выражения)/u;
const FRESH = /сегодня|завтра|послезавтра|вчера|сейчас|на данный момент|актуальн|текущ|последни[йехм]|последняя|свежи[йех]|что нового|в этом (?:году|месяце)|на этой неделе/u;
const CHANGING = /погод|прогноз|новост|курс.{0,25}(?:доллар|евро|валют|рубл|биткоин)|(?:доллар|евро).{0,20}(?:рубл|курс)|цен[ауы]|стоимост|сколько стоит|расписан|рейс|афиш|времен[ия] работы|часы работы|открыт[оаы]? ли|в наличии|наличие билет|кто.{0,20}(?:президент|премьер|губернатор|мэр|гендиректор|директор|министр)|(?:результат|счет|итог).{0,20}(?:матч|игр|выбор)|(?:новая|последняя|свежая) версия|когда.{0,20}(?:выйдет|откроется)|(?:порекомендуй|посоветуй|подбери).{0,40}(?:купить|отель|ресторан|кафе|телефон|ноутбук)/u;
const CONTINUATION = /^(?:(?:а|и)\s+(?:в |на |завтра|сегодня|послезавтра|сколько|когда|где|там|что|как насчет)|(?:а\s+)?(?:там|туда|его|ее|их|этого|этой|этот|этот же|такой же|завтра|послезавтра|на выходных)(?:\s|$))/u;

export function searchPlan(command, previousTopic = '') {
  const value = normalize(command);
  const contextual = Boolean(previousTopic && value.length < 140 && CONTINUATION.test(value));
  const explicit = EXPLICIT.test(value) && !STABLE_TASK.test(value);
  const required = explicit || FRESH.test(value) || CHANGING.test(value) || contextual;
  if (!required) return { required: false, query: '', topic: '' };
  const topic = contextual ? previousTopic : clip(command, 180);
  return { required: true, query: clip(contextual ? `${previousTopic}. Уточнение: ${command}` : command, 500), topic };
}

export function safeUrl(value) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
        Buffer.byteLength(url.href) > 1024) return null;
    return url.href;
  } catch { return null; }
}

export function extractSearch(data) {
  const sources = [];
  const facts = [];
  const box = data?.answerBox;
  if (box) {
    const answer = [box.title, box.answer, box.snippet, ...(Array.isArray(box.snippetHighlighted) ? box.snippetHighlighted : [])]
      .filter(x => typeof x === 'string').join(' — ');
    if (answer) facts.push(clip(answer, 900));
    const url = safeUrl(box.link);
    if (url) sources.push({ title: clip(box.title || 'Источник', 55), url, hide: true });
  }
  if (data?.knowledgeGraph?.description) facts.push(clip(data.knowledgeGraph.description, 600));
  for (const item of (Array.isArray(data?.organic) ? data.organic : []).slice(0, 4)) {
    const url = safeUrl(item?.link);
    if (!url) continue;
    const title = clip(item?.title || 'Источник', 160);
    const snippet = clip(item?.snippet, 650);
    facts.push(`${title}\n${snippet}\n${url}${item.date ? `\nДата: ${clip(item.date, 60)}` : ''}`);
    if (sources.length < 3 && !sources.some(s => s.url === url)) {
      sources.push({ title: clip(title, 55), url, hide: true });
    }
  }
  return { context: clip(facts.join('\n\n'), 4200), sources };
}
