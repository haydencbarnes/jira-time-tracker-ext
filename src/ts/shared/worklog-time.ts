import type { JiraWorklog } from './types';

export interface WorklogDurationOptions {
  allowWeeks?: boolean;
}

const BASE_WORKLOG_DURATION_SECONDS = {
  d: 60 * 60 * 24,
  h: 60 * 60,
  m: 60,
} as const;

const WORKLOG_DURATION_SECONDS_WITH_WEEKS = {
  w: 60 * 60 * 24 * 5,
  ...BASE_WORKLOG_DURATION_SECONDS,
} as const;

function getAllowedDurationUnits(allowWeeks: boolean): string {
  return allowWeeks ? 'wdhm' : 'dhm';
}

function getDurationUnitMap(allowWeeks: boolean) {
  return allowWeeks
    ? WORKLOG_DURATION_SECONDS_WITH_WEEKS
    : BASE_WORKLOG_DURATION_SECONDS;
}

function parseDateInput(dateInput?: string | Date | null): Date | null {
  if (!dateInput) return new Date();

  if (dateInput instanceof Date) {
    if (isNaN(dateInput.getTime())) return null;
    return new Date(dateInput);
  }

  const trimmed = String(dateInput).trim();
  if (!trimmed) return new Date();

  const dateOnlyMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnlyMatch) {
    const [, year, month, day] = dateOnlyMatch;
    return new Date(Number(year), Number(month) - 1, Number(day));
  }

  const parsed = new Date(trimmed);
  return isNaN(parsed.getTime()) ? null : parsed;
}

function formatDateWithOffset(date: Date): string {
  const timezoneOffsetMinutes = -date.getTimezoneOffset();
  const timezoneSign = timezoneOffsetMinutes >= 0 ? '+' : '-';
  const pad = (value: number, width = 2) =>
    String(Math.abs(Math.floor(value))).padStart(width, '0');

  return (
    `${date.getFullYear()}-` +
    `${pad(date.getMonth() + 1)}-` +
    `${pad(date.getDate())}T` +
    `${pad(date.getHours())}:` +
    `${pad(date.getMinutes())}:` +
    `${pad(date.getSeconds())}.` +
    `${pad(date.getMilliseconds(), 3)}` +
    `${timezoneSign}${pad(Math.abs(Math.floor(timezoneOffsetMinutes / 60)))}:` +
    `${pad(Math.abs(timezoneOffsetMinutes % 60))}`
  );
}

export function isValidWorklogDuration(
  input: string,
  options: WorklogDurationOptions = {}
): boolean {
  const trimmed = input.trim();
  if (!trimmed) return false;

  const pattern = new RegExp(
    `^(?:\\s*\\d+(?:\\.\\d+)?\\s*[${getAllowedDurationUnits(
      options.allowWeeks === true
    )}]\\s*)+$`,
    'i'
  );

  return pattern.test(trimmed);
}

export function parseWorklogDurationToSeconds(
  input: string,
  options: WorklogDurationOptions = {}
): number {
  const allowWeeks = options.allowWeeks === true;
  const units = getDurationUnitMap(allowWeeks);
  const tokenPattern = new RegExp(
    `(\\d+(?:\\.\\d+)?)\\s*([${getAllowedDurationUnits(allowWeeks)}])`,
    'gi'
  );

  let totalSeconds = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(input)) !== null) {
    const value = parseFloat(match[1]);
    const unit = match[2].toLowerCase() as keyof typeof units;
    const secondsPerUnit = units[unit];
    if (!Number.isNaN(value) && secondsPerUnit != null) {
      totalSeconds += value * secondsPerUnit;
    }
  }

  return Math.round(totalSeconds);
}

export function getWorklogDurationValidationMessage(
  options: WorklogDurationOptions = {}
): string {
  const lines = [
    'Invalid time format. Please use:',
    '• Hours: 2h, 1.5h',
    '• Minutes: 30m, 45m',
    '• Days: 1d, 0.5d',
  ];

  if (options.allowWeeks === true) {
    lines.push('• Weeks: 1w, 0.5w');
  }

  const examples = options.allowWeeks === true
    ? 'Examples: "2h 30m", "1d", "45m", "1w 2d"'
    : 'Examples: "2h 30m", "1d", "45m"';

  return `${lines.join('\n')}\n\n${examples}`;
}

export function buildWorklogStartedTimestamp(
  dateInput?: string | Date | null
): string {
  try {
    const baseDate = parseDateInput(dateInput);
    if (!baseDate) {
      return new Date().toISOString();
    }

    const now = new Date();
    baseDate.setHours(
      now.getHours(),
      now.getMinutes(),
      now.getSeconds(),
      now.getMilliseconds()
    );

    return formatDateWithOffset(baseDate);
  } catch {
    return new Date().toISOString();
  }
}

export function buildNoonWorklogStartedTimestamp(
  dateInput?: string | Date | null
): string {
  try {
    const baseDate = parseDateInput(dateInput);
    if (!baseDate) {
      return new Date().toISOString();
    }

    baseDate.setHours(12, 0, 0, 0);
    return baseDate.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

export function sumWorklogSeconds(worklogs: JiraWorklog[]): number {
  return Array.isArray(worklogs)
    ? worklogs.reduce((total, worklog) => total + worklog.timeSpentSeconds, 0)
    : 0;
}
