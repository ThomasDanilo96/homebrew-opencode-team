import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dependencyRoot = process.env.OPENAI_DEPENDENCY_ROOT;
if (!dependencyRoot) {
  throw new Error("OPENAI_DEPENDENCY_ROOT is required to load @opencode-ai/plugin");
}

const packageRoot = join(dependencyRoot, "node_modules", "@opencode-ai", "plugin");
const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const entry = packageJson.exports?.["."]?.import;
if (typeof entry !== "string") {
  throw new Error("@opencode-ai/plugin import entry is missing");
}

const plugin = await import(pathToFileURL(join(packageRoot, entry)).href);
const { Effect } = await import(pathToFileURL(join(dependencyRoot, "node_modules", "effect", "dist", "index.js")).href);
export const tool = plugin.tool;
export const runHostEffect = (value) => value && typeof value === "object" ? Effect.runPromise(value) : Promise.resolve(value);
