import type { Currency, ListingView, PriceDrop, RunReport, SearchReport, SoldView } from '../types.js';

/** Telegram limit for one message (counted in UTF-16 code units, same as String#length). */
const MAX_MESSAGE_LEN = 4096;
const MAX_TITLE_LEN = 150;
const MAX_SEARCH_ERROR_LEN = 500;
const MAX_FAILURE_LEN = 3000;

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** 15500 -> "15 500" (regular space as thousands separator). */
function formatThousands(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** 12.3 -> "12,3", 120 -> "120" (Ukrainian decimal comma). */
function formatDecimal(n: number): string {
  return String(Math.round(n * 10) / 10).replace('.', ',');
}

function formatUsd(n: number): string {
  return `$${formatThousands(n)}`;
}

/** Date in Europe/Kyiv as dd.mm.yyyy. */
function formatKyivDate(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Kyiv',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).formatToParts(new Date(iso));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('day')}.${part('month')}.${part('year')}`;
}

function listingLine(listing: ListingView): string {
  const title = truncate(listing.title || `#${listing.id}`, MAX_TITLE_LEN);
  const fields: string[] = [`<a href="${escapeHtml(listing.url)}">${escapeHtml(title)}</a>`];
  if (listing.year != null) fields.push(String(listing.year));
  if (listing.mileageKm != null) fields.push(`${formatDecimal(listing.mileageKm / 1000)} тис. км`);
  if (listing.priceUsd != null) fields.push(formatUsd(listing.priceUsd));
  if (listing.city) fields.push(escapeHtml(listing.city));
  return `• ${fields.join(', ')}`;
}

/** Price in the seller's currency: "$15 500", "650 000 ₴", "€14 000". */
function formatPrice(amount: number, currency: Currency): string {
  const digits = formatThousands(amount);
  if (currency === 'USD') return `$${digits}`;
  if (currency === 'UAH') return `${digits} ₴`;
  return `€${digits}`;
}

function priceDropLine(drop: PriceDrop): string {
  const { listing, currency, oldPrice, newPrice } = drop;
  const title = truncate(listing.title || `#${listing.id}`, MAX_TITLE_LEN);
  const diff = oldPrice - newPrice;
  const percent = oldPrice > 0 ? `, −${formatDecimal((diff / oldPrice) * 100)}%` : '';
  const usdHint =
    currency !== 'USD' && drop.newPriceUsd != null ? ` ≈ ${formatUsd(drop.newPriceUsd)}` : '';
  return (
    `• <a href="${escapeHtml(listing.url)}">${escapeHtml(title)}</a>: ` +
    `${formatPrice(oldPrice, currency)} → ${formatPrice(newPrice, currency)} ` +
    `(−${formatPrice(diff, currency)}${percent})${usdHint}, ${listing.daysOnMarket} дн. на ринку`
  );
}

function soldLine(sold: SoldView): string {
  const title = truncate(sold.title || `#${sold.id}`, MAX_TITLE_LEN);
  const fields: string[] = [`<a href="${escapeHtml(sold.url)}">${escapeHtml(title)}</a>`];
  if (sold.price != null && sold.currency) {
    let price = formatPrice(sold.price, sold.currency);
    if (sold.currency !== 'USD' && sold.priceUsd != null) price += ` ≈ ${formatUsd(sold.priceUsd)}`;
    if (sold.firstPrice != null && sold.firstPrice > sold.price) {
      const diff = sold.firstPrice - sold.price;
      price += ` (було ${formatPrice(sold.firstPrice, sold.currency)}, −${formatDecimal((diff / sold.firstPrice) * 100)}%)`;
    }
    fields.push(price);
  } else if (sold.priceUsd != null) {
    fields.push(formatUsd(sold.priceUsd));
  }
  fields.push(`${sold.daysOnMarket} дн. на ринку`);
  return `• ${fields.join(', ')}`;
}

/** Blocks are atomic (one item or one line each), so a message never splits an item or a tag. */
function searchBlocks(search: SearchReport): string[] {
  const name = `<b><a href="${escapeHtml(search.url)}">${escapeHtml(search.search)}</a></b>`;
  if (!search.ok) {
    const error = truncate(search.error ?? 'невідома помилка', MAX_SEARCH_ERROR_LEN);
    return [name, `⚠️ Помилка: ${escapeHtml(error)}`];
  }
  if (search.baseline) {
    return [name, `Перший запуск: зафіксовано ${search.activeCount} оголошень`];
  }

  let summary =
    `+${search.newListings.length} нових · −${search.soldCount} продано · ` +
    `↓${search.priceDrops.length} подешевшало · ${search.activeCount} активних`;
  if (search.reposts.length > 0) summary += ` · ↻${search.reposts.length} репостів`;

  const blocks = [name, summary];
  if (search.newListings.length > 0) {
    blocks.push('<b>Нові:</b>', ...search.newListings.map(listingLine));
  }
  if (search.priceDrops.length > 0) {
    blocks.push('<b>Подешевшали:</b>', ...search.priceDrops.map(priceDropLine));
  }
  if (search.sold.length > 0) {
    blocks.push('<b>Продані / зняті:</b>', ...search.sold.map(soldLine));
  }
  return blocks;
}

/** Joins blocks with newlines into messages of at most MAX_MESSAGE_LEN, splitting only between blocks. */
function packMessages(blocks: string[]): string[] {
  const messages: string[] = [];
  let current = '';
  for (const block of blocks) {
    const candidate = current ? `${current}\n${block}` : block;
    if (current && candidate.length > MAX_MESSAGE_LEN) {
      messages.push(current.trim());
      current = block;
    } else {
      current = candidate;
    }
  }
  if (current.trim()) messages.push(current.trim());
  return messages;
}

export function formatDigest(report: RunReport, opts: { dashboardUrl?: string } = {}): string[] {
  const blocks = [`<b>🚗 AutoRia — ${formatKyivDate(report.finishedAt)}</b>`];
  for (const search of report.searches) {
    blocks.push('', ...searchBlocks(search));
  }

  const footer: string[] = [];
  if (opts.dashboardUrl) footer.push(`<a href="${escapeHtml(opts.dashboardUrl)}">Дашборд</a>`);
  if (report.errors.length > 0) footer.push(`⚠️ ${report.errors.length} помилок`);
  if (footer.length > 0) blocks.push('', ...footer);

  return packMessages(blocks);
}

export function formatFailure(error: unknown, runUrl?: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const lines = ['❌ AutoRia tracker впав', escapeHtml(truncate(message, MAX_FAILURE_LEN))];
  if (runUrl) lines.push(`<a href="${escapeHtml(runUrl)}">Лог запуску в Actions</a>`);
  return lines.join('\n');
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function readRetryAfter(res: Response): Promise<number> {
  try {
    const body = JSON.parse(await res.text()) as { parameters?: { retry_after?: unknown } };
    const retryAfter = body.parameters?.retry_after;
    return typeof retryAfter === 'number' ? retryAfter : 1;
  } catch {
    return 1;
  }
}

async function postMessage(token: string, chatId: string, text: string): Promise<void> {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const send = () =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });

  let res = await send();
  if (res.status === 429) {
    await sleep((await readRetryAfter(res)) * 1000);
    res = await send();
  }
  if (!res.ok) {
    const hint = res.status === 404 ? ' (TELEGRAM_BOT_TOKEN is wrong: Telegram does not know this bot)' : '';
    throw new Error(`Telegram sendMessage failed: HTTP ${res.status}${hint}: ${await res.text()}`);
  }
}

/** Sends messages in order. Without TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID it only prints them (dry run). */
export async function sendTelegram(
  messages: string[],
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  // Secrets pasted by hand often carry stray whitespace or a "bot" prefix.
  const token = env.TELEGRAM_BOT_TOKEN?.trim().replace(/^bot/, '');
  const chatId = env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) {
    console.log('TELEGRAM_BOT_TOKEN або TELEGRAM_CHAT_ID не задано: dry run, повідомлення у stdout.');
    for (const message of messages) console.log(`\n----- повідомлення -----\n${message}`);
    return;
  }
  for (const message of messages) {
    await postMessage(token, chatId, message);
  }
}
