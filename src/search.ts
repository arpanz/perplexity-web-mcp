import type { Page } from "playwright";
import { newSearchPage } from "./browser.js";
import { selectModel } from "./model.js";

const PERPLEXITY_HOME = "https://www.perplexity.ai/";
export const DEFAULT_TIMEOUT_MS = 120_000;

// The final answer is rendered as markdown inside this container. Earlier `[data-renderer="lm"]`
// blocks on the page are the echoed question, so always read the one inside the final-text block.
const ANSWER_SELECTOR = '[data-workflow-final-text] [data-renderer="lm"]';

// How long the answer text must stay unchanged (with no "stop" button) before it counts as finished
const STABLE_MS = 2_000;
const POLL_MS = 500;

// Maps source name to its SVG icon id in the Perplexity UI — locale-independent
const SOURCE_ICON: Record<string, string> = {
  web:      "#pplx-icon-world",
  academic: "#pplx-icon-books",
  social:   "#pplx-icon-social",
};

// Icon ids of the "+" (add files or tools) button, newest first
const PLUS_ICONS = ["#pplx-icon-custom-plus-large", "#pplx-icon-plus"];
const CONNECTORS_ICON = "#pplx-icon-plug";

export interface Source {
  title: string;
  url: string;
}

export interface SearchResult {
  answer: string;
  sources: Source[];
  complete: boolean;
  model: string | null;
}

export interface SearchOptions {
  timeoutMs: number;
  sources?: string[];
  // Model names to try in order; the first one the account can use is selected
  models?: string[];
  thinking?: boolean;
}

const log = (msg: string) => console.error(`[perplexity-web-mcp] ${msg}`);

export async function search(query: string, options: SearchOptions): Promise<SearchResult> {
  const { timeoutMs, sources, models, thinking = true } = options;
  log(
    `Search: "${query}"` +
    (sources ? ` sources=[${sources.join(",")}]` : "") +
    (models ? ` models=[${models.join(",")}] thinking=${thinking}` : "") +
    ` (timeout: ${timeoutMs}ms)`
  );
  const page = await newSearchPage();

  try {
    log("Navigating to perplexity.ai...");
    await page.goto(PERPLEXITY_HOME, { waitUntil: "domcontentloaded" });
    await dismissDialogs(page);

    // Wait for the search input to be ready before any further interaction
    const searchBox = page.locator("#ask-input").first();
    await searchBox.waitFor({ state: "visible", timeout: 15_000 }).catch(async () => {
      const bodyHtml = await page.evaluate(() => document.body.innerHTML.slice(0, 5000));
      log(`DOM dump (first 5000 chars):\n${bodyHtml}`);
      throw new Error(
        "Perplexity's search box never appeared. If Cloudflare is blocking the hidden browser, " +
        "set PERPLEXITY_WEB_MCP_HEADED=1 in the MCP server's environment to use a visible window."
      );
    });

    if (sources) {
      log(`Selecting sources: [${sources.join(", ")}]...`);
      await selectSources(page, sources);
    }

    const model = models ? await selectModel(page, models, thinking) : null;

    log("Typing query...");
    await searchBox.click();
    await searchBox.fill(query);
    await searchBox.press("Enter");

    log("Waiting for answer to complete...");
    const { answer, complete } = await waitForAnswer(page, timeoutMs);
    const citedSources = await extractSources(page);

    log(`Done. Answer length: ${answer.length} chars, sources: ${citedSources.length}, complete: ${complete}`);
    return { answer, sources: citedSources, complete, model };
  } finally {
    await page.close();
  }
}

// Polls the answer until it is non-empty, no longer streaming, and unchanged for STABLE_MS.
// On timeout, returns whatever has rendered so far with complete=false.
async function waitForAnswer(page: Page, timeoutMs: number): Promise<{ answer: string; complete: boolean }> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  let stableSince = 0;

  while (Date.now() < deadline) {
    const answer = await extractAnswer(page).catch(() => "");
    const streaming = await isStreaming(page);

    if (answer && answer === last && !streaming) {
      if (Date.now() - stableSince >= STABLE_MS) return { answer, complete: true };
    } else {
      stableSince = Date.now();
    }
    last = answer;
    await page.waitForTimeout(POLL_MS);
  }

  log("Timed out waiting for the answer to finish.");
  return { answer: last, complete: false };
}

// Perplexity shows a "Stop" button while the answer is being generated
async function isStreaming(page: Page): Promise<boolean> {
  return page
    .evaluate(() =>
      Array.from(document.querySelectorAll("button")).some((b) =>
        /stop/i.test(b.getAttribute("aria-label") ?? "")
      )
    )
    .catch(() => false);
}

// Clicks the element whose <use> icon matches one of `icons`, among elements matching `selector`.
// Returns false if no such element appears. Icon ids are locale-independent, unlike labels.
// `*|href` matches both `href` and `xlink:href`; the locator re-resolves if menus re-render mid-animation.
async function clickByIcon(page: Page, selector: string, icons: string[]): Promise<boolean> {
  const target = page
    .locator(icons.map((icon) => `${selector}:has(use[*|href="${icon}"])`).join(", "))
    .first();
  try {
    await target.waitFor({ state: "visible", timeout: 5_000 });
  } catch {
    return false;
  }
  await target.click();
  return true;
}

// Selects exactly the given sources in the "+" → "Connectors" submenu.
// Note: Perplexity remembers this selection, so it also applies to later plain searches.
async function selectSources(page: Page, sources: string[]): Promise<void> {
  if (!(await clickByIcon(page, 'button[aria-haspopup="menu"]', PLUS_ICONS))) {
    throw new Error("Could not find the + (add files or tools) button on Perplexity");
  }
  if (!(await clickByIcon(page, '[role="menuitem"]', [CONNECTORS_ICON]))) {
    throw new Error("Could not find the Connectors menu on Perplexity. Source selection needs a signed-in account: call the `login` tool first.");
  }
  await page.locator('[role="menuitemcheckbox"]').first().waitFor({ state: "visible", timeout: 5_000 });

  // Read the current state of every known source checkbox
  const state = await page.evaluate((sourceIcons) => {
    const result: Record<string, boolean> = {};
    for (const item of Array.from(document.querySelectorAll('[role="menuitemcheckbox"]'))) {
      const hrefs = Array.from(item.querySelectorAll("use")).map(
        (u) => u.getAttribute("xlink:href") ?? u.getAttribute("href") ?? ""
      );
      for (const [name, icon] of Object.entries(sourceIcons)) {
        if (hrefs.includes(icon)) result[name] = item.getAttribute("aria-checked") === "true";
      }
    }
    return result;
  }, SOURCE_ICON);

  const missing = sources.filter((s) => !(s in state));
  if (missing.length > 0) {
    await page.keyboard.press("Escape");
    throw new Error(
      `Source(s) not available in your Perplexity account: ${missing.join(", ")}. ` +
      `Available: ${Object.keys(state).join(", ") || "none"}`
    );
  }

  // Check targets, uncheck every other known source
  for (const [name, checked] of Object.entries(state)) {
    if (checked !== sources.includes(name)) {
      await clickByIcon(page, '[role="menuitemcheckbox"]', [SOURCE_ICON[name]]);
      await page.waitForTimeout(200);
    }
  }

  // Close menus
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
}

async function dismissDialogs(page: Page): Promise<void> {
  // Cookie banner — "Cookies nécessaires" / "Necessary cookies"
  const cookieBtn = page.locator(
    'button:has-text("Cookies nécessaires"), button:has-text("Necessary cookies")'
  ).first();
  if (await cookieBtn.isVisible({ timeout: 1_500 }).catch(() => false)) {
    log("Dismissing cookie banner...");
    await cookieBtn.click().catch(() => {});
    await page.waitForTimeout(300);
  }

  // Login/signup overlay — Perplexity renders this as a generic div, not a <dialog>.
  // The close button text is "Fermer" (FR) or has aria-label "Close" (EN).
  const closeBtn = page.locator(
    'button:has-text("Fermer"), button[aria-label="Close"], button[aria-label="Fermer"]'
  ).first();
  if (await closeBtn.isVisible({ timeout: 1_500 }).catch(() => false)) {
    log("Dismissing login overlay...");
    await closeBtn.click().catch(() => {});
    await page.waitForTimeout(300);
  }
}

// Converts the rendered answer back to markdown, dropping inline citation chips
async function extractAnswer(page: Page): Promise<string> {
  return page.evaluate((selector) => {
    const blocks = document.querySelectorAll(selector);
    const root = blocks[blocks.length - 1];
    if (!root) return "";

    const clone = root.cloneNode(true) as Element;
    clone
      .querySelectorAll(".citation, .citation-nbsp, [data-pplx-citation], button, svg")
      .forEach((el) => el.remove());

    const inline = (el: Node): string =>
      Array.from(el.childNodes).map((n) => toMd(n, 0)).join("");

    function list(el: Element, depth: number): string {
      const ordered = el.tagName === "OL";
      let i = Number(el.getAttribute("start") ?? 1);
      return Array.from(el.children)
        .filter((c) => c.tagName === "LI")
        .map((li) => {
          const bullet = ordered ? `${i++}.` : "-";
          const parts: string[] = [];
          const nested: string[] = [];
          for (const n of Array.from(li.childNodes)) {
            const tag = (n as Element).tagName;
            if (tag === "UL" || tag === "OL") nested.push(list(n as Element, depth + 1));
            else parts.push(toMd(n, depth));
          }
          const text = parts.join("").replace(/\n{2,}/g, "\n").trim();
          return `${"  ".repeat(depth)}${bullet} ${text}\n${nested.join("")}`;
        })
        .join("");
    }

    function table(el: Element): string {
      const rows = Array.from(el.querySelectorAll("tr")).map(
        (tr) => "| " + Array.from(tr.children).map((c) => inline(c).trim().replace(/\|/g, "\\|")).join(" | ") + " |"
      );
      if (rows.length === 0) return "";
      const cols = el.querySelector("tr")?.children.length ?? 1;
      rows.splice(1, 0, "|" + " --- |".repeat(cols));
      return rows.join("\n") + "\n\n";
    }

    function toMd(node: Node, depth: number): string {
      if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? "").replace(/\s+/g, " ");
      if (node.nodeType !== Node.ELEMENT_NODE) return "";
      const el = node as Element;
      // KaTeX renders each formula three times (MathML, TeX annotation, HTML); keep only the TeX
      if (el.classList.contains("katex")) {
        const tex = el.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim() ?? "";
        return el.closest(".katex-display") ? `\n\n$$${tex}$$\n\n` : `$${tex}$`;
      }
      switch (el.tagName) {
        case "H1": case "H2": case "H3": case "H4": case "H5": case "H6":
          return `${"#".repeat(Number(el.tagName[1]))} ${inline(el).trim()}\n\n`;
        case "P": return `${inline(el).trim()}\n\n`;
        case "BR": return "\n";
        case "HR": return "---\n\n";
        case "STRONG": case "B": return `**${inline(el).trim()}**`;
        case "EM": case "I": return `*${inline(el).trim()}*`;
        case "CODE": return `\`${el.textContent ?? ""}\``;
        case "PRE": {
          const lang = (el.querySelector("code")?.className.match(/language-(\S+)/) ?? [])[1] ?? "";
          return `\`\`\`${lang}\n${(el.textContent ?? "").replace(/\n$/, "")}\n\`\`\`\n\n`;
        }
        case "A": {
          const href = el.getAttribute("href") ?? "";
          const text = inline(el).trim();
          return href.startsWith("http") && text ? `[${text}](${href})` : text;
        }
        case "UL": case "OL": return list(el, depth) + "\n";
        case "TABLE": return table(el);
        case "BLOCKQUOTE":
          return inline(el).trim().split("\n").map((l) => `> ${l}`).join("\n") + "\n\n";
        default: return inline(el);
      }
    }

    return toMd(clone, 0)
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }, ANSWER_SELECTOR);
}

// Collects the sources cited in the answer, in order of first citation
async function extractSources(page: Page): Promise<Source[]> {
  return page.evaluate(() => {
    const sources: { title: string; url: string }[] = [];
    const seen = new Set<string>();
    const answer = document.querySelectorAll("[data-workflow-final-text]");
    const scope = answer[answer.length - 1] ?? document;

    scope.querySelectorAll("[data-pplx-citation-url]").forEach((el) => {
      const url = el.getAttribute("data-pplx-citation-url") ?? "";
      if (!url.startsWith("http") || seen.has(url)) return;
      seen.add(url);
      // A citation can hold several labels (e.g. a "Trusted domain" badge); the page title is the longest
      const labels = Array.from(el.querySelectorAll("[aria-label]"))
        .map((l) => l.getAttribute("aria-label") ?? "")
        .filter((l) => !/^trusted domain$/i.test(l));
      const title = labels.sort((a, b) => b.length - a.length)[0] || new URL(url).hostname;
      sources.push({ title, url });
    });

    return sources.slice(0, 15);
  });
}
