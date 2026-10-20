import type { Page } from "playwright";
import { closeBrowser, ensureBrowser, getFirstPage } from "./browser.js";

const PERPLEXITY_HOME = "https://www.perplexity.ai/";
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// Perplexity's session API no longer reveals login state to a plain fetch, so read it from the page:
// signed-out visitors get a "Sign In" button (user-circle icon) in the sidebar.
const SIGN_IN_ICON = "#pplx-icon-user-circle";
const SIGN_IN_SETTLE_MS = 4_000;

const log = (msg: string) => console.error(`[perplexity-web-mcp] ${msg}`);

export async function checkSession(page: Page): Promise<boolean> {
  try {
    if (!page.url().startsWith(PERPLEXITY_HOME)) {
      await page.goto(PERPLEXITY_HOME, { waitUntil: "domcontentloaded" });
    }
    await page.locator('a[href="/library"]').first().waitFor({ state: "attached", timeout: 15_000 });
  } catch {
    return false;
  }

  // The sidebar renders about a second before the Sign In button, so keep watching for
  // SIGN_IN_SETTLE_MS after it appears; no button by then means the user is signed in.
  const signInShown = await page
    .waitForFunction(
      (icon) =>
        Array.from(document.querySelectorAll("button, a")).some((b) =>
          Array.from(b.querySelectorAll("use")).some(
            (u) => (u.getAttribute("xlink:href") ?? u.getAttribute("href")) === icon
          )
        ),
      SIGN_IN_ICON,
      { timeout: SIGN_IN_SETTLE_MS }
    )
    .then(() => true, () => false);
  return !signInShown;
}

// Checks the session headlessly; only if the user must sign in does it reopen the browser
// with a visible window, and it closes that window again once they have.
// Returns true if the user was already signed in.
export async function ensureAuthenticated(): Promise<boolean> {
  await ensureBrowser();
  if (await checkSession(await getFirstPage())) {
    log("Session active.");
    return true;
  }

  await ensureBrowser({ headed: true });
  const page = await getFirstPage();
  await page.goto(PERPLEXITY_HOME, { waitUntil: "domcontentloaded" });
  await page.bringToFront();

  log("No active session. Please log in to Perplexity in the browser window...");
  try {
    await waitForLogin(page);
    log("Login detected.");
  } finally {
    await closeBrowser();
  }
  return false;
}

async function waitForLogin(page: Page): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    // Don't navigate away while the user is on a sign-in provider's page (e.g. Google)
    if (!page.url().startsWith(PERPLEXITY_HOME)) continue;
    const ok = await checkSession(page);
    if (ok) return;
  }
  throw new Error("Login timeout after 5 minutes.");
}
