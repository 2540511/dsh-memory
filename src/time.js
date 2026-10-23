/**
 * 时间工具：ISO 8601 带时区、精确到秒。
 *
 * 规格要求所有记忆时间都是带时区的 ISO 8601，所以不能用 Date#toISOString
 * （那是 UTC，会丢掉本地时区偏移）。这里用 Intl 取目标时区的墙上时间与偏移。
 */

/** 把 Date 转成指定时区的 `YYYY-MM-DDTHH:mm:ss+08:00` */
export function isoSeconds(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'longOffset',
  }).formatToParts(date);

  const get = (type) => (parts.find((part) => part.type === type) || {}).value || '';
  const year = get('year');
  const month = get('month');
  const day = get('day');
  const hour = get('hour') === '24' ? '00' : get('hour');
  const offsetRaw = get('timeZoneName');
  const offset = offsetRaw === 'GMT' ? '+00:00' : offsetRaw.replace('GMT', '');
  return `${year}-${month}-${day}T${hour}:${get('minute')}:${get('second')}${offset}`;
}

/** 文件名时间戳 `YYYY-MM-DD_HHmmss` */
export function fileStamp(date, timeZone) {
  const iso = isoSeconds(date, timeZone);
  return iso.slice(0, 10) + '_' + iso.slice(11, 19).replace(/:/g, '');
}

/** 当前时区名（用于写入 timezone 字段） */
export function resolveTimeZone(fallback = 'Asia/Shanghai') {
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return resolved || fallback;
  } catch {
    return fallback;
  }
}
