import { loadSearches } from './config.js';
import { openDb } from './db.js';
import { createAutoRiaSource } from './source/autoria.js';
import { runTracker } from './tracker.js';
import { formatDigest, formatFailure, sendTelegram } from './report/telegram.js';

const DB_PATH = process.env.DB_PATH ?? 'data/autoria.db';
const CONFIG_PATH = process.env.SEARCHES_PATH ?? 'searches.yaml';

function actionsRunUrl(): string | undefined {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  if (!GITHUB_SERVER_URL || !GITHUB_REPOSITORY || !GITHUB_RUN_ID) return undefined;
  return `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
}

function dashboardUrl(): string | undefined {
  if (process.env.DASHBOARD_URL) return process.env.DASHBOARD_URL;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) return undefined;
  const [owner, name] = repo.split('/');
  return `https://${owner}.github.io/${name}/`;
}

/** Fetches only the first search to check that the site answers us (e.g. from CI IPs). */
async function probe(): Promise<void> {
  const [search] = loadSearches(CONFIG_PATH).filter((s) => s.enabled);
  if (!search) throw new Error('No enabled searches to probe');
  const source = createAutoRiaSource();
  const result = await source.search(search.url);
  console.log(`probe ok: "${search.name}" total=${result.total} parsed=${result.listings.length} requests=${source.requestCount}`);
  console.log(result.listings.slice(0, 3));
}

async function track(): Promise<boolean> {
  const searches = loadSearches(CONFIG_PATH);
  const db = openDb(DB_PATH);
  try {
    const report = await runTracker(db, createAutoRiaSource(), searches, new Date().toISOString());
    await sendTelegram(formatDigest(report, { dashboardUrl: dashboardUrl() }));
    console.log(`run #${report.runId}: ok=${report.ok} requests=${report.requests}`);
    for (const e of report.errors) console.log(`::warning::${e}`);
    for (const s of report.searches.filter((s) => !s.ok)) console.log(`::warning::${s.search}: ${s.error}`);
    return report.ok;
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--probe')) return probe();
  try {
    // Partial failures are reported in the digest; only a crash fails the job.
    await track();
  } catch (err) {
    console.error(err);
    await sendTelegram([formatFailure(err, actionsRunUrl())]).catch((e) => console.error('telegram failed:', e));
    process.exitCode = 1;
  }
}

await main();
