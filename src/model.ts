import type { Page } from "playwright";
import { newSearchPage } from "./browser.js";

const PERPLEXITY_HOME = "https://www.perplexity.ai/";

// Used when a tool call doesn't name a model: the first one available on the account wins
export const DEFAULT_MODELS = ["GPT-6.1 Sol", "Claude Sonnet 5.5"];

// The composer's model picker shows the current model's brand icon, a CPU icon for "Best", or
// just a chevron (narrow layouts, or while loading). It comes after the sidebar's menus, so take the last match.
const PICKER_SELECTOR = ["#pplx-icon-chevron-down", "#pplx-icon-cpu"]
  .map((icon) => `button[aria-haspopup="menu"]:has(use[*|href="${icon}"])`)
  .concat('button[aria-haspopup="menu"]:has(use[*|href^="#pplx-icon-custom-brand-"])')
  .join(", ");
const LOCK_ICON = "#pplx-icon-lock";

export interface ModelInfo {
  name: string;
  available: boolean;
  selected: boolean;
}

const log = (msg: string) => console.error(`[perplexity-web-mcp] ${msg}`);

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9.]+/g, " ").trim();

async function openPicker(page: Page): Promise<void> {
  await page.locator(PICKER_SELECTOR).last().click();
  await page.locator('[role="menu"] [role="menuitemradio"]').first().waitFor({ state: "visible", timeout: 5_000 });
}

async function closeMenus(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
}

// Reads every row of the open picker. Locked (higher-tier) models are plain menuitems with a lock icon.
async function readModels(page: Page): Promise<ModelInfo[]> {
  return page.evaluate((lockIcon) => {
    const menu = document.querySelector('[role="menu"]');
    if (!menu) return [];
    return Array.from(menu.querySelectorAll('[role="menuitemradio"], [role="menuitem"]')).map((item) => {
      const name =
        item.querySelector('[translate="no"]')?.textContent?.trim() ??
        (item as HTMLElement).innerText.split("\n")[0].trim();
      const locked = Array.from(item.querySelectorAll("use")).some(
        (u) => (u.getAttribute("xlink:href") ?? u.getAttribute("href")) === lockIcon
      );
      return {
        name,
        available: item.getAttribute("role") === "menuitemradio" && !locked,
        selected: item.getAttribute("aria-checked") === "true",
      };
    });
  }, LOCK_ICON);
}

// Opens a fresh Perplexity tab and reads the model picker
export async function getModels(): Promise<ModelInfo[]> {
  const page = await newSearchPage();
  try {
    await page.goto(PERPLEXITY_HOME, { waitUntil: "domcontentloaded" });
    await page.locator(PICKER_SELECTOR).last().waitFor({ state: "visible", timeout: 15_000 });
    await openPicker(page);
    return await readModels(page);
  } finally {
    await page.close();
  }
}

// Picks the first model in `candidates` that the account can use (matched by name, case-insensitively,
// exact match preferred) and sets its Thinking switch. Returns the picker's resulting label, e.g.
// "Claude Sonnet 5.5 Thinking". The choice is kept in this browser profile, not on the account.
export async function selectModel(page: Page, candidates: string[], thinking: boolean): Promise<string> {
  const picker = page.locator(PICKER_SELECTOR).last();
  await picker.waitFor({ state: "visible", timeout: 10_000 });
  const pickerLabel = async () => ((await picker.getAttribute("aria-label")) ?? "").trim();

  // The label is the model name plus " Thinking" when thinking is on; skip the menu if it already matches
  const first = normalize(candidates[0]);
  if (normalize(await pickerLabel()) === (thinking ? `${first} thinking` : first)) return pickerLabel();

  await openPicker(page);
  let chosen: ModelInfo | undefined;
  try {
    const usable = (await readModels(page)).filter((m) => m.available);
    let index = 0;
    for (; index < candidates.length; index++) {
      const wanted = normalize(candidates[index]);
      chosen =
        usable.find((m) => normalize(m.name) === wanted) ??
        usable.find((m) => normalize(m.name).includes(wanted));
      if (chosen) break;
    }
    if (!chosen) {
      throw new Error(
        `Model not available: ${candidates.join(" / ")}. ` +
        `Available: ${usable.map((m) => m.name).join(", ")}`
      );
    }
    if (index > 0) log(`"${candidates[0]}" unavailable, falling back to "${chosen.name}".`);

    const row = page.locator('[role="menu"] [role="menuitemradio"]').filter({
      has: page.locator('[translate="no"]', { hasText: chosen.name }),
    }).first();

    // Hovering a row opens its submenu, which holds the Thinking switch for models that have one
    await row.hover();
    const toggle = page.locator('[role="menu"] [role="menuitemcheckbox"]').first();
    const hasToggle = await toggle.waitFor({ state: "visible", timeout: 1_500 }).then(() => true, () => false);
    if (hasToggle) {
      if ((await toggle.getAttribute("aria-checked") === "true") !== thinking) {
        await toggle.click();
        await page.waitForTimeout(300);
      }
    } else if (thinking) {
      log(`"${chosen.name}" has no Thinking switch; using it as is.`);
    }

    // Toggling may close the menu; reopen it before selecting the row
    if (!(await row.isVisible())) await openPicker(page);
    if (await row.getAttribute("aria-checked") !== "true") await row.click();
  } finally {
    await closeMenus(page);
  }

  // Confirm the switch took effect rather than reporting a model that wasn't used
  const label = await pickerLabel();
  if (!normalize(label).startsWith(normalize(chosen.name))) {
    throw new Error(`Tried to select "${chosen.name}", but Perplexity's model picker shows "${label}".`);
  }
  log(`Model: ${label}`);
  return label;
}
