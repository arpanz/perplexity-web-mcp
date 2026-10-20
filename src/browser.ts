import { chromium, type BrowserContext, type Page } from "playwright";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = process.env.PERPLEXITY_WEB_MCP_PROFILE ?? path.resolve(__dirname, "../.playwright/profile");

// Prefer Playwright's bundled Chromium; fall back to the installed Google Chrome
// (still with its own separate profile directory) when Chromium hasn't been downloaded.
// The "chromium" channel uses Chrome's new headless mode, which Cloudflare lets through,
// rather than the stripped-down headless shell, which it blocks.
function browserChannel(): string {
  if (fs.existsSync(chromium.executablePath())) return "chromium";
  console.error("[perplexity-web-mcp] Playwright Chromium not found, using installed Google Chrome.");
  return "chrome";
}

// Runs headless by default. The window is only shown for signing in, or always when
// PERPLEXITY_WEB_MCP_HEADED=1 (a fallback in case Cloudflare starts blocking headless Chrome).
const ALWAYS_HEADED = process.env.PERPLEXITY_WEB_MCP_HEADED === "1";

let context: BrowserContext | null = null;
let contextHeaded = false;

export async function launchBrowser(headed = false): Promise<void> {
  if (context) {
    await context.close();
    context = null;
  }

  contextHeaded = headed || ALWAYS_HEADED;
  context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: browserChannel(),
    headless: !contextHeaded,
    viewport: { width: 1280, height: 800 },
    args: [
      "--disable-blink-features=AutomationControlled",
      "--window-position=0,0",
      "--no-focus-on-map",
    ],
  });
}

// Launches the browser if needed, relaunching with a visible window when `headed` is requested
export async function ensureBrowser({ headed = false } = {}): Promise<void> {
  if (!context || (headed && !contextHeaded)) await launchBrowser(headed);
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
