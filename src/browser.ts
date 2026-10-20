import { chromium, type BrowserContext, type Page } from "playwright";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = process.env.PERPLEXITY_WEB_MCP_PROFILE ?? path.resolve(__dirname, "../.playwright/profile");

// Prefer Playwright's bundled Chromium; fall back to the installed Google Chrome
// (still with its own separate profile directory) when Chromium hasn't been downloaded.
function browserChannel(): string | undefined {
  if (fs.existsSync(chromium.executablePath())) return undefined;
  console.error("[perplexity-web-mcp] Playwright Chromium not found, using installed Google Chrome.");
  return "chrome";
}

let context: BrowserContext | null = null;

export async function launchBrowser(): Promise<void> {
  if (context) {
    await context.close();
    context = null;
  }

  context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: browserChannel(),
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: [
      "--disable-blink-features=AutomationControlled",
      "--window-position=0,0",
      "--no-focus-on-map",
    ],
  });
}

export async function ensureBrowser(): Promise<void> {
  if (!context) await launchBrowser();
}

export function getContext(): BrowserContext {
  if (!context) throw new Error("Browser not initialized. Call launchBrowser first.");
  return context;
}

export async function newSearchPage(): Promise<Page> {
  return getContext().newPage();
}

export async function getFirstPage(): Promise<Page> {
  const ctx = getContext();
  return ctx.pages()[0] ?? ctx.newPage();
}

export async function closeBrowser(): Promise<void> {
  if (context) {
    await context.close();
    context = null;
  }
}
