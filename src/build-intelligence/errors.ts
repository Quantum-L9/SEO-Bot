/* L9_META
 * layer: service
 * role: seo_bot_engine
 * status: active
 */

/**
 * Canonical build-intelligence producer error codes. Names match the
 * Website-Bot / campaign contract. Do not invent a second authority for the
 * same failure.
 */

export class BuildIntelligenceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class CompetitiveEvidenceIncompleteError extends BuildIntelligenceError {
  constructor(message: string) {
    super("COMPETITIVE_EVIDENCE_INCOMPLETE", message);
  }
}

export class CompetitiveDonorQualificationFailedError extends BuildIntelligenceError {
  constructor(message: string) {
    super("COMPETITIVE_DONOR_QUALIFICATION_FAILED", message);
  }
}

export class CompetitiveLandscapeInvalidError extends BuildIntelligenceError {
  constructor(message: string) {
    super("COMPETITIVE_LANDSCAPE_INVALID", message);
  }
}

export class CompetitiveLandscapeRefMismatchError extends BuildIntelligenceError {
  constructor(message: string) {
    super("COMPETITIVE_LANDSCAPE_REF_MISMATCH", message);
  }
}

export class RouteSetMismatchError extends BuildIntelligenceError {
  constructor(message: string) {
    super("ROUTE_SET_MISMATCH", message);
  }
}

export class ContentSlotInvalidError extends BuildIntelligenceError {
  constructor(message: string) {
    super("CONTENT_SLOT_INVALID", message);
  }
}

export class SeoContentBlueprintInvalidError extends BuildIntelligenceError {
  constructor(message: string) {
    super("SEO_CONTENT_BLUEPRINT_INVALID", message);
  }
}

export class PageContentContractInvalidError extends BuildIntelligenceError {
  constructor(message: string) {
    super("PAGE_CONTENT_CONTRACT_INVALID", message);
  }
}

export class PageContentContractHashMismatchError extends BuildIntelligenceError {
  constructor(message: string) {
    super("PAGE_CONTENT_CONTRACT_HASH_MISMATCH", message);
  }
}

export class StructuredContentRouteMismatchError extends BuildIntelligenceError {
  constructor(message: string) {
    super("STRUCTURED_CONTENT_ROUTE_MISMATCH", message);
  }
}

export class StructuredContentValidationFailedError extends BuildIntelligenceError {
  constructor(
    message: string,
    readonly failedRequirements: string[] = [],
  ) {
    super("STRUCTURED_CONTENT_VALIDATION_FAILED", message);
  }
}

export class UnsupportedContentClaimError extends BuildIntelligenceError {
  constructor(
    message: string,
    readonly unsupportedClaims: string[] = [],
  ) {
    super("UNSUPPORTED_CONTENT_CLAIM", message);
  }
}

export class ContentRepairExhaustedError extends BuildIntelligenceError {
  constructor(
    message: string,
    readonly failedRequirements: string[] = [],
  ) {
    super("CONTENT_REPAIR_EXHAUSTED", message);
  }
}

export class ArtifactSchemaMismatchError extends BuildIntelligenceError {
  constructor(message: string) {
    super("ARTIFACT_SCHEMA_MISMATCH", message);
  }
}

export class ArtifactLineageMismatchError extends BuildIntelligenceError {
  constructor(message: string) {
    super("ARTIFACT_LINEAGE_MISMATCH", message);
  }
}

export class ProviderBypassDetectedError extends BuildIntelligenceError {
  constructor(message: string) {
    super("PROVIDER_BYPASS_DETECTED", message);
  }
}

/** @deprecated Use ContentRepairExhaustedError. Kept as an alias for existing imports. */
export const ContentRequirementUnsatisfiedError = ContentRepairExhaustedError;
