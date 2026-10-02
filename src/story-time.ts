/**
 * Story time for people and models (v0.15.6). Days are counted from year 0 when the story time is
 * a date (see `storyDay` in platform.ts), so a day count means nothing to a reader; this turns it
 * back into the date. Small numbers come from a plain day count and stay a story day.
 */
export function storyTime(day: number, withClock = false): string {
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
  return `${date.getUTCFullYear()}年${date.getUTCMonth() + 1}月${date.getUTCDate()}日${clock}`;
}

/** Current source text for display; `day` remains the last processed time used by game rules. */
export function stateTime(state: { day: number; time?: string }, withClock = true): string {
  return state.time || storyTime(state.day, withClock);
}
