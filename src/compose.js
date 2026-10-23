/**
 * 把一个会话的抽取结果组装成记忆 Markdown 文件。
 *
 * 纯函数：输入摘要与元信息，输出文件文本；不碰 IO，方便测试。
 * 结构遵循规格：front matter 全局面板、`## 记忆索引` 区块、
 * 每条记忆是 `## [ID] 标题` + `- key: value` 字段 + 正文。
 */
import { escapeBodyLines, estimateTokens, renderEntry, MEMORY_FORMAT, FORMAT_VERSION } from './format.js';

export const SUMMARY_MODEL = 'local-extractive';
export const SUMMARY_MODEL_VERSION = '1';

/** 摘要条目 ID：SG-20261023-154106 */
export function digestId(stamp) {
  return `SG-${String(stamp).replace('_', '-')}`;
}

/** 摘要正文里可被 20 天后回收的部分，用三级标题包住，便于机械裁剪 */
export const PURGE_HEADING = '### 增量';

function oneLine(text, limit = 120) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/**
 * 构造摘要条目。
 * @param {object} input
 * @param {object} input.digest extract.js 的输出
 * @param {object} input.session {sessionId, title, messageRange, coversFrom, coversTo}
 * @param {string} input.stamp 文件名时间戳 YYYY-MM-DD_HHmmss
 * @param {string} input.savedAt 带时区 ISO
 * @param {string} input.timezone
 * @param {string} input.memoryClass chat | work
 * @param {string} input.fileName 本条记忆所属的源文件名
 */
export function buildDigestEntry(input) {
  const { digest, session, stamp, savedAt, timezone, memoryClass, fileName } = input;
  const id = digestId(stamp);

  const fields = [
    ['type', 'session_digest'],
    ['digest_level', '1'],
    ...(input.chainFrom ? [['chain_from', input.chainFrom]] : []),
    ['chain_length', String(input.chainLength || 1)],
    ['digest_basis', digest.basis || 'carried'],
    ['memory_class', memoryClass],
    ['session_id', session.sessionId],
    ['source_files', fileName],
    ...(input.supersedes ? [['supersedes', input.supersedes]] : []),
    ['covers_from', session.coversFrom || 'unknown'],
    ['covers_to', session.coversTo || 'unknown'],
    ['event_time', session.coversTo || savedAt],
    ['recorded_at', savedAt],
    ['updated_at', savedAt],
    ['timezone', timezone],
    ['time_source', 'system_clock'],
    ['confidence', '0.7'],
    ['privacy', 'device_local'],
    ['status', 'current'],
    ['tags', 'session, digest'],
    ['seq', '1'],
    ['weight', String(digest.weight || 60)],
    ['weight_bucket', 'hot'],
    ['weight_computed_at', savedAt],
    ['purge_after', input.purgeAfter || savedAt],
    ['details_purged', 'false'],
    ['summary_model', SUMMARY_MODEL],
    ['summary_model_version', SUMMARY_MODEL_VERSION],
    ['summary_generated_at', savedAt],
    ['summary_source', 'local'],
    ['summary_status', (digest.increments || []).length === 0 ? 'pending' : 'current'],
  ].map(([key, value]) => ({ key, value }));

  const bodyLines = [];
  const increments = digest.increments || [];
  // 要点常驻不回收，只放得分最高的几条；增量区块保留全部并带时间戳。
  const highlights = [...increments]
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, 6)
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));

  bodyLines.push('要点：');
  if (highlights.length === 0) {
    bodyLines.push('- （本会话无可抽取要点）');
  } else {
    for (const item of highlights) {
      const speaker = item.speaker === 'user' ? '用户' : item.speaker === 'tool' ? '工具' : '助手';
      const kind = KIND_LABEL[item.kind] || item.kind;
      bodyLines.push(`- [${speaker}·${kind}] ${item.quote.trim()}`);
    }
  }

  bodyLines.push('');
  bodyLines.push(PURGE_HEADING);
  bodyLines.push('');
  for (const item of increments) {
    bodyLines.push(`- ${item.event_time || savedAt} ${item.quote.trim()}`);
  }

  if ((digest.carried || []).length > 0) {
    bodyLines.push('');
    bodyLines.push('### 承接');
    bodyLines.push('');
    bodyLines.push('> 沿用上一条摘要，未改写。');
    for (const line of digest.carried) bodyLines.push(`- ${line}`);
  }

  bodyLines.push('');
  bodyLines.push(`> [!note] 权威内容以源记忆文件 ${fileName} 为准，本摘要仅用于低 token 载入。`);
  bodyLines.push(`> [!purge] 超过 ${input.purgeDays || 20} 天后只回收「${PURGE_HEADING}」明细，要点与指针保留。`);

  return {
    id,
    title: `会话总结 · ${oneLine(session.title || session.sessionId, 40)}`,
    fields,
    bodyLines,
    blocks: [],
    fieldMap: Object.fromEntries(fields.map((field) => [field.key, field.value])),
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

/** 索引区块：id + 一行摘要 + event_time + status */
export function buildIndexBlock(entryOrEntries) {
  const entries = Array.isArray(entryOrEntries) ? entryOrEntries : [entryOrEntries];
  const lines = [
    '## 记忆索引',
    '',
    '> 索引仅用于快速定位与概览，权威内容以条目正文为准。',
    '',
  ];
  for (const entry of entries) {
    const summary = oneLine((entry.bodyLines || []).find((line) => line.startsWith('- [')) || '', 100)
      .replace(/^-\s*/, '')
      .trim();
    lines.push(`- ${entry.id}: ${summary} · event_time=${entry.fieldMap.event_time} · status=${entry.fieldMap.status} · weight=${entry.fieldMap.weight}`);
  }
  return lines.join('\n');
}

/**
 * 组装整份记忆文件。
 * @returns {{text: string, entryId: string, indexTokensEst: number}}
 */
export function buildMemoryFileText(input) {
  const entry = buildDigestEntry(input);
  const extras = input.extraEntries || [];
  const all = [entry, ...extras];

  // 先把索引区块算出来，token 估算要把它写进 front matter
  const indexBlock = buildIndexBlock(all);
  const indexTokensEst = estimateTokens(indexBlock);

  const front = [
    '---',
    `memory_format: ${MEMORY_FORMAT}`,
    `format_version: ${FORMAT_VERSION}`,
    `saved_at: ${input.savedAt}`,
    `session_name: ${oneLine(input.session.title || input.session.sessionId, 80)}`,
    `session_id: ${input.session.sessionId}`,
    `message_range: ${input.session.messageRange}`,
    `memory_class: ${input.memoryClass}`,
    `summary_model: ${SUMMARY_MODEL}`,
    `summary_model_version: ${SUMMARY_MODEL_VERSION}`,
    `entries: ${all.length}`,
    `index_tokens_est: ${indexTokensEst}`,
    '---',
    '',
  ].join('\n');

  const entryText = all.map((item) => renderEntry({ ...item, trailing: '\n' })).join('');
  const text = `${front}${indexBlock}\n\n${entryText}`;
  return { text, entryId: entry.id, indexTokensEst, entry, entries: all.length };
}

/** 供测试与调试：正文里被回收时会删掉的行区间（只含增量区块本身） */
export function purgeRegion(bodyLines) {
  const start = bodyLines.indexOf(PURGE_HEADING);
  if (start < 0) return null;
  let end = bodyLines.length;
  for (let i = start + 1; i < bodyLines.length; i += 1) {
    if (/^###\s/.test(bodyLines[i]) || /^>[ \t]*\[!/.test(bodyLines[i])) { end = i; break; }
  }
  return { start, end };
}

export { escapeBodyLines };
