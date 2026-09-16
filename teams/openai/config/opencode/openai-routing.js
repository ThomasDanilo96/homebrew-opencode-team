import { dailyFanout } from "../../../daily/daily-policy.mjs";

const REPOSITORY_MUTATING_TOOLS = new Set([
  "apply_patch", "edit", "write", "delete", "rename", "file_create", "file_delete", "file_rename",
  "create_file", "remove_file", "move_file", "multi_edit", "write_file", "patch",
]);
const READ_ONLY_AGENTS = new Set(["openai_explore", "openai_librarian", "specialist", "reviewer", "reviewer_critical", "tester"]);
const MUTATING_ACTION = /\b(?:add(?!\s*\()|create|modify|change|implement|refactor|migrat(?:e|ion)?|patch|delete|rename|update|deploy)\b|\bfix(?:es|ed|ing)?\s+(?!(?:already|existing|applied)\b)|\bwrite\s+(?:code|file|files|script|tests?|implementation|changes?)\b|\b(?:apply|make)\s+(?:the\s+)?(?:changes?|fix(?:es)?|patch(?:es)?)\b/i;
const NEGATED_MUTATION = /\b(?:do\s+not|don['’]t|must\s+not|never)\s+(?:(?:ever|also|actually|just)\s+)*(?:add(?!\s*\()|create|modify|change|implement|refactor|migrat(?:e|ion)?|patch|delete|rename|update|deploy|fix(?:es|ed|ing)?|write\s+(?:code|file|files|script|tests?|implementation|changes?)|(?:apply|make)\s+(?:the\s+)?(?:changes?|fix(?:es)?|patch(?:es)?))(?:\s+(?:or|and)\s+(?:add(?!\s*\()|create|modify|change|implement|refactor|migrat(?:e|ion)?|patch|delete|rename|update|deploy|fix(?:es|ed|ing)?|write\s+(?:code|file|files|script|tests?|implementation|changes?)|(?:apply|make)\s+(?:the\s+)?(?:changes?|fix(?:es)?|patch(?:es)?)))*\b/gi;
const READ_ONLY_ACTION = /\b(?:analy[sz]e|inspect|audit|research|compare|review|map|understand|report|profile|investigate|find|read|propose|document|test|verify)\b/i;
const REMOTE_CONTEXT = /\b(?:ssh|remote|server|vps|docker(?:\s+(?:ps|inspect|logs|images|stats|info)|\s+containers?)?|systemctl|journalctl|remote\s+logs?|host\s+diagnostics?|deployment\s+state)\b/i;
const REMOTE_MUTATION = /\b(?:restart|start|stop|reload|enable|disable|exec|run|kill|rm|pull|push|checkout|switch|reset|clean|commit|merge|rebase|deploy|delete|remove|change|modify)\b/i;
const REPOSITORY_CONTEXT = /\b(?:repository|repo|code|file|module|test|implementation|database|schema|dependency)\b/i;
const QUOTED_TERM = /(?:`[^`]*`|'[^']*'|"[^"]*")/g;
const HISTORY = /\b(?:already\s+(?:applied|fixed|implemented)|after\b.*\bfix(?:ed)?\b|history|provenance|resume)\b/i;
const PROPOSAL = /\b(?:propos(?:e|ing)|proposed)\s+(?:a\s+)?(?:fix|change|patch)/i;
const LIBRARY = /\b(?:library|api|documentation|docs?|external)\b/i;
const ARCHITECTURE = /\b(?:architecture|architectural|boundar(?:y|ies)|design)\b/i;
const AUDIT = /\b(?:security|correctness|audit)\b/i;
const AUDIT_OR_REVIEW = /\b(?:audit|review)\b/i;
const CRITICAL_AUDIT_OR_REVIEW = /\b(?:critical\s+security|security\s+critical|release|deploy(?:ment)?|data\s+(?:delet(?:e|ion)|removal)|delete\s+(?:production\s+)?data)\b/i;
const EXPLICIT_REVIEW = /\b(?:audit|correctness|security\s+review|architecture\s+review|critical\s+review|review(?!\s+architecture))\b/i;
const STRONG_MUTATION = /\b(?:create|modify|change|implement|refactor|migrat(?:e|ion)?|patch|delete|rename|update|deploy)\b|\bwrite\s+(?:code|file|files|script|implementation|changes?)\b/i;
const HIGH_RISK = /\b(?:security|auth(?:entication|orization)?|schema|data\s+(?:delet(?:e|ion)|removal)|delete\s+(?:production\s+)?data|shared\s+runtime|concurren(?:cy|t)|cleanup|deploy(?:ment)?)\b/i;

const unquoted = (text) => text.replace(QUOTED_TERM, " ");
const withoutNegatedMutations = (text) => text.replace(NEGATED_MUTATION, " ");
const complexityFor = (text) => /\b(?:multi[- ]service|rollback|cross[- ](?:service|repository)|end[- ]to[- ]end)\b/i.test(text) ? "EXTREME"
  : /\b(?:shared\s+runtime|concurren(?:cy|t)|cleanup|multi(?:ple)?\s+(?:module|service))\b/i.test(text) ? "HEAVY"
  : /\b(?:refactor|migration|schema|architecture|external\s+documentation|security|correctness|audit)\b/i.test(text) ? "COMPLEX"
  : /\b(?:one\s+)?(?:typo|rename)\b/i.test(text) || /^test\b/i.test(text) ? "TRIVIAL" : "NORMAL";

export const analyzeObjective = (objective) => {
  const text = String(objective || "").trim();
  const plain = unquoted(text);
  const mutationPlain = withoutNegatedMutations(plain);
  const clauses = text.split(/(?:\s*(?:;|\.|\bthen\b)\s*)+/i).filter(Boolean).map((clause) => {
    const clauseText = clause.trim();
    const clausePlain = unquoted(clauseText);
    const mutationClausePlain = withoutNegatedMutations(clausePlain);
    return {
      text: clauseText,
      // History/proposal language may qualify a request, but never neutralizes an
      // unquoted mutation verb in that same clause.
      intent: MUTATING_ACTION.test(mutationClausePlain) && !PROPOSAL.test(clausePlain) ? "MUTATING" : READ_ONLY_ACTION.test(clausePlain) ? "READ_ONLY" : "AMBIGUOUS",
      remote: REMOTE_CONTEXT.test(clausePlain),
    };
  });
  const remote = REMOTE_CONTEXT.test(plain);
  const repository = REPOSITORY_CONTEXT.test(plain);
  const hasMutatingClause = clauses.some(({ intent }) => intent === "MUTATING");
  const hasLocalMutatingClause = clauses.some(({ intent, remote: clauseRemote }) => intent === "MUTATING" && !clauseRemote);
  const hasRemoteMutationClause = clauses.some(({ text: clause, remote: clauseRemote }) => clauseRemote && REMOTE_MUTATION.test(withoutNegatedMutations(unquoted(clause))));
  const explicitReview = /^(?:\s*)(?:audit|review(?!\s+architecture)|correctness|security\s+review|architecture\s+review|critical\s+review)\b/i.test(plain) && !PROPOSAL.test(text) && !HISTORY.test(text);
  const reviewOnly = explicitReview && !STRONG_MUTATION.test(withoutNegatedMutations(plain));
  const classification = reviewOnly ? "READ_ONLY" : hasRemoteMutationClause && !repository && !hasLocalMutatingClause ? "REMOTE_MUTATION"
    : hasMutatingClause ? "MUTATING"
    : remote ? "REMOTE_READ_ONLY" : READ_ONLY_ACTION.test(mutationPlain) || mutationPlain !== plain ? "READ_ONLY" : "AMBIGUOUS";
  const complexity = complexityFor(plain);
  const risk = HIGH_RISK.test(plain) ? (/\b(?:schema|data\s+(?:delet(?:e|ion)|removal)|delete\s+(?:production\s+)?data|shared\s+runtime|concurren(?:cy|t)|cleanup|deploy(?:ment)?|multi[- ]service)\b/i.test(plain) ? "critical" : "high") : "low";
  const tester = /\b(?:test|verify)\b/i.test(plain) && (HISTORY.test(text) || /\b(?:session|fix)\b/i.test(plain));
  const criticalAuditOrReview = AUDIT_OR_REVIEW.test(plain) && CRITICAL_AUDIT_OR_REVIEW.test(plain);
  const agent = classification === "MUTATING" ? "codex_executor" : classification === "REMOTE_MUTATION" ? null : classification === "REMOTE_READ_ONLY" ? "openai_ops"
    : criticalAuditOrReview ? "reviewer_critical" : explicitReview || AUDIT.test(plain) ? "reviewer" : tester ? "tester" : ARCHITECTURE.test(plain) ? "specialist" : REPOSITORY_CONTEXT.test(plain) && LIBRARY.test(plain) ? "openai_explore" : LIBRARY.test(plain) ? "openai_librarian" : classification === "READ_ONLY" ? "openai_explore" : "specialist";
  const discovery_agents = classification === "READ_ONLY" && repository && LIBRARY.test(plain) ? [...new Set([agent, "openai_librarian"])] : [];
  const intent_evidence = [...clauses.map(({ intent }, index) => `clause-${index + 1}:${intent.toLowerCase()}`), ...(repository ? ["scope:repository"] : []), ...(remote ? ["scope:remote"] : []), ...(LIBRARY.test(plain) ? ["scope:external-docs"] : []), ...(HIGH_RISK.test(plain) ? ["scope:high-risk"] : [])].slice(0, 8);
  const codex_profile = classification !== "MUTATING" ? null : complexity === "TRIVIAL" ? "quick" : risk === "critical" || ["COMPLEX", "HEAVY", "EXTREME"].includes(complexity) ? "complex" : "standard";
  return { classification, clauses, agent, complexity, fanout_limit: dailyFanout(complexity), reasoning_effort: complexity === "EXTREME" ? "high" : complexity === "HEAVY" ? "medium" : "low", risk, review_required: classification === "MUTATING" && (risk === "high" || risk === "critical"), codex_profile, discovery_agents, intent_evidence };
};

export const classifyObjective = (objective) => analyzeObjective(objective).classification;

export const routeObjective = (objective, requestedAgent = "", hasCategory = false) => {
  const analysis = analyzeObjective(objective);
  if (analysis.classification === "AMBIGUOUS" && READ_ONLY_AGENTS.has(requestedAgent)) return { classification: analysis.classification, agent: requestedAgent };
  if (analysis.classification === "AMBIGUOUS" && hasCategory) return { classification: analysis.classification, agent: null };
  return { classification: analysis.classification, agent: analysis.agent };
};

export const selectAuthoritativeObjective = (currentObjective, fallbackObjective = "") =>
  String(currentObjective || "").trim() || String(fallbackObjective || "").trim();

export const routeDelegatedAgent = (parentObjective, childObjective, requestedAgent = "") => {
  const analysis = analyzeObjective(childObjective);
  if (analysis.classification === "MUTATING" || analysis.classification === "REMOTE_MUTATION") {
    return { classification: analysis.classification, agent: analysis.agent };
  }
  if (analysis.classification === "REMOTE_READ_ONLY") {
    return { classification: analysis.classification, agent: analysis.agent };
  }
  if (requestedAgent === "reviewer" || requestedAgent === "reviewer_critical") {
    return { classification: analysis.classification, agent: requestedAgent };
  }
  const parentRequestsReview = EXPLICIT_REVIEW.test(String(parentObjective || ""));
  if (parentRequestsReview && analysis.classification === "READ_ONLY") {
    const parentIsCriticalReview = CRITICAL_AUDIT_OR_REVIEW.test(String(parentObjective || ""));
    return { classification: analysis.classification, agent: parentIsCriticalReview ? "reviewer_critical" : "reviewer" };
  }
  if (READ_ONLY_AGENTS.has(requestedAgent)) {
    return { classification: analysis.classification, agent: requestedAgent };
  }
  return routeObjective(childObjective, requestedAgent);
};

export { READ_ONLY_AGENTS, REPOSITORY_MUTATING_TOOLS };
