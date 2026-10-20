#!/usr/bin/env node
import { FastMCP } from "fastmcp";
import { z } from "zod";
import { ensureAuthenticated } from "./auth.js";
import { ensureBrowser } from "./browser.js";
import { search, SearchResult, DEFAULT_TIMEOUT_MS } from "./search.js";
import { DEFAULT_MODELS, getModels } from "./model.js";

function formatResult(result: SearchResult): string {
  if (!result.answer) return "No answer found. Perplexity may have changed its structure.";
  const sourcesText = result.sources.length > 0
    ? "\n\nSources:\n" + result.sources.map((s, i) => `${i + 1}. [${s.title}](${s.url})`).join("\n")
    : "";
  const note = result.complete ? "" : "\n\n(Note: timed out before Perplexity finished answering; this answer may be incomplete.)";
  const model = result.model ? `\n\nModel: ${result.model}` : "";
  return result.answer + sourcesText + note + model;
}

// --- CLI args ---
const args = process.argv.slice(2);

const timeoutArg = args.find((a) => a.startsWith("--timeout="));
const TIMEOUT_MS = timeoutArg ? parseInt(timeoutArg.split("=")[1], 10) * 1000 : DEFAULT_TIMEOUT_MS;

// --- MCP server ---
const mcp = new FastMCP({
  name: "perplexity-web",
  version: "1.2.0",
});

// Shared by both search tools. No model given → DEFAULT_MODELS in order (first available wins).
const modelParams = {
  model: z
    .string()
    .optional()
    .describe(
      `Perplexity model to answer with, by name as shown in Perplexity's model picker (e.g. "GPT-6.1 Sol", "Claude Sonnet 5.5", "Gemini 3.8 Flash"; partial names like "sonnet" work). ` +
      `Defaults to ${DEFAULT_MODELS.join(", falling back to ")}. Call list_models to see what is available.`
    ),
  thinking: z
    .boolean()
    .optional()
    .describe("Turn the model's Thinking (reasoning) mode on or off, for models that have the switch. Defaults to true."),
};

const resolveModels = (model?: string) => (model ? [model] : DEFAULT_MODELS);

mcp.addTool({
  name: "search",
  description:
    "Search the web using Perplexity.ai and get an AI-synthesized answer with cited sources. Uses Perplexity's current source settings.",
  parameters: z.object({
    query: z.string().describe("The search query"),
    ...modelParams,
  }),
  execute: async ({ query, model, thinking }) => {
    await ensureBrowser();
    const result = await search(query, { timeoutMs: TIMEOUT_MS, models: resolveModels(model), thinking });
    return formatResult(result);
  },
});

mcp.addTool({
  name: "search_advanced",
  description:
    "Search Perplexity.ai with specific source selection. Lets you combine multiple sources (e.g. web + academic). Use this when source control matters; prefer `search` for general queries.",
  parameters: z.object({
    query: z.string().describe("The search query"),
    sources: z
      .array(z.enum(["web", "academic", "social"]))
      .min(1)
      .describe("Sources to search: 'web' (general web), 'academic' (scholarly articles), 'social' (Reddit & forums; may not be offered on every account). Can combine multiple."),
    ...modelParams,
  }),
  execute: async ({ query, sources, model, thinking }) => {
    await ensureBrowser();
    const result = await search(query, { timeoutMs: TIMEOUT_MS, sources, models: resolveModels(model), thinking });
    return formatResult(result);
  },
});

mcp.addTool({
  name: "list_models",
  description: "List the models in Perplexity's model picker, showing which this account can use and which is selected.",
  parameters: z.object({}),
  execute: async () => {
    await ensureBrowser();
    const models = await getModels();
    return models
      .map((m) => `- ${m.name}${m.selected ? " (selected)" : ""}${m.available ? "" : " (not on your plan)"}`)
      .join("\n");
  },
});

mcp.addTool({
  name: "login",
  description:
    "Check if you are authenticated on Perplexity.ai. If not, opens a browser window so you can log in.",
  parameters: z.object({}),
  execute: async () => {
    if (await ensureAuthenticated()) {
      return "Already authenticated on Perplexity.ai.";
    }
    return "Login successful. You are now authenticated on Perplexity.ai.";
  },
});

// --- Startup ---
async function main() {
  console.error(`[perplexity-web-mcp] Starting (timeout=${TIMEOUT_MS}ms)...`);
  console.error("[perplexity-web-mcp] Ready. Browser will launch on first tool call.");
  mcp.start({ transportType: "stdio" });
}

main().catch((err) => {
  console.error("[perplexity-web-mcp] Fatal error:", err);
  process.exit(1);
});
