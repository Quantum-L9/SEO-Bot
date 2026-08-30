/** Core public contracts for the legacy L9 router. */
export var Provider;
(function (Provider) {
    Provider["OPENROUTER"] = "openrouter";
    Provider["PERPLEXITY"] = "perplexity";
    Provider["OPENAI_DIRECT"] = "openai_direct";
    Provider["ANTHROPIC_DIRECT"] = "anthropic_direct";
})(Provider || (Provider = {}));
export var SonarModel;
(function (SonarModel) {
    SonarModel["SONAR"] = "sonar";
    SonarModel["SONAR_PRO"] = "sonar-pro";
    SonarModel["SONAR_REASONING"] = "sonar-reasoning";
    SonarModel["SONAR_REASONING_PRO"] = "sonar-reasoning-pro";
    SonarModel["SONAR_DEEP_RESEARCH"] = "sonar-deep-research";
})(SonarModel || (SonarModel = {}));
export var GeneralModel;
(function (GeneralModel) {
    GeneralModel["GPT4O_MINI"] = "openai/gpt-4o-mini";
    GeneralModel["GEMINI_FLASH"] = "google/gemini-2.5-flash";
    GeneralModel["CLAUDE_HAIKU"] = "anthropic/claude-haiku-4.5";
    GeneralModel["GPT4O"] = "openai/gpt-4o";
    GeneralModel["CLAUDE_SONNET"] = "anthropic/claude-sonnet-4";
    GeneralModel["GEMINI_PRO"] = "google/gemini-2.5-pro";
    GeneralModel["CLAUDE_OPUS"] = "anthropic/claude-opus-4";
    GeneralModel["O1"] = "openai/o1";
    GeneralModel["O3"] = "openai/o3";
    // These aliases are retained for 1.x source compatibility.
    // eslint-disable-next-line @typescript-eslint/no-duplicate-enum-values
    GeneralModel["GPT4O_VISION"] = "openai/gpt-4o";
    // eslint-disable-next-line @typescript-eslint/no-duplicate-enum-values
    GeneralModel["CLAUDE_SONNET_VISION"] = "anthropic/claude-sonnet-4";
    // eslint-disable-next-line @typescript-eslint/no-duplicate-enum-values
    GeneralModel["GEMINI_FLASH_VISION"] = "google/gemini-2.5-flash";
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
    SearchContextSize["LOW"] = "low";
    SearchContextSize["MEDIUM"] = "medium";
    SearchContextSize["HIGH"] = "high";
})(SearchContextSize || (SearchContextSize = {}));
export var SearchMode;
(function (SearchMode) {
    SearchMode["WEB"] = "web";
    SearchMode["ACADEMIC"] = "academic";
    SearchMode["SEC"] = "sec";
})(SearchMode || (SearchMode = {}));
export var RecencyFilter;
(function (RecencyFilter) {
    RecencyFilter["HOUR"] = "hour";
    RecencyFilter["DAY"] = "day";
    RecencyFilter["WEEK"] = "week";
    RecencyFilter["MONTH"] = "month";
    RecencyFilter["YEAR"] = "year";
    RecencyFilter["NONE"] = "none";
})(RecencyFilter || (RecencyFilter = {}));
export var MessageStrategy;
(function (MessageStrategy) {
    MessageStrategy["SYSTEM_USER"] = "system_user";
    MessageStrategy["SYSTEM_USER_ASSISTANT"] = "system_user_asst";
})(MessageStrategy || (MessageStrategy = {}));
export var TaskComplexity;
(function (TaskComplexity) {
    TaskComplexity["TRIVIAL"] = "trivial";
    TaskComplexity["LOW"] = "low";
    TaskComplexity["MEDIUM"] = "medium";
    TaskComplexity["HIGH"] = "high";
    TaskComplexity["CRITICAL"] = "critical";
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
    TaskType["CLASSIFICATION"] = "classification";
    TaskType["EXTRACTION"] = "extraction";
    TaskType["SCORING"] = "scoring";
    TaskType["CONTENT_GENERATION"] = "content_generation";
    TaskType["STRATEGIC_REASONING"] = "strategic_reasoning";
    TaskType["CODE_GENERATION"] = "code_generation";
    TaskType["COMPETITOR_RESEARCH"] = "competitor_research";
    TaskType["CITATION_CHECK"] = "citation_check";
    TaskType["FACT_VERIFICATION"] = "fact_verification";
    TaskType["MARKET_RESEARCH"] = "market_research";
    TaskType["LINK_PROSPECTING"] = "link_prospecting";
    TaskType["VISUAL_QA"] = "visual_qa";
    TaskType["SCREENSHOT_ANALYSIS"] = "screenshot_analysis";
    TaskType["LAYOUT_VALIDATION"] = "layout_validation";
})(TaskType || (TaskType = {}));
//# sourceMappingURL=types.js.map