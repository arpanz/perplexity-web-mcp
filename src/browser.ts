import { chromium, type BrowserContext, type Page } from "playwright";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import os from "os";

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

// Cache directories that a profile copy can do without
const SKIP_IN_COPY = new Set(["Cache", "Code Cache", "GPUCache", "Service Worker", "DawnGraphiteCache",
  "DawnWebGPUCache", "GraphiteDawnCache", "ShaderCache", "GrShaderCache", "BrowserMetrics-spare.pma"]);

let context: BrowserContext | null = null;
let contextHeaded = false;
let tempProfile: string | null = null;

// Chrome locks a profile to one running instance. When another server instance (e.g. a second
// Claude Code session) already has it open, run on a temporary copy instead, which keeps the sign-in.
function copyProfile(): string {
  sweepStaleCopies();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `perplexity-web-mcp-${process.pid}-`));
  fs.cpSync(PROFILE_DIR, dir, {
    recursive: true,
    filter: (src) => {
      const name = path.basename(src);
      return !name.startsWith("Singleton") && !SKIP_IN_COPY.has(name);
    },
  });
  return dir;
}

// Chrome may still be writing to the copy when the process exits, so ignore failures here;
// leftovers are swept on a later start (see sweepStaleCopies).
function removeTempProfile(): void {
  if (tempProfile) {
    try {
      fs.rmSync(tempProfile, { recursive: true, force: true, maxRetries: 3 });
    } catch {}
    tempProfile = null;
  }
}

// Removes profile copies left behind by server processes that are no longer running
function sweepStaleCopies(): void {
  for (const name of fs.readdirSync(os.tmpdir())) {
    const pid = Number(name.match(/^perplexity-web-mcp-(\d+)-/)?.[1]);
    if (!pid || pid === process.pid) continue;
    try {
      process.kill(pid, 0);
    } catch {
      try {
        fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
      } catch {}
    }
  }
}

process.on("exit", removeTempProfile);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => process.exit(0));
}

function launch(profileDir: string, headed: boolean): Promise<BrowserContext> {
  return chromium.launchPersistentContext(profileDir, {
    channel: browserChannel(),
    headless: !headed,
    chromiumSandbox: true,
    viewport: { width: 1280, height: 800 },
    args: [
      "--disable-blink-features=AutomationControlled",
      "--window-position=0,0",
      "--no-focus-on-map",
    ],
  });
}

export async function launchBrowser(headed = false): Promise<void> {
  await closeBrowser();

  contextHeaded = headed || ALWAYS_HEADED;
  try {
    context = await launch(PROFILE_DIR, contextHeaded);
  } catch (err) {
    if (!(err instanceof Error && err.message.includes("ProcessSingleton"))) throw err;
    // Signing in must happen in the real profile, or it would be lost with the copy
    if (headed) {
      throw new Error(
        "The Perplexity browser profile is in use by another Claude Code session. " +
        "Sign in from that session, or close it and try again."
      );
    }
    console.error("[perplexity-web-mcp] Profile in use by another instance, using a temporary copy.");
    tempProfile = copyProfile();
    context = await launch(tempProfile, contextHeaded);
  }
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
  removeTempProfile();
}
