/**
 * 导入 / 导出 / 审计。
 *
 * 纯函数，不碰 IO。导出必须是自包含的 Markdown，能被本模块自己的 planImport 读回；
 * 导入默认"新增 + 冲突标记"，绝不覆盖已有记忆。
 */
import { renderEntry, estimateTokens } from './format.js';

export const AUDIT_FILE = '_audit.md';

/** 内容指纹：标题 + 正文归一后取短哈希，用于识别"同 ID 同内容" */
export function fingerprint(entry) {
  const text = `${entry.title || ''}\n${(entry.bodyLines || []).join('\n')}`
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  }
  return `${text.length.toString(36)}-${hash.toString(36)}`;
}

/**
 * 按范围挑选条目。
 * @param {Array} docs [{file, entry}]
 * @param {object} scope {kind:'all'|'type'|'time'|'tag'|'id', value, type, from, to, tag, id}
 */
export function selectEntries(docs, scope = {}) {
  const kind = scope.kind || 'all';
  const picked = [];
  for (const doc of docs || []) {
    const entry = doc && doc.entry;
    if (!entry) continue;
    const map = entry.fieldMap || {};
    if (map.privacy === 'secret') continue;

    if (kind === 'type' && scope.value && map.type !== scope.value) continue;
    if (kind === 'tag') {
      const tags = String(map.tags || '').split(/[,，\s]+/).filter(Boolean);
      if (!scope.value || !tags.includes(scope.value)) continue;
    }
    if (kind === 'id' && scope.value && entry.id !== scope.value) continue;
    if (kind === 'time') {
      const at = map.event_time && map.event_time !== 'unknown' ? Date.parse(map.event_time) : NaN;
      if (Number.isNaN(at)) continue;
      if (scope.from && at < Date.parse(scope.from)) continue;
      if (scope.to && at > Date.parse(scope.to)) continue;
    }
    picked.push({ ...doc, fingerprint: fingerprint(entry) });
  }
  return picked;
}

/** 生成自包含导出文档 */
export function buildExportDocument(docs, options = {}) {
  const exportedAt = options.exportedAt;
  const scope = options.scopeLabel || 'all';
  const sourceFiles = [...new Set((docs || []).map((doc) => doc.file))];

  const head = [
    '---',
    'memory_format: dsh-memory',
    'format_version: 1',
    `exported_at: ${exportedAt}`,
    `saved_at: ${exportedAt}`,
    `export_scope: ${scope}`,
    `entries: ${(docs || []).length}`,
    `source_files: ${sourceFiles.join(', ').slice(0, 400)}`,
    '---',
    '',
    '## 导出说明',
    '',
    '> 本文件为自包含导出，可直接用「导入」还原；条目正文为权威内容，索引不随导出携带。',
    '',
  ].join('\n');

  const body = (docs || []).map((doc) => renderEntry({ ...doc.entry, trailing: '\n' })).join('');
  const text = `${head}${body}`;
  return {
    text,
    entries: (docs || []).length,
    files: sourceFiles,
    bytes: Buffer.byteLength(text, 'utf8'),
    tokensEst: estimateTokens(text),
  };
}

const REQUIRED_FIELDS = ['type', 'event_time', 'recorded_at', 'updated_at', 'timezone', 'time_source', 'confidence', 'privacy', 'status', 'tags', 'seq'];
const KNOWN_FIELDS = new Set([...REQUIRED_FIELDS, 'supersedes', 'superseded_by', 'memory_class', 'source_seqs', 'turn', 'verbatim', 'evidence_kind', 'file_path', 'added', 'deleted', 'diff_kind', 'purge_after', 'details_purged', 'conflict_policy', 'weight_exempt', 'weight', 'weight_bucket', 'weight_computed_at', 'digest_level', 'digest_basis', 'session_id', 'source_files', 'covers_from', 'covers_to', 'summary_model', 'summary_model_version', 'summary_generated_at', 'summary_source', 'summary_status', 'seq_reassigned']);

/**
 * 导入规划：不写盘，只决定每条的去向。
 *
 * @param {object} parsed parseMemoryFile 的结果
 * @param {object} options {existingIds:Set, existingFingerprints:Map<id, fp>, now}
 * @returns {{ok:boolean, error?:string, plan:Array, report:object}}
 */
export function planImport(parsed, options = {}) {
  const existingIds = options.existingIds || new Set();
  const existingFingerprints = options.existingFingerprints || new Map();
  const fm = (parsed && parsed.frontMatter && parsed.frontMatter.data) || {};

  if (fm.memory_format !== 'dsh-memory') {
    return { ok: false, error: '不是 dsh-memory 导出文件（memory_format 不符）', plan: [], report: emptyReport() };
  }
  if (String(fm.format_version) !== '1') {
    return { ok: false, error: `格式版本不兼容: ${fm.format_version}，本插件只接受 1`, plan: [], report: emptyReport() };
  }

  const plan = [];
  const report = emptyReport();

  for (const entry of (parsed.entries || [])) {
    const map = entry.fieldMap || {};
    const missing = REQUIRED_FIELDS.filter((key) => !(key in map));
    if (missing.length > 0) {
      report.failed += 1;
      report.missingFields.push({ id: entry.id, fields: missing });
      plan.push({ id: entry.id, action: 'reject', reason: `缺少字段: ${missing.join(', ')}` });
      continue;
    }
    if (map.privacy === 'secret') {
      report.rejected += 1;
      plan.push({ id: entry.id, action: 'reject', reason: 'privacy=secret，拒绝导入' });
      continue;
    }

    const fp = fingerprint(entry);
    if (existingIds.has(entry.id)) {
      if (existingFingerprints.get(entry.id) === fp) {
        report.skipped += 1;
        plan.push({ id: entry.id, action: 'skip', reason: '同一 ID 且内容相同' });
      } else {
        report.conflicts += 1;
        plan.push({ id: entry.id, action: 'conflict', reason: '同一 ID 但内容不同，标记冲突不覆盖' });
      }
      continue;
    }

    const unknown = Object.keys(map).filter((key) => !KNOWN_FIELDS.has(key));
    if (unknown.length > 0) report.unknownFields.push({ id: entry.id, fields: unknown });

    report.accepted += 1;
    plan.push({ id: entry.id, action: 'accept', entry, fingerprint: fp });
  }

  const acceptedSeqs = plan.filter((item) => item.action === 'accept').map((item) => Number(item.entry.fieldMap.seq));
  const seqSet = new Set();
  let seqProblem = acceptedSeqs.some((seq) => !Number.isInteger(seq));
  for (const seq of acceptedSeqs) {
    if (seqSet.has(seq)) seqProblem = true;
    seqSet.add(seq);
  }
  if (seqProblem) {
    let next = 1;
    for (const item of plan) {
      if (item.action !== 'accept') continue;
      item.entry.fieldMap.seq = String(next);
      item.entry.fields = item.entry.fields || [];
      const existing = item.entry.fields.find((field) => field.key === 'seq');
      if (existing) existing.value = String(next);
      const flag = item.entry.fields.find((field) => field.key === 'seq_reassigned');
      if (flag) flag.value = 'true';
      else item.entry.fields.push({ key: 'seq_reassigned', value: 'true' });
      next += 1;
    }
    report.seqReassigned = true;
  }

  return { ok: true, plan, report };
}

function emptyReport() {
  return {
    accepted: 0,
    skipped: 0,
    conflicts: 0,
    rejected: 0,
    failed: 0,
    missingFields: [],
    unknownFields: [],
    seqReassigned: false,
  };
}

/** 组装导入后的新文件 */
export function buildImportFileText(entries, options = {}) {
  const head = [
    '---',
    'memory_format: dsh-memory',
    'format_version: 1',
    `saved_at: ${options.at}`,
    'imported: true',
    `import_source: ${options.source || 'upload'}`,
    'memory_class: imported',
    'summary_model: none',
    `entries: ${entries.length}`,
    `index_tokens_est: 0`,
    '---',
    '',
    '## 记忆索引',
    '',
    '> 导入条目，索引未生成；权威内容以条目正文为准。',
    '',
  ].join('\n');
  return `${head}${entries.map((entry) => renderEntry({ ...entry, trailing: '\n' })).join('')}`;
}

/** 审计条目：与记忆条目同构，方便人读也方便机器读 */
export function renderAuditEntry(input) {
  const fields = [
    ['op', input.op],
    ['at', input.at],
    ['actor', input.actor || 'user'],
    ['result', input.result || 'ok'],
    ['entries', String(input.entries ?? 0)],
    ['source', input.source || 'local'],
    ['detail', input.detail || ''],
  ];
  const lines = [`## [AUDIT-${String(input.at).replace(/[^0-9]/g, '').slice(0, 14)}-${input.op}] ${input.op}`, ''];
  for (const [key, value] of fields) lines.push(`- ${key}: ${value}`);
  lines.push('');
  return lines.join('\n');
}
