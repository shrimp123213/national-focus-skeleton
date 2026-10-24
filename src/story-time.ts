/**
 * Story time for people and models (v0.15.6). Days are counted from year 0 when the story time is
 * a date (see `storyDay` in platform.ts), so a day count means nothing to a reader; this turns it
 * back into the date. Small numbers come from a plain day count and stay a story day.
 *
 * Give `source` (the current source time text) to write past dates like the current one: the same
 * era name and the same zero padding. An era change during the story is not tracked.
 */
export function storyTime(day: number, withClock = false, source?: string): string {
  if (!Number.isFinite(day)) {
    return '';
  }
  if (day < 366) {
    return `故事日 ${Math.floor(day)}`;
  }
  const date = new Date(Math.round(((day - 719528) * 86400000) / 60000) * 60000);
  const clock =
    withClock && (date.getUTCHours() || date.getUTCMinutes())
      ? ` ${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`
      : '';
  const layout = source ? sourceLayout(source) : null;
  const part = (value: number) => (layout?.pad ? String(value).padStart(2, '0') : String(value));
  return `${layout?.era ?? ''}${date.getUTCFullYear()}年${part(date.getUTCMonth() + 1)}月${part(date.getUTCDate())}日${clock}`;
}

/** Current source text for display; `day` remains the last processed time used by game rules. */
export function stateTime(state: { day: number; time?: string }, withClock = true): string {
  if (!state.time) {
    return storyTime(state.day, withClock);
  }
  if (withClock) {
    return state.time;
  }
  return sourceDate(state.time);
}

/** Keep the source's era, but show only year/month/day without hyphens in the UI. */
function sourceDate(time: string): string {
  const date = time.match(/^.*?\d日|^\d{1,6}[-/]\d{1,2}[-/]\d{1,2}/)?.[0] ?? time;
  return date.replace(/^(\d{1,6})[-/](\d{1,2})[-/](\d{1,2})$/, '$1年$2月$3日').replaceAll('-', '');
}

/**
 * Era name and zero padding of the source date. A month or day with a leading zero means padding;
 * a one-digit part means none. When both parts have two digits, a hyphen or slash date means padding.
 */
function sourceLayout(time: string): { era: string; pad: boolean } | null {
  const match = sourceDate(time).match(/^(.*?)\d{1,6}年(\d{1,2})月(\d{1,2})日$/);
  if (!match) {
    return null;
  }
  const [, era, month, day] = match;
  const parts = [month, day];
  const pad =
    parts.some((part) => part.startsWith('0')) ||
    (parts.every((part) => part.length === 2) && /[-/]/.test(time));
  return { era, pad };
}
