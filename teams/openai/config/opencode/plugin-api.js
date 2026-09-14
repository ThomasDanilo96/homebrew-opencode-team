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
export const tool = plugin.tool;
