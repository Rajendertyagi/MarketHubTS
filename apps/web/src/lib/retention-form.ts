import {
  retentionDataClassSchema,
  retentionSettingsSchema,
  type RetentionDataClass,
  type RetentionSettings,
  type RetentionSettingsView
} from "@markethub/contracts";

/** Raw, unmodified text for each retention class as typed by the operator. */
export type RetentionDraft = Record<RetentionDataClass, string>;
/** Field-level validation messages keyed by retention class. */
export type RetentionDraftErrors = Partial<Record<RetentionDataClass, string>>;

/** Canonical accepted form after trimming: ASCII digits only. */
const DIGITS_ONLY = /^[0-9]+$/;

const NON_DIGIT_ERROR = "Use digits only (for example 30).";
const INVALID_VALUE_ERROR = "Enter a positive whole number of days.";

/**
 * Pure, non-mutating parser for the retention form draft. Each raw string is
 * trimmed; blank means the class is omitted (no limit). Non-blank values must
 * be ASCII digits only and parse to a safe positive integer. Leading zeros are
 * accepted. Returns field-specific errors and a null settings object if any
 * field is invalid; otherwise returns a schema-validated settings object.
 */
export function parseRetentionDraft(draft: RetentionDraft): {
  settings: RetentionSettings | null;
  errors: RetentionDraftErrors;
} {
  const errors: RetentionDraftErrors = {};
  const classes: RetentionSettings["classes"] = {};

  for (const dataClass of retentionDataClassSchema.options) {
    const raw = draft[dataClass].trim();
    if (raw === "") continue;
    if (!DIGITS_ONLY.test(raw)) {
      errors[dataClass] = NON_DIGIT_ERROR;
      continue;
    }
    const days = Number(raw);
    if (!Number.isSafeInteger(days) || days <= 0) {
      errors[dataClass] = INVALID_VALUE_ERROR;
      continue;
    }
    classes[dataClass] = { maxAgeDays: days };
  }

  if (Object.keys(errors).length > 0) return { settings: null, errors };

  const parsed = retentionSettingsSchema.safeParse({ version: 1, classes });
  if (!parsed.success) {
    // Defensive: the shared schema is the source of truth. Surface a generic
    // field-level message rather than returning an unvalidated settings object.
    for (const dataClass of retentionDataClassSchema.options) {
      errors[dataClass] = INVALID_VALUE_ERROR;
    }
    return { settings: null, errors };
  }
  return { settings: parsed.data, errors: {} };
}

/**
 * Pure save decision. The only path that may call the save API is the `save`
 * branch, so "invalid input blocks save" is directly testable without a DOM.
 */
export type RetentionSaveDecision =
  | { kind: "save"; settings: RetentionSettings }
  | { kind: "block"; errors: RetentionDraftErrors };

export function retentionSaveDecision(draft: RetentionDraft): RetentionSaveDecision {
  const { settings, errors } = parseRetentionDraft(draft);
  return settings ? { kind: "save", settings } : { kind: "block", errors };
}

/** Map a persisted settings view to raw draft text. Invalid/missing views yield three blanks. */
export function draftFromView(view: RetentionSettingsView): RetentionDraft {
  if (!view.valid || !view.settings) {
    return { CANDLE: "", SNAPSHOT: "", ACTIVITY: "" };
  }
  const classes = view.settings.classes;
  return {
    CANDLE: classes.CANDLE?.maxAgeDays?.toString() ?? "",
    SNAPSHOT: classes.SNAPSHOT?.maxAgeDays?.toString() ?? "",
    ACTIVITY: classes.ACTIVITY?.maxAgeDays?.toString() ?? ""
  };
}

/** Whether the initial saved-settings read is pending, confirmed, or failed. */
export type RetentionLoadState = "loading" | "loaded" | "failed";

export interface RetentionStatusInfo {
  text: string;
  canSave: boolean;
}

/**
 * Pure status/save-gating decision. Save is blocked until the initial read
 * succeeds, so an unsaved blank draft cannot overwrite configured limits.
 * A confirmed missing/invalid state deliberately allows saving an empty config.
 */
export function retentionStatusInfo(
  loadState: RetentionLoadState,
  view: RetentionSettingsView | null
): RetentionStatusInfo {
  if (loadState === "loading") {
    return { text: "Loading saved retention settings…", canSave: false };
  }
  if (loadState === "failed") {
    return { text: "Could not load saved retention settings. Save is disabled until settings load successfully; reload the page to retry.", canSave: false };
  }
  if (!view?.valid) {
    return { text: "No valid saved retention settings. Cleanup is disabled and deletes nothing.", canSave: true };
  }
  const classes = view.settings.classes;
  const hasLimits = classes.CANDLE !== undefined || classes.SNAPSHOT !== undefined || classes.ACTIVITY !== undefined;
  return {
    text: hasLimits
      ? "Saved retention limits apply only to the configured data classes."
      : "Saved settings are valid, but no retention limits are configured. Cleanup will delete nothing.",
    canSave: true
  };
}
