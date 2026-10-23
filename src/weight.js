/**
 * 记忆权重、20 天明细回收、低 token 启动包。
 *
 * 纯函数，不碰 IO。三条规则来自规格：
 * - 权重只影响"载入与排序"，不影响存在性与可检索性；
 * - 回收只动 `### 增量` 明细，要点、指针、时间戳一律保留；
 * - 启动包由摘要聚合而成，不得独立编造，且必须写明"权威内容以正文为准"。
 */

export const BASE_WEIGHT = { digest: 60, period: 70, longTerm: 100 };
export const BUCKETS = ['hot', 'warm', 'cold', 'dormant'];

export function bucketOf(weight) {
  if (weight >= 70) return 'hot';
  if (weight >= 40) return 'warm';
  if (weight >= 15) return 'cold';
  return 'dormant';
}

/**
 * 权重 = clamp(base × decay + boost, floor, 100)
 * 满权 fullDays 天；之后按 halfLifeDays 半衰期衰减。
 */
export function computeWeight(input = {}) {
  const {
    base = BASE_WEIGHT.digest,
    eventTime,
    now = Date.now(),
    boost = 0,
    fullDays = 20,
    halfLifeDays = 30,
    floor = 5,
  } = input;

  if (!eventTime || eventTime === 'unknown') {
    return { weight: base, decay: 1, bucket: bucketOf(base), days: null };
  }
  const at = Date.parse(eventTime);
  if (Number.isNaN(at)) {
    return { weight: base, decay: 1, bucket: bucketOf(base), days: null };
  }

  const days = (now - at) / 86400000;
  const over = Math.max(0, days - fullDays);
  const decay = Math.pow(0.5, over / halfLifeDays);
  const weight = Math.max(floor, Math.min(100, Math.round(base * decay + boost)));
  return { weight, decay: Number(decay.toFixed(3)), bucket: bucketOf(weight), days: Number(days.toFixed(1)) };
}

/** 是否到了回收明细的时间 */
export function shouldPurge(eventTime, now = Date.now(), purgeDays = 20) {
  if (!eventTime || eventTime === 'unknown') return false;
  const at = Date.parse(eventTime);
  if (Number.isNaN(at)) return false;
  return (now - at) / 86400000 >= purgeDays;
}

export const PURGE_HEADING = '### 增量';

/**
 * 回收 `### 增量` 区块，换成一条回收标记。
 * 只删这个区块；要点、### 承接、[!note] 指针都保留。
 */
export function purgeDetail(bodyLines, meta = {}) {
  const start = bodyLines.findIndex((line) => /^###\s*增量\s*$/.test(line));
  if (start < 0) return { bodyLines, removed: 0, purged: false };

  let end = bodyLines.length;
  for (let i = start + 1; i < bodyLines.length; i += 1) {
    if (/^###\s/.test(bodyLines[i]) || /^>[ \t]*\[!/.test(bodyLines[i])) { end = i; break; }
  }

  const marker = `> [!purged] 明细已于 ${meta.at || 'unknown'} 回收（超过 ${meta.days ?? 20} 天）；要点与源文件指针保留。`;
  const before = bodyLines.slice(0, start);
  const after = bodyLines.slice(end);
  const joined = [...before, marker, ...after];
  // 合并相邻空行，避免回收后留下双空行
  const compact = [];
  for (const line of joined) {
    if (line.trim() === '' && compact.length > 0 && compact[compact.length - 1].trim() === '') continue;
    compact.push(line);
  }
  return { bodyLines: compact, removed: end - start, purged: true };
}

/** 从正文提取一行索引摘要 */
export function summaryLine(entry, limit = 100) {
  const map = entry.fieldMap || {};
  // 长期要点用 value（一句话），不用标题（标题含 kind 前缀和截断）
  if (map.type === 'long_term' && map.value) {
    return `[${map.kind || 'long_term'}] ${String(map.value).slice(0, limit)}`;
  }
  const body = entry.bodyLines || [];
  const point = body.find((line) => /^-\s*\[[^\]]+\]/.test(line));
  if (point) {
    return point.replace(/^-\s*/, '').replace(/\s+/g, ' ').trim().slice(0, limit);
  }
  const title = String(entry.title || '').replace(/^会话总结\s*·\s*/, '').trim();
  return title.slice(0, limit);
}

/**
 * 生成启动包。预算用尽就停，不在末尾截断半条。
 *
 * 顺序：长期要点 → 链头（最新一条会话摘要）→ 其余按权重降序。
 * @returns {{text, tokens, included: string[], skipped: number}}
 */
export function buildStartupIndex(docs, options = {}) {
  const { now = Date.now(), budget = 800, estimateTokens } = options;
  const items = (docs || [])
    .map((doc) => {
      const map = doc.entry.fieldMap || {};
      // 导入的条目可能没有 weight；长期要点按满分算，避免它掉到末尾
      const weight = Number(map.weight || (map.type === 'long_term' ? BASE_WEIGHT.longTerm : 0));
      return {
        id: doc.entry.id,
        entry: doc.entry,
        type: map.type,
        eventTime: map.event_time,
        status: map.status,
        weight,
        isLongTerm: map.type === 'long_term',
        isChainHead: false,
      };
    })
    .filter((item) => item.type === 'session_digest' || item.type === 'long_term' || item.type === 'period_digest');

  const chainHeads = items
    .filter((item) => item.type === 'session_digest')
    .sort((a, b) => (Date.parse(b.eventTime) || 0) - (Date.parse(a.eventTime) || 0));
  if (chainHeads.length > 0) chainHeads[0].isChainHead = true;

  const order = [
    ...items.filter((item) => item.isLongTerm),
    ...items.filter((item) => item.isChainHead),
    ...items
      .filter((item) => !item.isLongTerm && !item.isChainHead)
      .sort((a, b) => b.weight - a.weight),
  ];

  const header = [
    '## 记忆索引',
    '',
    '> 索引仅用于快速定位与概览，权威内容以条目正文为准。',
    '> 处于 pending / superseded 的条目已标注状态。',
    '',
    '',
  ].join('\n');

  const lines = [];
  let tokens = estimateTokens ? estimateTokens(header) : 0;
  const included = [];
  let skipped = 0;
  const stale = [];

  for (const item of order) {
    // superseded / pending 不占启动包预算，但必须披露数量，不能假装不存在
    if (item.status && item.status !== 'current') {
      stale.push(item);
      continue;
    }
    const line = `- ${item.id}: ${summaryLine(item.entry)} · event_time=${item.eventTime || 'unknown'} · status=${item.status || 'unknown'} · weight=${item.weight}`;
    const cost = estimateTokens ? estimateTokens(line + '\n') : 0;
    if (tokens + cost > budget && included.length > 0) {
      skipped += 1;
      continue;
    }
    included.push(item.id);
    lines.push(line);
    tokens += cost;
  }

  if (stale.length > 0) {
    const note = `- 另有 ${stale.length} 条 pending/superseded 未列入启动包，可用 memory_search 检索。`;
    lines.push(note);
    tokens += estimateTokens ? estimateTokens(note + '\n') : 0;
  }

  const tail = `\n\n- index_tokens_est: ${tokens}\n`;
  return { text: `${header}${lines.join('\n')}${tail}`, tokens, included, skipped, stale: stale.length };
}
