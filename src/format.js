/**
 * 记忆 Markdown 格式层 (P1)。
 *
 * 设计目标:
 * 1. 字节级保真 round-trip: parse -> serialize 后与原文件逐字节一致,
 *    未修改的条目按原文回写, 未知字段/未知语法原样保留 (规格: 不得静默丢弃)。
 * 2. 条目边界只认 `## [ID] 标题`, 因此 `## 记忆索引` 之类的普通二级标题不会
 *    被误判为条目; 正文里真正的 `## [x] y` 行必须转义为 `\## [x] y`。
 * 3. 校验只报告不抛错 (issues), 由上层决定标 time_anomaly / 拒绝写入。
 *
 * 无第三方依赖, ESM。
 */

export const MEMORY_FORMAT = 'dsh-memory';
export const FORMAT_VERSION = 1;

/** 条目必填字段 (规格: 至少包含这些) */
export const REQUIRED_ENTRY_FIELDS = [
  'type', 'event_time', 'recorded_at', 'updated_at', 'timezone',
  'time_source', 'confidence', 'privacy', 'status', 'tags', 'seq',
];

/** 文件 front matter 必填字段 */
export const REQUIRED_FRONT_MATTER = ['memory_format', 'format_version', 'saved_at'];

const ENTRY_HEADING = /^##[ \t]+\[([^\]\n]+)\][ \t]*(.*)$/;
const FM_DELIM = /^---[ \t]*$/;
const FIELD_LINE = /^-[ \t]+([A-Za-z0-9_.-]+)[ \t]*:[ \t]?(.*)$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

export function isIsoTime(value) {
  return typeof value === 'string' && ISO_TIME.test(value);
}

function detectEol(text) {
  const i = text.indexOf('\n');
  if (i > 0 && text[i - 1] === '\r') return '\r\n';
  return '\n';
}

function splitLines(text) {
  return text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

/** 拆分 front matter 区: 返回 { raw, body, eol } 或 null */
function takeFrontMatter(text, eol) {
  const lines = splitLines(text);
  if (lines.length === 0 || !FM_DELIM.test(lines[0])) return null;
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (FM_DELIM.test(lines[i])) { end = i; break; }
  }
  if (end < 0) return null;
  const rawLines = lines.slice(0, end + 1);
  const rest = lines.slice(end + 1).join('\n');
  return { rawLines, innerLines: lines.slice(1, end), rest };
}

/** 解析 `key: value` 形式的 front matter 行; 无法解析的行保留 */
export function parseFrontMatter(lines) {
  const data = {};
  const pairs = [];
  const extraLines = [];
  const issues = [];
  for (const line of lines) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      extraLines.push(line);
      continue;
    }
    const m = /^([A-Za-z0-9_.-]+)[ \t]*:[ \t]?(.*)$/.exec(line);
    if (!m) {
      extraLines.push(line);
      issues.push({ code: 'FM_UNPARSED_LINE', message: 'front matter 行不符合 key: value', line });
      continue;
    }
    const key = m[1];
    const value = unquote(m[2]);
    if (key in data) {
      issues.push({ code: 'FM_DUPLICATE_KEY', message: `front matter 重复键 ${key}`, line });
      extraLines.push(line);
      continue;
    }
    data[key] = value;
    pairs.push({ key, value, raw: line });
  }
  return { data, pairs, extraLines, issues };
}

function unquote(value) {
  const t = value.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.at(-1) === '"') || (t[0] === "'" && t.at(-1) === "'"))) {
    return t.slice(1, -1).replace(/\\"/g, '"');
  }
  return t;
}

/** 解析条目字段列表 (只吃正文前的连续 `- key: value`, 空行结束) */
function parseFieldList(lines) {
  const fields = [];
  const extraLines = [];
  const issues = [];
  for (const line of lines) {
    if (line.trim() === '') {
      extraLines.push(line);
      continue;
    }
    const m = FIELD_LINE.exec(line);
    if (!m) {
      extraLines.push(line);
      issues.push({ code: 'FIELD_UNPARSED', message: '字段行不符合 `- key: value`', line });
      continue;
    }
    fields.push({ key: m[1], value: m[2].trim(), raw: line });
  }
  return { fields, extraLines, issues };
}

/** 正文反转义: 行首 `\## ` 还原为 `## ` */
export function unescapeBodyLines(lines) {
  return lines.map((line) => (/^\\##[ \t]/.test(line) ? line.slice(1) : line));
}

/** 正文转义: 行首 `## ` 前加反斜杠, 避免被当成条目边界 */
export function escapeBodyLines(lines) {
  return lines.map((line) => (/^##[ \t]/.test(line) ? `\\${line}` : line));
}

/** 引用块 (冲突/备注) 识别, 原文保留 */
function collectBlocks(bodyLines) {
  const blocks = [];
  for (const line of bodyLines) {
    const m = /^>[ \t]*\[!([A-Za-z0-9_-]+)\][ \t]?(.*)$/.exec(line);
    if (m) blocks.push({ tag: m[1], text: m[2], raw: line });
    else if (blocks.length > 0 && /^>/.test(line)) blocks.at(-1).raw += `\n${line}`;
  }
  return blocks;
}

function parseEntryChunk(chunk) {
  const lines = splitLines(chunk);
  const heading = ENTRY_HEADING.exec(lines[0]);
  if (!heading) throw new Error('parseEntryChunk 需要以条目标题开头');
  const id = heading[1].trim();
  const title = heading[2].trim();

  // 字段区 = 标题后 (允许一个空行) 的连续 `- key: value` 行
  let i = 1;
  while (i < lines.length && lines[i].trim() === '') i += 1;
  const fieldLines = [];
  while (i < lines.length && FIELD_LINE.test(lines[i])) {
    fieldLines.push(lines[i]);
    i += 1;
  }
  const { fields, issues: fieldIssues } = parseFieldList(fieldLines);

  // 字段区之后的空行与正文
  let bodyStart = i;
  while (bodyStart < lines.length && lines[bodyStart].trim() === '') bodyStart += 1;
  const bodyRawLines = lines.slice(bodyStart);
  const bodyLines = unescapeBodyLines(bodyRawLines);

  const fieldMap = {};
  for (const f of fields) fieldMap[f.key] = f.value;

  return {
    id,
    title,
    fields,
    fieldMap,
    bodyLines,
    bodyRawLines,
    blocks: collectBlocks(bodyLines),
    raw: chunk,
    dirty: false,
    issues: fieldIssues,
  };
}

function validateEntry(entry, index, previousSeq) {
  const issues = [];
  const missing = REQUIRED_ENTRY_FIELDS.filter((key) => !(key in entry.fieldMap));
  if (missing.length > 0) {
    issues.push({ code: 'ENTRY_MISSING_FIELDS', message: `缺少字段: ${missing.join(', ')}`, entryId: entry.id });
  }
  const seq = entry.fieldMap.seq;
  if (seq !== undefined) {
    if (!/^\d+$/.test(seq)) {
      issues.push({ code: 'SEQ_NOT_INTEGER', message: `seq 不是整数: ${seq}`, entryId: entry.id });
    } else {
      const n = Number(seq);
      if (previousSeq !== undefined && n <= previousSeq) {
        issues.push({ code: 'SEQ_NOT_MONOTONIC', message: `seq 未严格递增: ${previousSeq} -> ${n}`, entryId: entry.id });
      }
      entry.seqNumber = n;
    }
  }
  for (const key of ['event_time', 'recorded_at', 'updated_at']) {
    const value = entry.fieldMap[key];
    if (value === undefined) continue;
    if (key === 'event_time' && value === 'unknown') continue;
    if (!isIsoTime(value)) {
      issues.push({ code: 'TIME_FORMAT', message: `${key} 不是 ISO 8601 带时区: ${value}`, entryId: entry.id });
    }
  }
  const recorded = entry.fieldMap.recorded_at;
  const updated = entry.fieldMap.updated_at;
  if (isIsoTime(recorded) && isIsoTime(updated)) {
    if (Date.parse(updated) < Date.parse(recorded)) {
      issues.push({ code: 'TIME_ANOMALY', message: 'updated_at 早于 recorded_at', entryId: entry.id });
    }
  }
  if (entry.fieldMap.time_source === 'unknown' && entry.fieldMap.event_time !== 'unknown') {
    issues.push({
      code: 'TIME_SOURCE_MISMATCH',
      message: 'time_source 为 unknown 但 event_time 有值',
      entryId: entry.id,
    });
  }
  entry.index = index;
  return issues;
}

/**
 * 解析一个记忆 Markdown 文件。
 * @param {string} text UTF-8 文本
 * @returns {object} doc
 */
export function parseMemoryFile(text) {
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const src = bom ? text.slice(1) : text;
  const eol = detectEol(src);
  const issues = [];

  const fm = takeFrontMatter(src, eol);
  let frontMatter = { raw: '', data: {}, pairs: [], extraLines: [], issues: [] };
  let rest = src;
  if (fm) {
    frontMatter = {
      raw: fm.rawLines.join(eol) + eol,
      ...parseFrontMatter(fm.innerLines),
    };
    issues.push(...frontMatter.issues);
    rest = fm.rest;
  } else {
    issues.push({ code: 'NO_FRONT_MATTER', message: '文件缺少 front matter' });
  }

  for (const key of REQUIRED_FRONT_MATTER) {
    if (!(key in frontMatter.data)) {
      issues.push({ code: 'FM_MISSING_KEY', message: `front matter 缺少 ${key}` });
    }
  }

  // 按条目标题切块; 只有 `## [ID] 标题` 是边界
  const lines = splitLines(rest);
  const starts = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (ENTRY_HEADING.test(lines[i])) starts.push(i);
  }

  let preamble;
  const entries = [];
  if (starts.length === 0) {
    preamble = lines.join(eol);
  } else {
    const head = lines.slice(0, starts[0]);
    preamble = head.length > 0 ? head.join(eol) + eol : '';
    let previousSeq;
    for (let s = 0; s < starts.length; s += 1) {
      const from = starts[s];
      const to = s + 1 < starts.length ? starts[s + 1] : lines.length;
      const isLast = to === lines.length;
      const chunk = lines.slice(from, to).join(eol) + (isLast ? '' : eol);
      const entry = parseEntryChunk(chunk);
      issues.push(...entry.issues);
      issues.push(...validateEntry(entry, entries.length, previousSeq));
      if (entry.seqNumber !== undefined) previousSeq = entry.seqNumber;
      entries.push(entry);
    }
  }

  return {
    bom,
    eol,
    frontMatter,
    preamble,
    entries,
    issues,
    indexSection: findIndexSection(preamble),
  };
}

/** 识别文件头 "记忆索引" 区块 (只做定位, 不改写) */
export function findIndexSection(preamble) {
  if (!preamble) return null;
  const lines = splitLines(preamble);
  const start = lines.findIndex((line) => /^##[ \t]+记忆索引/.test(line));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##[ \t]+/.test(lines[i])) { end = i; break; }
  }
  const raw = lines.slice(start, end).join('\n');
  const rows = [];
  for (const line of lines.slice(start + 1, end)) {
    const m = /^-[ \t]*`?([^`:\s]+)`?[ \t]*[:：][ \t]*(.*)$/.exec(line);
    if (m) rows.push({ id: m[1], rest: m[2] });
  }
  return { raw, rows, lineCount: end - start };
}

export function estimateTokens(text) {
  if (!text) return 0;
  // 粗略估算: CJK 约 1 字 1 token, 其余按 4 字符 1 token
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/[\u3400-\u9FFF\uF900-\uFAFF\u3000-\u303F\uFF00-\uFFEF]/.test(ch)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk + other / 4);
}

/** 重建一个条目 (仅在 dirty 时使用), 保持原有尾部空白 */
export function renderEntry(entry) {
  const lines = [`## [${entry.id}] ${entry.title}`.trimEnd()];
  for (const field of entry.fields) lines.push(`- ${field.key}: ${field.value}`.trimEnd());
  for (const line of entry.extraLines || []) lines.push(line);
  const body = escapeBodyLines(entry.bodyLines || []);
  if (body.length > 0) {
    lines.push('');
    lines.push(...body);
  }
  return lines.join('\n') + (entry.trailing || '');
}

export function serializeMemoryFile(doc) {
  const eol = doc.eol || '\n';
  const out = [];
  if (doc.bom) out.push(doc.bom);
  out.push(doc.frontMatter.raw || '');
  out.push(doc.preamble || '');
  for (const entry of doc.entries) {
    out.push(entry.dirty || entry.raw == null ? renderEntry(entry) : entry.raw);
  }
  return out.join('');
}

/** 修改条目字段: 保持其他字节不变, 只把该条目标记为需重写 */
export function setEntryField(entry, key, value) {
  const found = entry.fields.find((f) => f.key === key);
  if (found) found.value = String(value);
  else entry.fields.push({ key, value: String(value) });
  entry.fieldMap[key] = String(value);
  entry.dirty = true;
  return entry;
}

/** 设置条目正文 (传入未转义的逻辑行) */
export function setEntryBody(entry, lines) {
  entry.bodyLines = [...lines];
  entry.dirty = true;
  return entry;
}

/** 汇总统计, 供索引与报告使用 */
export function describe(doc) {
  const counts = {};
  for (const entry of doc.entries) {
    const type = entry.fieldMap.type || 'unknown';
    counts[type] = (counts[type] || 0) + 1;
  }
  return {
    entries: doc.entries.length,
    types: counts,
    issues: doc.issues,
    hasIndex: Boolean(doc.indexSection),
    tokensEst: estimateTokens(doc.preamble || '') + doc.entries.length * 24,
  };
}
