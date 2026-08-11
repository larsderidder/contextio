/**
 * PresidioTsDetector - PII detection using @siddicky/anonymizerts (Presidio for TypeScript).
 *
 * This detector wraps the PresidioAnalyzer from @siddicky/anonymizerts which combines:
 * - Pattern-based recognizers (regex) for structured PII (email, phone, SSN, credit card, IP, URL)
 * - NER-based recognition (transformers.js) for semantic entities (PERSON, LOCATION, ORGANIZATION, DATE_TIME)
 *
 * The first call to detect() will trigger warmup as transformers.js loads the WASM model.
 */

import type {
  Detector,
  DetectorConfig,
  DetectionResult,
  DetectedSpan,
} from "./detector.js";
import {
  PresidioAnalyzer,
  type RecognizerResult,
  EntityType,
} from "@siddicky/anonymizerts";

/**
 * Configuration for PresidioTsDetector extending base DetectorConfig.
 */
export interface PresidioTsConfig extends DetectorConfig {
  /** Enable NER-based recognition (transformers.js). Default: true. */
  useNER?: boolean;
  /** NER model to use. Default: "Xenova/bert-base-NER". */
  modelName?: string;
  /** Minimum confidence threshold for detections. Default: 0.5. */
  threshold?: number;
  /** Entity types to detect. If empty, detects all supported types. */
  labels?: string[];
}

/**
 * PresidioTsDetector implements the Detector interface using @siddicky/anonymizerts.
 *
 * Supported entity types (from Presidio EntityType enum):
 * - PERSON, LOCATION, ORGANIZATION (NER-based)
 * - EMAIL_ADDRESS, PHONE_NUMBER, CREDIT_CARD, US_SSN (pattern-based)
 * - IP_ADDRESS, URL, DATE_TIME (pattern-based)
 *
 * Note: The @siddicky/anonymizerts package currently supports the above types.
 * Additional Presidio entity types (IBAN_CODE, NRP, MEDICAL_LICENSE, US_DRIVER_LICENSE,
 * US_PASSPORT, US_BANK_NUMBER, US_ITIN, CRYPTO, AWS_KEY, GITHUB_TOKEN) may be added
 * in future versions of the package.
 */
export class PresidioTsDetector implements Detector {
  readonly name: string;
  readonly description =
    "Microsoft Presidio PII detection via @siddicky/anonymizerts (pattern + NER, local, private)";

  private analyzer: PresidioAnalyzer;
  private config: PresidioTsConfig;
  private initialized = false;
  private initializing: Promise<void> | null = null;

  // Entity types supported by the current @siddicky/anonymizerts version
  private static readonly SUPPORTED_ENTITY_TYPES: readonly EntityType[] = [
    EntityType.PERSON,
    EntityType.LOCATION,
    EntityType.ORGANIZATION,
    EntityType.EMAIL_ADDRESS,
    EntityType.PHONE_NUMBER,
    EntityType.CREDIT_CARD,
    EntityType.US_SSN,
    EntityType.IP_ADDRESS,
    EntityType.URL,
    EntityType.DATE_TIME,
  ] as const;

  // Map Presidio EntityType to display labels
  private static readonly ENTITY_LABEL_MAP: Record<EntityType, string> = {
    [EntityType.PERSON]: "PERSON",
    [EntityType.LOCATION]: "LOCATION",
    [EntityType.ORGANIZATION]: "ORGANIZATION",
    [EntityType.EMAIL_ADDRESS]: "EMAIL_ADDRESS",
    [EntityType.PHONE_NUMBER]: "PHONE_NUMBER",
    [EntityType.CREDIT_CARD]: "CREDIT_CARD",
    [EntityType.US_SSN]: "US_SSN",
    [EntityType.IP_ADDRESS]: "IP_ADDRESS",
    [EntityType.URL]: "URL",
    [EntityType.DATE_TIME]: "DATE_TIME",
  };

  constructor(config: PresidioTsConfig) {
    this.name = config.name ?? "presidio-ts";
    this.config = {
      useNER: true,
      modelName: "Xenova/bert-base-NER",
      threshold: 0.5,
      ...config,
    };

    this.analyzer = new PresidioAnalyzer({
      useNER: this.config.useNER ?? true,
      modelName: this.config.modelName ?? "Xenova/bert-base-NER",
    });
  }

  get labels(): readonly string[] {
    // If config specifies labels, return canonical versions; otherwise return all supported
    if (this.config.labels && this.config.labels.length > 0) {
      return this.config.labels
        .map((label) => {
          const entityType = this.labelToEntityType(label);
          return entityType
            ? PresidioTsDetector.ENTITY_LABEL_MAP[entityType]
            : label.toUpperCase();
        })
        .filter((l): l is string => l !== null && l !== undefined);
    }
    return PresidioTsDetector.SUPPORTED_ENTITY_TYPES.map(
      (et) => PresidioTsDetector.ENTITY_LABEL_MAP[et]
    );
  }

  /**
   * Initialize the analyzer (loads NER model if enabled).
   * This should be called before first use, but detect() will auto-initialize if needed.
   */
  async initialize(config?: DetectorConfig): Promise<void> {
    // Merge runtime config
    if (config) {
      this.config = { ...this.config, ...config } as PresidioTsConfig;
    }

    // Warn on unsupported labels
    if (this.config.labels && this.config.labels.length > 0) {
      const supportedLabels = new Set(
        PresidioTsDetector.SUPPORTED_ENTITY_TYPES.map(
          (et) => PresidioTsDetector.ENTITY_LABEL_MAP[et]
        )
      );
      // Also add common aliases
      const aliasLabels = new Set([
        "EMAIL",
        "PHONE",
        "SSN",
        "IP",
        "DATE",
        "DATETIME",
      ]);
      const allSupportedLabels = new Set([...supportedLabels, ...aliasLabels]);

      for (const label of this.config.labels) {
        const upperLabel = label.toUpperCase();
        if (!allSupportedLabels.has(upperLabel)) {
          console.warn(
            `[presidio-ts] Unsupported label "${label}" - ignoring. Supported: ${Array.from(supportedLabels).join(", ")}`
          );
        }
      }
    }

    // Prevent duplicate initialization
    if (this.initialized) return;
    if (this.initializing) {
      await this.initializing;
      return;
    }

    this.initializing = (async () => {
      try {
        // Initialize the analyzer (loads transformers.js NER model on first call)
        await this.analyzer.initialize();
        this.initialized = true;
      } catch (error) {
        this.initializing = null;
        throw new Error(
          `Failed to initialize PresidioTsDetector: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    })();

    await this.initializing;
    this.initializing = null;
  }

  /**
   * Check if detector is ready for detection.
   */
  isReady(): boolean {
    return this.initialized;
  }

  /**
   * Clean up resources. Note: transformers.js doesn't expose a cleanup method,
   * but we mark as uninitialized to allow re-initialization if needed.
   */
  async shutdown(): Promise<void> {
    this.initialized = false;
    this.initializing = null;
    // The NER pipeline in transformers.js doesn't have an explicit shutdown,
    // but we can drop our reference to allow GC
  }

  /**
   * Detect PII/entities in text using Presidio analyzer.
   *
   * @param text - Input text to analyze
   * @param config - Optional runtime configuration override
   * @returns Detected spans with confidence scores
   */
  async detect(text: string, config?: DetectorConfig): Promise<DetectionResult> {
    const startTime = Date.now();

    // Auto-initialize if not already done (handles warmup on first call)
    if (!this.initialized) {
      await this.initialize(config);
    }

    if (!this.isReady()) {
      throw new Error(
        "PresidioTsDetector not initialized. Call initialize() first."
      );
    }

    const finalConfig = { ...this.config, ...config } as PresidioTsConfig;
    const threshold = finalConfig.threshold ?? 0.5;

    // Determine which entity types to detect
    let entityTypes: EntityType[] | undefined;
    if (finalConfig.labels && finalConfig.labels.length > 0) {
      entityTypes = finalConfig.labels
        .map((label) => this.labelToEntityType(label))
        .filter((et): et is EntityType => et !== null);
    }

    // Run analysis
    const analyzerResults = await this.analyzer.analyze(text, entityTypes);

    // Convert to DetectionResult format
    const spans = analyzerResults
      .filter((result: RecognizerResult) => result.score >= threshold)
      .map((result: RecognizerResult) => this.convertToDetectedSpan(result));

    // Sort by start position
    spans.sort((a: DetectedSpan, b: DetectedSpan) => a.start - b.start);

    return {
      spans,
      latencyMs: Date.now() - startTime,
    };
  }

  /**
   * Convert a Presidio RecognizerResult to our DetectedSpan format.
   */
  private convertToDetectedSpan(result: RecognizerResult): DetectedSpan {
    return {
      text: result.text,
      start: result.start,
      end: result.end,
      label: PresidioTsDetector.ENTITY_LABEL_MAP[result.entityType] ?? result.entityType,
      score: result.score,
      detectorName: this.name,
    };
  }

  /**
   * Map a label string to Presidio EntityType.
   * Returns null if the label is not recognized.
   */
  private labelToEntityType(label: string): EntityType | null {
    const upperLabel = label.toUpperCase();

    // Direct enum value match
    if (Object.values(EntityType).includes(upperLabel as EntityType)) {
      return upperLabel as EntityType;
    }

    // Common aliases
    const aliasMap: Record<string, EntityType> = {
      PERSON: EntityType.PERSON,
      LOCATION: EntityType.LOCATION,
      ORGANIZATION: EntityType.ORGANIZATION,
      EMAIL: EntityType.EMAIL_ADDRESS,
      EMAIL_ADDRESS: EntityType.EMAIL_ADDRESS,
      PHONE: EntityType.PHONE_NUMBER,
      PHONE_NUMBER: EntityType.PHONE_NUMBER,
      CREDIT_CARD: EntityType.CREDIT_CARD,
      SSN: EntityType.US_SSN,
      US_SSN: EntityType.US_SSN,
      IP: EntityType.IP_ADDRESS,
      IP_ADDRESS: EntityType.IP_ADDRESS,
      URL: EntityType.URL,
      DATE: EntityType.DATE_TIME,
      DATE_TIME: EntityType.DATE_TIME,
      DATETIME: EntityType.DATE_TIME,
    };

    return aliasMap[upperLabel] ?? null;
  }
}

/**
 * Factory function to create and initialize a PresidioTsDetector.
 *
 * @param config - Detector configuration
 * @returns Initialized PresidioTsDetector instance
 *
 * @example
 * ```typescript
 * const detector = await createPresidioTsDetector({
 *   name: "pii-detector",
 *   threshold: 0.6,
 *   useNER: true,
 *   labels: ["PERSON", "EMAIL_ADDRESS", "PHONE_NUMBER"]
 * });
 * const result = await detector.detect("John Doe <john@example.com>");
 * ```
 */
export async function createPresidioTsDetector(
  config: PresidioTsConfig
): Promise<PresidioTsDetector> {
  const detector = new PresidioTsDetector(config);
  await detector.initialize(config);
  return detector;
}
