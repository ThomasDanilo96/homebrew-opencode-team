const { canMutate } = require("./authorship.js");

if (!canMutate("codex_executor") || canMutate("openai_orchestrator")) throw new Error("authorship fixture failed");
