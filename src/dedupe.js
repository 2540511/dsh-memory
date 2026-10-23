/**
 * 去重合并：找出内容重复的长期要点 / 多媒体条目。
 *
 * 只做"选一个胜者、其余标 superseded"的决定，不删任何东西。
 * 幂等：合并过的条目状态不是 current，下次不会再参与分组。
 */

/** 归一化比较键：去空白、全角空格、大小写 */
function normalize(text) {
  return String(text || '')
    .replace(/[\s\u3000]+/g, ' ')
    .trim()
    .toLowerCase();
}

function longTermKey(entry) {
  const map = entry.fieldMap || {};
  return `long_term:${map.kind || ''}:${normalize(map.value)}`;
}

function mediaKey(entry) {
  const map = entry.fieldMap || {};
  return `media:${map.media_source || ''}`;
}

/**
 * 找出重复组。
 * @param {Array} docs [{file, entry}]
 * @returns {Array<{key, keeper, duplicates:[{file, entry}]}>}
 */
export function findDuplicates(docs) {
  const groups = new Map();

  for (const doc of docs || []) {
    const entry = doc && doc.entry;
    if (!entry) continue;
    const map = entry.fieldMap || {};
    if (map.status !== 'current') continue;

    let key = null;
    if (map.type === 'long_term') key = longTermKey(entry);
    else if (map.type === 'media_summary') key = mediaKey(entry);
    if (!key) continue;

    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ file: doc.file, entry });
  }

  const result = [];
  for (const [key, items] of groups) {
    if (items.length < 2) continue;

    // 胜者优先级：有描述的多媒体 > 更早的条目（保留原始时间线）
    const keeper = items.find((item) => item.entry.fieldMap.media_desc_status === 'current')
      || items.reduce((best, item) => {
        const a = Date.parse(item.entry.fieldMap.recorded_at) || 0;
        const b = Date.parse(best.entry.fieldMap.recorded_at) || 0;
        return a < b ? item : best;
      });

    result.push({
      key,
      keeper,
      duplicates: items.filter((item) => item !== keeper),
    });
  }
  return result;
}
