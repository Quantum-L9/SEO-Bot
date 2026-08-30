import { z } from 'zod';
export declare const ProviderIdSchema: z.ZodEnum<{
    openrouter: "openrouter";
    perplexity: "perplexity";
    openai: "openai";
    anthropic: "anthropic";
    mistral: "mistral";
    gemini: "gemini";
    deepseek: "deepseek";
}>;
export declare const TaskFamilySchema: z.ZodEnum<{
    classification: "classification";
    extraction: "extraction";
    scoring: "scoring";
    code_generation: "code_generation";
    fact_verification: "fact_verification";
    proposal_generation: "proposal_generation";
    friction_analysis: "friction_analysis";
    architecture_review: "architecture_review";
    contract_generation: "contract_generation";
    contract_hardening: "contract_hardening";
    evidence_synthesis: "evidence_synthesis";
    signal_generation: "signal_generation";
    adr_generation: "adr_generation";
    risk_assessment: "risk_assessment";
    validation_interpretation: "validation_interpretation";
    memory_episode_summarization: "memory_episode_summarization";
    graph_fact_extraction: "graph_fact_extraction";
    promotion_recommendation: "promotion_recommendation";
    deep_research: "deep_research";
    vision_analysis: "vision_analysis";
}>;
export declare const TaskComplexityLevelSchema: z.ZodEnum<{
    low: "low";
    medium: "medium";
    high: "high";
    trivial: "trivial";
    critical: "critical";
}>;
export declare const DataSensitivitySchema: z.ZodEnum<{
    public: "public";
    internal: "internal";
    confidential: "confidential";
    restricted: "restricted";
}>;
export declare const FreshnessRequirementSchema: z.ZodEnum<{
    hour: "hour";
    day: "day";
    week: "week";
    month: "month";
    year: "year";
    none: "none";
}>;
export declare const ModalitySchema: z.ZodEnum<{
    text: "text";
    vision: "vision";
    multimodal: "multimodal";
}>;
export declare const LatencyClassSchema: z.ZodEnum<{
    fast: "fast";
    realtime: "realtime";
    normal: "normal";
    slow: "slow";
}>;
export declare const ValidationProfileSchema: z.ZodEnum<{
    code: "code";
    strict_json: "strict_json";
    cited_answer: "cited_answer";
    freeform: "freeform";
    visual: "visual";
}>;
export declare const ReasoningDepthSchema: z.ZodEnum<{
    low: "low";
    medium: "medium";
    high: "high";
    none: "none";
}>;
export declare const ResponseFormatSchema: z.ZodEnum<{
    json: "json";
    text: "text";
}>;
export declare const SearchModeSchema: z.ZodEnum<{
    web: "web";
    academic: "academic";
    sec: "sec";
}>;
export declare const SearchContextSizeSchema: z.ZodEnum<{
    low: "low";
    medium: "medium";
    high: "high";
}>;
export declare const RecencyFilterSchema: z.ZodEnum<{
    hour: "hour";
    day: "day";
    week: "week";
    month: "month";
    year: "year";
    none: "none";
}>;
export declare const ReasoningEffortSchema: z.ZodEnum<{
    low: "low";
    medium: "medium";
    high: "high";
}>;
export declare const TASK_PROFILE_SCHEMA_VERSION: "l9-llm-task-profile/v1";
export declare const TaskProfileSchema: z.ZodObject<{
    schema_version: z.ZodLiteral<"l9-llm-task-profile/v1">;
    action: z.ZodString;
    node_id: z.ZodString;
    tenant_id: z.ZodString;
    task_family: z.ZodEnum<{
        classification: "classification";
        extraction: "extraction";
        scoring: "scoring";
        code_generation: "code_generation";
        fact_verification: "fact_verification";
        proposal_generation: "proposal_generation";
        friction_analysis: "friction_analysis";
        architecture_review: "architecture_review";
        contract_generation: "contract_generation";
        contract_hardening: "contract_hardening";
        evidence_synthesis: "evidence_synthesis";
        signal_generation: "signal_generation";
        adr_generation: "adr_generation";
        risk_assessment: "risk_assessment";
        validation_interpretation: "validation_interpretation";
        memory_episode_summarization: "memory_episode_summarization";
        graph_fact_extraction: "graph_fact_extraction";
        promotion_recommendation: "promotion_recommendation";
        deep_research: "deep_research";
        vision_analysis: "vision_analysis";
    }>;
    complexity: z.ZodEnum<{
        low: "low";
        medium: "medium";
        high: "high";
        trivial: "trivial";
        critical: "critical";
    }>;
    data_sensitivity: z.ZodEnum<{
        public: "public";
        internal: "internal";
        confidential: "confidential";
        restricted: "restricted";
    }>;
    requires_search: z.ZodBoolean;
    requires_citations: z.ZodBoolean;
    requires_json: z.ZodBoolean;
    required_output_schema: z.ZodNullable<z.ZodString>;
    freshness_requirement: z.ZodEnum<{
        hour: "hour";
        day: "day";
        week: "week";
        month: "month";
        year: "year";
        none: "none";
    }>;
    modality: z.ZodEnum<{
        text: "text";
        vision: "vision";
        multimodal: "multimodal";
    }>;
    expected_output_tokens: z.ZodNullable<z.ZodNumber>;
    max_latency_class: z.ZodEnum<{
        fast: "fast";
        realtime: "realtime";
        normal: "normal";
        slow: "slow";
    }>;
    evidence_required: z.ZodBoolean;
    prompt_contract_ref: z.ZodNullable<z.ZodString>;
    validation_profile: z.ZodEnum<{
        code: "code";
        strict_json: "strict_json";
        cited_answer: "cited_answer";
        freeform: "freeform";
        visual: "visual";
    }>;
    task_profile_hash: z.ZodString;
}, z.core.$strict>;
export type TaskProfile = z.infer<typeof TaskProfileSchema>;
export type TaskProfileInput = Omit<TaskProfile, 'schema_version' | 'task_profile_hash'>;
export declare const SelectedRouteSchema: z.ZodObject<{
    provider: z.ZodEnum<{
        openrouter: "openrouter";
        perplexity: "perplexity";
        openai: "openai";
        anthropic: "anthropic";
        mistral: "mistral";
        gemini: "gemini";
        deepseek: "deepseek";
    }>;
    model: z.ZodString;
    temperature: z.ZodNumber;
    max_tokens: z.ZodNumber;
    reasoning_depth: z.ZodEnum<{
        low: "low";
        medium: "medium";
        high: "high";
        none: "none";
    }>;
    response_format: z.ZodEnum<{
        json: "json";
        text: "text";
    }>;
}, z.core.$strict>;
export declare const SearchDecisionSchema: z.ZodObject<{
    enabled: z.ZodBoolean;
    provider: z.ZodNullable<z.ZodLiteral<"perplexity">>;
    search_mode: z.ZodNullable<z.ZodEnum<{
        web: "web";
        academic: "academic";
        sec: "sec";
    }>>;
    search_context_size: z.ZodNullable<z.ZodEnum<{
        low: "low";
        medium: "medium";
        high: "high";
    }>>;
    recency_filter: z.ZodNullable<z.ZodEnum<{
        hour: "hour";
        day: "day";
        week: "week";
        month: "month";
        year: "year";
        none: "none";
    }>>;
    variations: z.ZodNullable<z.ZodNumber>;
    reasoning_effort: z.ZodNullable<z.ZodEnum<{
        low: "low";
        medium: "medium";
        high: "high";
    }>>;
}, z.core.$strict>;
export declare const RouteTargetSchema: z.ZodObject<{
    provider: z.ZodEnum<{
        openrouter: "openrouter";
        perplexity: "perplexity";
        openai: "openai";
        anthropic: "anthropic";
        mistral: "mistral";
        gemini: "gemini";
        deepseek: "deepseek";
    }>;
    model: z.ZodString;
}, z.core.$strict>;
export declare const PolicyDecisionSchema: z.ZodObject<{
    status: z.ZodEnum<{
        allowed: "allowed";
        modified: "modified";
        blocked: "blocked";
    }>;
    applied_rules: z.ZodArray<z.ZodString>;
    blockers: z.ZodArray<z.ZodString>;
}, z.core.$strict>;
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;
export declare const BudgetDecisionSchema: z.ZodObject<{
    status: z.ZodEnum<{
        allowed: "allowed";
        blocked: "blocked";
        downgraded: "downgraded";
    }>;
    reason: z.ZodString;
}, z.core.$strict>;
export type BudgetDecision = z.infer<typeof BudgetDecisionSchema>;
export declare const ProviderHealthDecisionSchema: z.ZodObject<{
    status: z.ZodEnum<{
        unknown: "unknown";
        healthy: "healthy";
        degraded: "degraded";
        unavailable: "unavailable";
    }>;
    reason: z.ZodString;
}, z.core.$strict>;
export type ProviderHealthDecision = z.infer<typeof ProviderHealthDecisionSchema>;
export declare const LLM_ROUTE_PLAN_SCHEMA_VERSION: "l9-llm-route-plan/v1";
export declare const LLMRoutePlanSchema: z.ZodObject<{
    schema_version: z.ZodLiteral<"l9-llm-route-plan/v1">;
    route_fingerprint: z.ZodString;
    plan_id: z.ZodString;
    request_id: z.ZodString;
    task_profile_hash: z.ZodString;
    selected: z.ZodObject<{
        provider: z.ZodEnum<{
            openrouter: "openrouter";
            perplexity: "perplexity";
            openai: "openai";
            anthropic: "anthropic";
            mistral: "mistral";
            gemini: "gemini";
            deepseek: "deepseek";
        }>;
        model: z.ZodString;
        temperature: z.ZodNumber;
        max_tokens: z.ZodNumber;
        reasoning_depth: z.ZodEnum<{
            low: "low";
            medium: "medium";
            high: "high";
            none: "none";
        }>;
        response_format: z.ZodEnum<{
            json: "json";
            text: "text";
        }>;
    }, z.core.$strict>;
    search: z.ZodObject<{
        enabled: z.ZodBoolean;
        provider: z.ZodNullable<z.ZodLiteral<"perplexity">>;
        search_mode: z.ZodNullable<z.ZodEnum<{
            web: "web";
            academic: "academic";
            sec: "sec";
        }>>;
        search_context_size: z.ZodNullable<z.ZodEnum<{
            low: "low";
            medium: "medium";
            high: "high";
        }>>;
        recency_filter: z.ZodNullable<z.ZodEnum<{
            hour: "hour";
            day: "day";
            week: "week";
            month: "month";
            year: "year";
            none: "none";
        }>>;
        variations: z.ZodNullable<z.ZodNumber>;
        reasoning_effort: z.ZodNullable<z.ZodEnum<{
            low: "low";
            medium: "medium";
            high: "high";
        }>>;
    }, z.core.$strict>;
    fallback_chain: z.ZodArray<z.ZodObject<{
        provider: z.ZodEnum<{
            openrouter: "openrouter";
            perplexity: "perplexity";
            openai: "openai";
            anthropic: "anthropic";
            mistral: "mistral";
            gemini: "gemini";
            deepseek: "deepseek";
        }>;
        model: z.ZodString;
    }, z.core.$strict>>;
    policy_decision: z.ZodObject<{
        status: z.ZodEnum<{
            allowed: "allowed";
            modified: "modified";
            blocked: "blocked";
        }>;
        applied_rules: z.ZodArray<z.ZodString>;
        blockers: z.ZodArray<z.ZodString>;
    }, z.core.$strict>;
    budget_decision: z.ZodObject<{
        status: z.ZodEnum<{
            allowed: "allowed";
            blocked: "blocked";
            downgraded: "downgraded";
        }>;
        reason: z.ZodString;
    }, z.core.$strict>;
    provider_health_decision: z.ZodObject<{
        status: z.ZodEnum<{
            unknown: "unknown";
            healthy: "healthy";
            degraded: "degraded";
            unavailable: "unavailable";
        }>;
        reason: z.ZodString;
    }, z.core.$strict>;
    learned_candidate_refs: z.ZodArray<z.ZodString>;
    route_reason: z.ZodString;
    dispatch_allowed: z.ZodBoolean;
    content_hash: z.ZodString;
}, z.core.$strict>;
export type LLMRoutePlan = z.infer<typeof LLMRoutePlanSchema>;
export type LLMRoutePlanInput = Omit<LLMRoutePlan, 'schema_version' | 'route_fingerprint' | 'plan_id' | 'content_hash'>;
export declare const LLM_EXECUTION_RECORD_SCHEMA_VERSION: "l9-llm-execution-record/v1";
export declare const LLMExecutionRecordSchema: z.ZodObject<{
    schema_version: z.ZodLiteral<"l9-llm-execution-record/v1">;
    request_id: z.ZodString;
    plan_id: z.ZodString;
    route_fingerprint: z.ZodString;
    tenant_id: z.ZodString;
    node_id: z.ZodString;
    action: z.ZodString;
    task_profile_hash: z.ZodString;
    provider: z.ZodEnum<{
        openrouter: "openrouter";
        perplexity: "perplexity";
        openai: "openai";
        anthropic: "anthropic";
        mistral: "mistral";
        gemini: "gemini";
        deepseek: "deepseek";
    }>;
    model: z.ZodString;
    config_hash: z.ZodString;
    prompt_hash: z.ZodString;
    input_hash: z.ZodString;
    output_hash: z.ZodString;
    input_tokens: z.ZodNumber;
    output_tokens: z.ZodNumber;
    total_tokens: z.ZodNumber;
    cost: z.ZodNumber;
    latency_ms: z.ZodNumber;
    citations_count: z.ZodNumber;
    fallback_used: z.ZodBoolean;
    fallback_from: z.ZodNullable<z.ZodObject<{
        provider: z.ZodEnum<{
            openrouter: "openrouter";
            perplexity: "perplexity";
            openai: "openai";
            anthropic: "anthropic";
            mistral: "mistral";
            gemini: "gemini";
            deepseek: "deepseek";
        }>;
        model: z.ZodString;
    }, z.core.$strict>>;
    validation_status: z.ZodEnum<{
        blocked: "blocked";
        passed: "passed";
        failed: "failed";
        not_run: "not_run";
    }>;
    schema_valid: z.ZodNullable<z.ZodBoolean>;
    downstream_accepted: z.ZodNullable<z.ZodBoolean>;
    quality_score: z.ZodNullable<z.ZodNumber>;
    failure_reason: z.ZodNullable<z.ZodString>;
    provider_request_id: z.ZodNullable<z.ZodString>;
    pricing_version: z.ZodString;
    finish_reason: z.ZodNullable<z.ZodString>;
    generated_at: z.ZodString;
    content_hash: z.ZodString;
}, z.core.$strict>;
export type LLMExecutionRecord = z.infer<typeof LLMExecutionRecordSchema>;
export type LLMExecutionRecordInput = Omit<LLMExecutionRecord, 'schema_version' | 'content_hash'>;
export declare const LLM_FEEDBACK_SIGNAL_SCHEMA_VERSION: "l9-llm-router-signal/v1";
export declare const LLMFeedbackSignalSchema: z.ZodObject<{
    schema_version: z.ZodLiteral<"l9-llm-router-signal/v1">;
    signal_family: z.ZodLiteral<"llm_routing">;
    signal_type: z.ZodEnum<{
        fallback_used: "fallback_used";
        route_success: "route_success";
        route_failure: "route_failure";
        provider_degraded: "provider_degraded";
        high_cost: "high_cost";
        low_cost_high_quality: "low_cost_high_quality";
        citation_missing: "citation_missing";
        citation_strong: "citation_strong";
        json_parse_failed: "json_parse_failed";
        schema_validation_failed: "schema_validation_failed";
        hallucination_suspected: "hallucination_suspected";
        output_rejected: "output_rejected";
        output_accepted: "output_accepted";
        latency_high: "latency_high";
        retry_required: "retry_required";
        best_config_candidate: "best_config_candidate";
    }>;
    severity: z.ZodEnum<{
        low: "low";
        medium: "medium";
        high: "high";
        critical: "critical";
        info: "info";
    }>;
    task_profile_hash: z.ZodString;
    route_fingerprint: z.ZodString;
    plan_id: z.ZodString;
    evidence_refs: z.ZodArray<z.ZodString>;
    content_hash: z.ZodString;
}, z.core.$strict>;
export type LLMFeedbackSignal = z.infer<typeof LLMFeedbackSignalSchema>;
export type LLMFeedbackSignalInput = Omit<LLMFeedbackSignal, 'schema_version' | 'signal_family' | 'content_hash'>;
//# sourceMappingURL=contracts.d.ts.map