// Small text helpers: escaping, money, numbers, drive times.

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape text for HTML. Every piece of show data that goes into an HTML string passes through this. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

export function formatMoney(amount: number | null | undefined, currency = 'USD'): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return '';
  const whole = Math.abs(amount - Math.round(amount)) < 0.005;
  const text = whole ? Math.round(amount).toLocaleString('en-US') : amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency === 'CAD' ? `$${text} CAD` : `$${text}`;
}

export function formatNumber(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** Round a big count for people: 1,234 becomes "about 1,200". */
export function roundedCount(n: number): number {
  if (n < 100) return Math.round(n / 5) * 5 || 5;
  if (n < 1000) return Math.round(n / 10) * 10;
  if (n < 10000) return Math.round(n / 100) * 100;
  return Math.round(n / 1000) * 1000;
}

/** "about 35 min", "about 2 h", "about 2 h 10 min". Rounded to 5 minutes. */
export function formatDriveTime(minutes: number): string {
  const rounded = Math.max(5, Math.round(minutes / 5) * 5);
  if (rounded < 60) return `about ${rounded} min`;
  const h = Math.floor(rounded / 60);
  const m = rounded % 60;
  return m === 0 ? `about ${h} h` : `about ${h} h ${m} min`;
}

export function plural(n: number, one: string, many: string = `${one}s`): string {
  return n === 1 ? `${n} ${one}` : `${n.toLocaleString('en-US')} ${many}`;
}

/** Make a URL-safe slug. */
export function slugify(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Only http and https links are allowed through to href attributes. */
export function safeUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/** The host of a URL for display ("example.com"), or the input when it is not a URL. */
export function displayHost(u: string): string {
  try {
    return new URL(u).host.replace(/^www\./, '');
  } catch {
    return u;
  }
}
