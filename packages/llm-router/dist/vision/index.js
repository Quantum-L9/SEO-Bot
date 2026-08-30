import { GeneralModel, Provider, TaskComplexity, TaskType, complexityRank, } from '../types.js';
export const VIEWPORTS = Object.freeze({
    desktop_1920: { name: 'Desktop 1920x1080', width: 1920, height: 1080, deviceScaleFactor: 1, isMobile: false },
    desktop_1440: { name: 'Desktop 1440x900', width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false },
    tablet_ipad: { name: 'iPad 768x1024', width: 768, height: 1024, deviceScaleFactor: 2, isMobile: true },
    mobile_iphone: { name: 'iPhone 393x852', width: 393, height: 852, deviceScaleFactor: 3, isMobile: true },
    mobile_android: { name: 'Pixel 412x915', width: 412, height: 915, deviceScaleFactor: 2.625, isMobile: true },
});
export const VISUAL_QA_PROMPTS = Object.freeze({
    layout_validation: 'Review the screenshot for alignment, overlap, spacing, readability, broken images, CTA visibility, navigation, responsiveness, professionalism, and brand consistency. Return JSON.',
    competitor_comparison: 'Compare our screenshot with the competitor for professionalism, CTA clarity, trust, readability, responsiveness, and first impression. Return JSON.',
    conversion_audit: 'Audit the screenshot for value proposition, above-fold CTA, trust, form friction, social proof, urgency, navigation, and distraction. Return JSON.',
});
export function resolveVisionConfig(taskType, complexity, imageCount = 1) {
    if (complexityRank(complexity) <= complexityRank(TaskComplexity.LOW) && imageCount === 1) {
        return { model: GeneralModel.GEMINI_FLASH_VISION, provider: Provider.OPENROUTER, maxTokens: 1024, detail: 'low', estimatedCostPerCall: 0.001, resolutionReason: 'Quick visual check' };
    }
    if (imageCount > 1)
        return { model: GeneralModel.CLAUDE_SONNET_VISION, provider: Provider.OPENROUTER, maxTokens: 2048, detail: 'high', estimatedCostPerCall: 0.03, resolutionReason: 'Multi-image comparison' };
    if (taskType === TaskType.LAYOUT_VALIDATION || complexityRank(complexity) >= complexityRank(TaskComplexity.HIGH))
        return { model: GeneralModel.GPT4O_VISION, provider: Provider.OPENROUTER, maxTokens: 2048, detail: 'high', estimatedCostPerCall: 0.02, resolutionReason: 'Detailed layout analysis' };
    return { model: GeneralModel.GPT4O_VISION, provider: Provider.OPENROUTER, maxTokens: 1536, detail: 'auto', estimatedCostPerCall: 0.015, resolutionReason: 'Standard visual analysis' };
}
export function buildLayoutValidationTask(screenshotUrl, viewport, complexity = TaskComplexity.MEDIUM) {
    return { prompt: VISUAL_QA_PROMPTS.layout_validation, images: [screenshotUrl], viewport, config: resolveVisionConfig(TaskType.LAYOUT_VALIDATION, complexity, 1) };
}
export function buildCompetitorComparisonTask(ours, competitor, viewport) {
    return { prompt: VISUAL_QA_PROMPTS.competitor_comparison, images: [ours, competitor], viewport, config: resolveVisionConfig(TaskType.SCREENSHOT_ANALYSIS, TaskComplexity.HIGH, 2) };
}
export function buildConversionAuditTask(screenshotUrl, viewport) {
    return { prompt: VISUAL_QA_PROMPTS.conversion_audit, images: [screenshotUrl], viewport, config: resolveVisionConfig(TaskType.VISUAL_QA, TaskComplexity.MEDIUM, 1) };
}
export function generateFullSiteQAPlan(config) {
    const tasks = [];
    for (const page of config.pages)
        for (const viewport of config.viewports)
            tasks.push(buildLayoutValidationTask(page, viewport));
    if (config.competitorUrl)
        for (const page of config.pages.slice(0, 3))
            tasks.push(buildCompetitorComparisonTask(page, config.competitorUrl, VIEWPORTS.desktop_1440));
    if (config.conversionAudit)
        for (const page of config.pages.slice(0, 2))
            tasks.push(buildConversionAuditTask(page, VIEWPORTS.mobile_iphone));
    return tasks;
}
//# sourceMappingURL=index.js.map