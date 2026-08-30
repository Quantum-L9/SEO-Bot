import { TaskComplexity, TaskType, type VisionConfig } from '../types.js';
export interface ViewportConfig {
    name: string;
    width: number;
    height: number;
    deviceScaleFactor: number;
    isMobile: boolean;
    userAgent?: string;
}
export interface VisualQATask {
    prompt: string;
    images: string[];
    viewport: ViewportConfig;
    config: VisionConfig;
}
export interface FullSiteQAConfig {
    pages: string[];
    viewports: ViewportConfig[];
    competitorUrl?: string;
    conversionAudit: boolean;
}
export declare const VIEWPORTS: Record<string, ViewportConfig>;
export declare const VISUAL_QA_PROMPTS: Readonly<{
    layout_validation: "Review the screenshot for alignment, overlap, spacing, readability, broken images, CTA visibility, navigation, responsiveness, professionalism, and brand consistency. Return JSON.";
    competitor_comparison: "Compare our screenshot with the competitor for professionalism, CTA clarity, trust, readability, responsiveness, and first impression. Return JSON.";
    conversion_audit: "Audit the screenshot for value proposition, above-fold CTA, trust, form friction, social proof, urgency, navigation, and distraction. Return JSON.";
}>;
export declare function resolveVisionConfig(taskType: TaskType.VISUAL_QA | TaskType.SCREENSHOT_ANALYSIS | TaskType.LAYOUT_VALIDATION, complexity: TaskComplexity, imageCount?: number): VisionConfig;
export declare function buildLayoutValidationTask(screenshotUrl: string, viewport: ViewportConfig, complexity?: TaskComplexity): VisualQATask;
export declare function buildCompetitorComparisonTask(ours: string, competitor: string, viewport: ViewportConfig): VisualQATask;
export declare function buildConversionAuditTask(screenshotUrl: string, viewport: ViewportConfig): VisualQATask;
export declare function generateFullSiteQAPlan(config: FullSiteQAConfig): VisualQATask[];
//# sourceMappingURL=index.d.ts.map