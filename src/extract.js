/**
 * 本地抽取式摘要器 (方案 B, P3 的最小核心)。
 *
 * 铁律: 输出里的每一段文字都必须是输入消息的**逐字子串**。
 * 因为它从不改写、不生成、不推断, 所以"不得引入原文没有的新事实"是
 * 构造性保证, 而不是靠事后校验。tests 里用 assertExtractive 强制验证。
 *
 * 代价要说清楚: 抽取式摘要只能选出"哪句话重要", 不能把两句话合成一句,
 * 也不会做指代消解。质量上限低于模型生成, 但零外发。
 *
 * 无第三方依赖, ESM。
 */

const CUE_GROUPS = [
  {
    kind: 'open',
    weight: 2.2,
    re: /(待确认|待定|待办|不确定|未定|还没|再讨论|下一步|稍后|明天|TODO|FIXME|存疑|待补)/i,
  },
  {
    kind: 'decision',
    weight: 2.4,
    re: /(决定|确定|定下来|采用|选用|改成|改为|定为|最终|结论|方案|就用|同意|拒绝|通过|放弃|回滚)/,
  },
  {
    kind: 'constraint',
    weight: 2.2,
    re: /(必须|务必|一定要|不要|不准|禁止|只能|不得|不需要|不用|统一|默认|约定|要求)/,
  },
  {
    kind: 'cause',
    weight: 2.0,
    re: /(问题定位|根因|根本原因|原因|因为|由于|导致|修复|解决了|已解决|定位到)/,
  },
  {
    kind: 'failure',
    weight: 2.0,
    re: /(失败|报错|错误|异常|崩溃|超时|退回|不通过|FAILED|Error|Traceback|Exception|exit code)/i,
  },
];

const FACT_PATTERNS = [
  { kind: 'time', re: /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[:：]\d{2}\b|\d+\s*(天|周|月|年|小时|分钟)/ },
  { kind: 'number', re: /\b\d+(\.\d+)?\s*(%|ms|MB|KB|GB|条|次|个|行|token|tokens)\b/i },
  { kind: 'path', re: /[A-Za-z]:\\[^\s，。；]+|(?:\/[\w.-]+){2,}/ },
  { kind: 'url', re: /https?:\/\/[^\s，。；]+/ },
  { kind: 'version', re: /\bv?\d+\.\d+(\.\d+)?\b/ },
  { kind: 'command', re: /(^|\s)(npm|pnpm|node|git|python|pip|curl|pwsh|powershell|cd|ls|dir)\s+\S+/i },
];

const LONG_TERM_CUES = /(记住|永远|一直|以后都|从现在起|我的习惯|我习惯|我偏好|我的要求|不要再|别再|每次都要)/;

const SPEAKER_WEIGHT = { user: 1.35, assistant: 1.0, tool: 0.55 };

const BOUNDARY = /([。！？；!?;]|\n+)/;

/** 句首是这些符号，说明它是被切断的后半句，单独读会像残句 */
const CONTINUATION_START = /^[）)\]】」』，,、；;：:…·|”’]/;

/** 列表符号：摘要里去掉更干净，但仍是原文子串 */
const LIST_MARKER = /^[\s]*(?:[-*+]|\d+[.)])[\s]+/;

function trimListMarker(text, span) {
  const slice = text.slice(span.start, span.end);
  const match = LIST_MARKER.exec(slice);
  if (!match) return span;
  const start = span.start + match[0].length;
  if (start >= span.end - 1) return span;
  return { start, end: span.end, text: text.slice(start, span.end) };
}

/** 表格行不适合进摘要 */
const TABLE_ROW = /^\|.*\|$/;

/** 判断一个片段是否值得作为候选；不合格的片段整条丢弃，不会进入摘要 */
export function isUsableSpan(text) {
  const trimmed = String(text).trim();
  if (trimmed.length < 6) return false;
  if (CONTINUATION_START.test(trimmed)) return false;
  if (TABLE_ROW.test(trimmed)) return false;
  if (/^[-*+>]\s*$/.test(trimmed)) return false;
  return true;
}

/** 把任意消息数组归一化为 {role, text, time, seq} */
export function normalizeMessages(messages) {
  const out = [];
  for (const message of messages || []) {
    if (!message) continue;
    let text = '';
    if (typeof message.text === 'string') text = message.text;
    else if (Array.isArray(message.content)) {
      text = message.content
        .map((block) => (typeof block === 'string' ? block : block && typeof block.text === 'string' ? block.text : ''))
        .filter(Boolean)
        .join('\n');
    }
    if (!text.trim()) continue;
    const role = message.role === 'tool' ? 'tool' : message.role === 'assistant' ? 'assistant' : 'user';
    out.push({ role, text, time: message.time ?? null, seq: message.seq ?? null });
  }
  return out;
}

/**
 * 切句并保留字符偏移, 保证 quote 一定是原文子串。
 *
 * 逐字符扫描：句末标点断句，换行断段（连着的空白一起吃掉）。
 * 以前版本遇到段落边界就 break，导致第二段之后被整段当成一句。
 */
export function splitSpans(text, maxSpan = 180) {
  const spans = [];
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const sentenceEnd = '。！？；!?;'.includes(ch);
    const paragraphEnd = ch === '\n';
    if (sentenceEnd || paragraphEnd) {
      let end = i + 1;
      if (paragraphEnd) {
        while (end < text.length && /\s/.test(text[end])) end += 1;
      }
      const piece = text.slice(start, end);
      if (piece.trim()) spans.push({ start, end, text: piece });
      start = end;
      i = end;
      continue;
    }
    i += 1;
  }
  if (start < text.length && text.slice(start).trim()) {
    spans.push({ start, end: text.length, text: text.slice(start) });
  }
  // 过长片段按中文逗号再切, 依然是原文子串
  const out = [];
  for (const span of spans) {
    if (span.text.length <= maxSpan) {
      out.push(span);
      continue;
    }
    let cursor = span.start;
    for (let j = span.start; j < span.end; j += 1) {
      const isBreak = '，,、'.includes(text[j]);
      if (isBreak && j - cursor >= 40) {
        out.push({ start: cursor, end: j + 1, text: text.slice(cursor, j + 1) });
        cursor = j + 1;
      }
    }
    if (cursor < span.end) out.push({ start: cursor, end: span.end, text: text.slice(cursor, span.end) });
  }
  return out.filter((span) => span.text.trim().length > 0).map((span) => trimListMarker(text, span));
}

function shingles(text) {
  const clean = text.replace(/[\s\p{P}\p{S}]/gu, '');
  const set = new Set();
  for (let i = 0; i + 3 <= clean.length; i += 1) set.add(clean.slice(i, i + 3));
  return set;
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared += 1;
  return shared / (a.size + b.size - shared);
}

function classify(text) {
  for (const group of CUE_GROUPS) {
    if (group.re.test(text)) return group;
  }
  return null;
}

function countFacts(text) {
  const hits = [];
  for (const pattern of FACT_PATTERNS) {
    if (pattern.re.test(text)) hits.push(pattern.kind);
  }
  return hits;
}

/**
 * 给一个片段打分: 线索词 + 事实密度 + 发言者 + 位置 + 长度惩罚
 */
export function scoreSpan(span, ctx) {
  const text = span.text;
  let score = 0;
  const cue = classify(text);
  if (cue) score += cue.weight;
  const facts = countFacts(text);
  score += Math.min(3, facts.length * 0.9);
  if (LONG_TERM_CUES.test(text)) score += 1.6;
  score *= SPEAKER_WEIGHT[ctx.role] || 1;
  if (ctx.isLastOfMessage && ctx.role === 'user') score += 0.8;
  if (ctx.isFirstOfMessage && ctx.role === 'user') score += 0.4;
  if (text.length > 140) score -= 0.6;
  if (text.trim().length < 8) score -= 0.8;
  return { score, cue: cue ? cue.kind : facts.length > 0 ? 'fact' : 'event', facts };
}

/**
 * 主入口: 从消息生成抽取式摘要。
 *
 * @param {Array} messages 归一化前的消息数组
 * @param {object} options
 * @param {number} [options.charBudget=600] 摘要正文最大字符数
 * @param {number} [options.maxSpans=24] 最多选几句
 * @param {string[]} [options.carried] 上一条摘要的要点行 (逐字承接)
 * @param {number} [options.maxSpanChars=180] 单句切分上限
 */
export function extractDigest(messages, options = {}) {
  const {
    charBudget = 600,
    maxSpans = 24,
    carried = [],
    maxSpanChars = 180,
    minScore = 0.85,
  } = options;

  const units = normalizeMessages(messages);
  const candidates = [];
  let totalChars = 0;

  units.forEach((unit, unitIndex) => {
    totalChars += unit.text.length;
    const spans = splitSpans(unit.text, maxSpanChars).filter((span) => isUsableSpan(span.text));
    spans.forEach((span, spanIndex) => {
      const scored = scoreSpan(span, {
        role: unit.role,
        isFirstOfMessage: spanIndex === 0,
        isLastOfMessage: spanIndex === spans.length - 1,
      });
      candidates.push({
        quote: span.text,
        role: unit.role,
        time: unit.time,
        seq: unit.seq,
        unitIndex,
        spanIndex,
        kind: scored.cue,
        facts: scored.facts,
        score: scored.score,
        anchor: unit.role === 'user' && spanIndex === 0,
        shingles: shingles(span.text),
      });
    });
  });

  // 锚点: 每个用户发言的首句必须保留, 否则摘要失去"谁在什么语境下说的"
  const anchors = candidates
    .filter((item) => item.anchor)
    .sort((a, b) => a.unitIndex - b.unitIndex);

  const ranked = candidates
    .filter((item) => !item.anchor)
    .sort((a, b) => b.score - a.score || a.unitIndex - b.unitIndex || a.spanIndex - b.spanIndex);

  const selected = [];
  let used = 0;
  const tryTake = (candidate, force) => {
    if (!force && candidate.score < minScore) return false;
    if (used + candidate.quote.length > charBudget && selected.length > 0) return false;
    if (selected.some((chosen) => jaccard(chosen.shingles, candidate.shingles) >= 0.8)) return false;
    selected.push(candidate);
    used += candidate.quote.length;
    return true;
  };

  for (const candidate of anchors) tryTake(candidate, true);
  for (const candidate of ranked) {
    if (selected.length >= maxSpans) break;
    tryTake(candidate, false);
  }

  selected.sort((a, b) => a.unitIndex - b.unitIndex || a.spanIndex - b.spanIndex);

  const carriedQuotes = [];
  for (const line of carried) {
    const text = String(line).replace(/^[-*]\s*/, '').trim();
    if (!text) continue;
    if (selected.some((item) => item.quote.includes(text) || text.includes(item.quote))) continue;
    carriedQuotes.push(text);
  }

  const increments = selected.map((item) => ({
    kind: item.kind,
    quote: item.quote,
    speaker: item.role,
    event_time: item.time,
    seq: item.seq,
    facts: item.facts,
    score: Number(item.score.toFixed(2)),
  }));

  const longTermCandidates = [...new Set(
    selected.filter((item) => LONG_TERM_CUES.test(item.quote)).map((item) => item.quote.trim()),
  )];

  const warnings = [];
  const truncated = candidates.some((item) => item.quote.length >= maxSpanChars);
  if (truncated) warnings.push('span_split: 有超长句被按逗号切开, 切点处语义可能不完整');

  return {
    carried: carriedQuotes,
    increments,
    longTermCandidates,
    summaryText: renderDigestBody({ carried: carriedQuotes, increments }),
    stats: {
      messages: units.length,
      candidates: candidates.length,
      selected: increments.length,
      sourceChars: totalChars,
      summaryChars: used + carriedQuotes.reduce((sum, text) => sum + text.length, 0),
      ratio: totalChars > 0 ? Number((used / totalChars).toFixed(3)) : 0,
      excerpted: increments.length < candidates.length,
      local: true,
    },
    warnings,
  };
}

const KIND_LABEL = {
  decision: '决策',
  constraint: '约束',
  open: '未决',
  failure: '故障',
  cause: '原因',
  fact: '事实',
  event: '事件',
};

const SPEAKER_LABEL = { user: '用户', assistant: '助手', tool: '工具' };

/** 渲染为可直接写进 digest 条目的正文 (要点 / 增量 / 承接) */
export function renderDigestBody({ carried = [], increments = [] }) {
  const lines = ['要点：'];
  if (increments.length === 0) lines.push('- （本会话无可抽取要点）');
  for (const item of increments) {
    const label = `${SPEAKER_LABEL[item.speaker] || item.speaker}·${KIND_LABEL[item.kind] || item.kind}`;
    lines.push(`- [${label}] ${item.quote.trim()}`);
  }
  if (carried.length > 0) {
    lines.push('', '承接（沿用上一条摘要，未改写）：');
    for (const text of carried) lines.push(`- ${text}`);
  }
  return lines.join('\n');
}

/**
 * 校验"零编造"。
 *
 * increments 与 longTermCandidates 必须回溯本会话原文;
 * carried 来自上一条摘要, 用 options.carriedPool 校验 (缺省则不校验并给出提示)。
 *
 * @returns {Array<{where: string, text: string}>} 问题列表, 空数组表示通过
 */
export function assertExtractive(result, messages, options = {}) {
  const pool = normalizeMessages(messages).map((unit) => unit.text);
  const problems = [];
  const check = (text, where, sources) => {
    const needle = String(text).trim();
    if (!needle) return;
    if (!sources.some((source) => source.includes(needle))) {
      problems.push({ where, text: needle });
    }
  };
  for (const item of result.increments || []) check(item.quote, 'increments', pool);
  for (const text of result.longTermCandidates || []) check(text, 'longTermCandidates', pool);
  if (typeof options.carriedPool === 'string') {
    for (const text of result.carried || []) check(text, 'carried', [options.carriedPool]);
  } else if ((result.carried || []).length > 0) {
    problems.push({ where: 'carried', text: '(未提供 carriedPool, 承接行无法校验)' });
  }
  return problems;
}
