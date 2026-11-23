import { providerIdSchema, type ProviderId } from "@markethub/contracts";

/**
 * Validate a raw provider selection from the snapshot form.
 *
 * Returns the validated ProviderId for a real selection, or null for the empty
 * placeholder or any invalid value. Pure: no React or DOM dependency, so it can
 * be unit-tested directly and reused by both snapshot handlers.
 */
export function selectedProviderOrError(value: string): ProviderId | null {
  const parsed = providerIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
