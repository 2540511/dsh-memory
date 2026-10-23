/**
 * 检索层：查询切词、条目打分、摘录、时效判定。
 *
 * 纯函数，不碰 IO：上层把"文件 + 条目"读出来喂进来即可。
 * 排序规则遵循规格：相关性优先，时间只做同分时的次序，权重仅微调排序，
 * 不允许权重压过相关性。
 */

const CJK = /[\u3400-\u9FFF\uF900-\uFAFF]/;

const SEPARATORS = /[\s,，、;；:：!！?？.。()（）[\]【】"'“”‘’/\\|<>+=*~`@#$%^&]+/;

/**
 * 查询切词。中文短语额外补二元组，否则"记忆权重"搜不到"记忆的权重"。
 * 单字词信息量太低，直接丢弃。
 */
export function tokenize(query) {
  const raw = String(query || '').toLowerCase().trim();
  if (!raw) return [];
  const terms = new Set();
  for (const part of raw.split(SEPARATORS)) {
    if (!part) continue;
    if (part.length >= 2) terms.add(part);
    if (CJK.test(part) && part.length >= 3) {
      for (let i = 0; i + 2 <= part.length; i += 1) terms.add(part.slice(i, i + 2));
    }
  }
  return [...terms];
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1 && count < 50) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/** 条目文本：标题 + 正文 + 标签 */
export function entryText(entry) {
  return {
    title: String(entry.title || '').toLowerCase(),
    tags: String((entry.fieldMap && entry.fieldMap.tags) || '').toLowerCase(),
    body: (entry.bodyLines || []).join('\n').toLowerCase(),
  };
}

/**
 * 给一条记忆打分。
 * 标题命中 3 分、标签 2 分、正文每次命中 1 分（单个词最多 3 分），
 * 最后加上"命中了几个词"作为额外奖励，避免单个高频词刷分。
 */
export function scoreEntry(entry, terms) {
  const text = entryText(entry);
  let score = 0;
  let matched = 0;
  for (const term of terms) {
    let part = 0;
    if (text.title.includes(term)) part += 3;
    if (text.tags.includes(term)) part += 2;
    const occurrences = countOccurrences(text.body, term);
    if (occurrences > 0) part += Math.min(3, occurrences);
    if (part > 0) {
      matched += 1;
      score += part;
    }
  }
  if (matched === 0) return null;
  return { score: score + matched, matched };
}

/** 摘录：围绕最先出现的命中词取一段窗口 */
export function makeSnippet(bodyLines, terms, width = 120) {
  const text = (bodyLines || []).join('\n').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const lower = text.toLowerCase();
  let bestIndex = -1;
  let bestTerm = '';
  for (const term of terms) {
    const index = lower.indexOf(term);
    if (index >= 0 && (bestIndex === -1 || index < bestIndex || (index === bestIndex && term.length > bestTerm.length))) {
      bestIndex = index;
      bestTerm = term;
    }
  }
  if (bestIndex === -1) return text.slice(0, width) + (text.length > width ? '…' : '');
  const half = Math.floor(width / 2);
  const start = Math.max(0, bestIndex - half);
  const end = Math.min(text.length, start + width);
  const slice = text.slice(start, end).trim();
  return `${start > 0 ? '…' : ''}${slice}${end < text.length ? '…' : ''}`;
}

/** 时效状态：按事件时间距今多久 */
export function freshness(eventTime, now = Date.now(), options = {}) {
  const freshDays = options.freshDays ?? 20;
  const agingDays = options.agingDays ?? 60;
  if (!eventTime || eventTime === 'unknown') return 'unknown';
  const at = Date.parse(eventTime);
  if (Number.isNaN(at)) return 'unknown';
  const days = (now - at) / 86400000;
  if (days < 0) return 'anomaly';
  if (days <= freshDays) return 'fresh';
  if (days <= agingDays) return 'aging';
  return 'stale';
}

function fullBody(entry, limit = 4000) {
  const text = (entry.bodyLines || []).join('\n').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** 类型权重：代码 diff 是证据不是记忆，命中也不该压过摘要与逐字转录 */
const TYPE_WEIGHT = { work_diff: 0.55, work_record: 0.9 };

function typeWeight(type) {
  return TYPE_WEIGHT[type] !== undefined ? TYPE_WEIGHT[type] : 1;
}

/**
 * 在一组 {file, entry} 上检索。
 *
 * @param {Array} docs 每条 [{file, entry}]
 * @param {string} query
 * @param {object} options {limit, type, from, to, now, freshDays, agingDays}
 */
export function searchEntries(docs, query, options = {}) {
  const { limit = 20, type, from, to, now = Date.now() } = options;
  const terms = tokenize(query);
  if (terms.length === 0) return { terms, hits: [], scanned: 0 };

  const fromMs = from ? Date.parse(from) : null;
  const toMs = to ? Date.parse(to) : null;

  const hits = [];
  let scanned = 0;
  for (const doc of docs || []) {
    const entry = doc && doc.entry;
    if (!entry) continue;
    scanned += 1;
    if (type && entry.fieldMap && entry.fieldMap.type !== type) continue;

    const eventTime = entry.fieldMap ? entry.fieldMap.event_time : undefined;
    const eventMs = eventTime && eventTime !== 'unknown' ? Date.parse(eventTime) : NaN;
    if (fromMs !== null && (Number.isNaN(eventMs) || eventMs < fromMs)) continue;
    if (toMs !== null && (Number.isNaN(eventMs) || eventMs > toMs)) continue;

    const scored = scoreEntry(entry, terms);
    if (!scored) continue;

    const weight = Number((entry.fieldMap && entry.fieldMap.weight) || 0);
    const entryType = entry.fieldMap ? entry.fieldMap.type : undefined;
    // 工作记忆是逐字内容，命中就返回全文；聊天记忆只给摘录。
    const isWork = entry.fieldMap && entry.fieldMap.memory_class === 'work';
    hits.push({
      id: entry.id,
      file: doc.file,
      title: entry.title,
      type: entryType,
      memoryClass: entry.fieldMap ? entry.fieldMap.memory_class : undefined,
      status: entry.fieldMap ? entry.fieldMap.status : undefined,
      eventTime: eventTime || 'unknown',
      weight,
      score: Number(((scored.score + weight / 200) * typeWeight(entryType)).toFixed(3)),
      matched: scored.matched,
      snippet: isWork ? fullBody(entry) : makeSnippet(entry.bodyLines, terms),
      full: Boolean(isWork),
      freshness: freshness(eventTime, now, options),
    });
  }

  hits.sort((a, b) => b.score - a.score || (Date.parse(b.eventTime) || 0) - (Date.parse(a.eventTime) || 0));
  return { terms, hits: hits.slice(0, limit), scanned, total: hits.length };
}
