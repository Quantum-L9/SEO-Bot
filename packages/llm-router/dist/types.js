/** Core public contracts for the legacy L9 router. */
export var Provider;
(function (Provider) {
    Provider["ANTHROPIC_DIRECT"] = "anthropic_direct";
    Provider["OPENAI_DIRECT"] = "openai_direct";
    Provider["OPENROUTER"] = "openrouter";
    Provider["PERPLEXITY"] = "perplexity";
})(Provider || (Provider = {}));
export var SonarModel;
(function (SonarModel) {
    SonarModel["SONAR"] = "sonar";
    SonarModel["SONAR_DEEP_RESEARCH"] = "sonar-deep-research";
    SonarModel["SONAR_PRO"] = "sonar-pro";
    SonarModel["SONAR_REASONING"] = "sonar-reasoning";
    SonarModel["SONAR_REASONING_PRO"] = "sonar-reasoning-pro";
})(SonarModel || (SonarModel = {}));
/**
 * The canonical table of OpenRouter model ids: each value is the id sent on the wire.
 * The `*_VISION` members are aliases retained for 1.x source compatibility.
 */
export var GeneralModel;
(function (GeneralModel) {
    GeneralModel["CLAUDE_HAIKU"] = "anthropic/claude-haiku-4.5";
    GeneralModel["CLAUDE_OPUS"] = "anthropic/claude-opus-4.6";
    GeneralModel["CLAUDE_SONNET"] = "anthropic/claude-sonnet-4.6";
    // eslint-disable-next-line @typescript-eslint/no-duplicate-enum-values
    GeneralModel["CLAUDE_SONNET_VISION"] = "anthropic/claude-sonnet-4.6";
    GeneralModel["GEMINI_FLASH"] = "google/gemini-2.5-flash";
    // eslint-disable-next-line @typescript-eslint/no-duplicate-enum-values
    GeneralModel["GEMINI_FLASH_VISION"] = "google/gemini-2.5-flash";
    GeneralModel["GEMINI_PRO"] = "google/gemini-2.5-pro";
    GeneralModel["GPT4O"] = "openai/gpt-4o";
    GeneralModel["GPT4O_MINI"] = "openai/gpt-4o-mini";
    // eslint-disable-next-line @typescript-eslint/no-duplicate-enum-values
    GeneralModel["GPT4O_VISION"] = "openai/gpt-4o";
    GeneralModel["O1"] = "openai/o1";
    GeneralModel["O3"] = "openai/o3";
})(GeneralModel || (GeneralModel = {}));
/**
 * Why a routing decision required (or did not require) a search provider.
 *
 * EXPLICIT     — the caller set `TaskDescriptor.requiresSearch` to a boolean.
 * TASK_DEFAULT — the caller left it undefined, so the `TaskType` default applied.
 */
export var SearchPolicySource;
(function (SearchPolicySource) {
    SearchPolicySource["EXPLICIT"] = "explicit";
    SearchPolicySource["TASK_DEFAULT"] = "task_default";
})(SearchPolicySource || (SearchPolicySource = {}));
export var SearchContextSize;
(function (SearchContextSize) {
    SearchContextSize["HIGH"] = "high";
    SearchContextSize["LOW"] = "low";
    SearchContextSize["MEDIUM"] = "medium";
})(SearchContextSize || (SearchContextSize = {}));
export var SearchMode;
(function (SearchMode) {
    SearchMode["ACADEMIC"] = "academic";
    SearchMode["SEC"] = "sec";
    SearchMode["WEB"] = "web";
})(SearchMode || (SearchMode = {}));
export var RecencyFilter;
(function (RecencyFilter) {
    RecencyFilter["DAY"] = "day";
    RecencyFilter["HOUR"] = "hour";
    RecencyFilter["MONTH"] = "month";
    RecencyFilter["NONE"] = "none";
    RecencyFilter["WEEK"] = "week";
    RecencyFilter["YEAR"] = "year";
})(RecencyFilter || (RecencyFilter = {}));
export var MessageStrategy;
(function (MessageStrategy) {
    MessageStrategy["SYSTEM_USER"] = "system_user";
    MessageStrategy["SYSTEM_USER_ASSISTANT"] = "system_user_asst";
})(MessageStrategy || (MessageStrategy = {}));
export var TaskComplexity;
(function (TaskComplexity) {
    TaskComplexity["CRITICAL"] = "critical";
    TaskComplexity["HIGH"] = "high";
    TaskComplexity["LOW"] = "low";
    TaskComplexity["MEDIUM"] = "medium";
    TaskComplexity["TRIVIAL"] = "trivial";
})(TaskComplexity || (TaskComplexity = {}));
export const TASK_COMPLEXITY_RANK = Object.freeze({
    [TaskComplexity.TRIVIAL]: 0,
    [TaskComplexity.LOW]: 1,
    [TaskComplexity.MEDIUM]: 2,
    [TaskComplexity.HIGH]: 3,
    [TaskComplexity.CRITICAL]: 4,
});
export function complexityRank(value) {
    return TASK_COMPLEXITY_RANK[value];
}
export var TaskType;
(function (TaskType) {
    TaskType["CITATION_CHECK"] = "citation_check";
    TaskType["CLASSIFICATION"] = "classification";
    TaskType["CODE_GENERATION"] = "code_generation";
    TaskType["COMPETITOR_RESEARCH"] = "competitor_research";
    TaskType["CONTENT_GENERATION"] = "content_generation";
    TaskType["EXTRACTION"] = "extraction";
    TaskType["FACT_VERIFICATION"] = "fact_verification";
    TaskType["LAYOUT_VALIDATION"] = "layout_validation";
    TaskType["LINK_PROSPECTING"] = "link_prospecting";
    TaskType["MARKET_RESEARCH"] = "market_research";
    TaskType["SCORING"] = "scoring";
    TaskType["SCREENSHOT_ANALYSIS"] = "screenshot_analysis";
    TaskType["STRATEGIC_REASONING"] = "strategic_reasoning";
    TaskType["VISUAL_QA"] = "visual_qa";
})(TaskType || (TaskType = {}));
//# sourceMappingURL=types.js.map