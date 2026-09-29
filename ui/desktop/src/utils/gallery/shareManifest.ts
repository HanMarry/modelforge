/**
 * Share package metadata validation (requirement 13.4, 13.5). Title, competition, category and
 * abstract are all required; the title must be 1 to 200 code points; and the paper PDF must exist.
 * Every invalid field is reported, so the import dialog can list them all at once.
 */
export const TITLE_MAX_CODE_POINTS = 200;

export type ShareManifestField = 'title' | 'competition' | 'category' | 'abstract' | 'pdf';

export interface ShareManifestValidation {
  valid: boolean;
  /** Names of the invalid fields, in a stable order. */
  invalidFields: ShareManifestField[];
}

const REQUIRED_TEXT_FIELDS = ['title', 'competition', 'category', 'abstract'] as const;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function validateShareManifest(meta: unknown, hasPdf: boolean): ShareManifestValidation {
  const record = (typeof meta === 'object' && meta !== null ? meta : {}) as Record<string, unknown>;
  const invalidFields: ShareManifestField[] = [];

  const title = record.title;
  if (!isNonEmptyString(title) || Array.from(title).length > TITLE_MAX_CODE_POINTS) {
    invalidFields.push('title');
  }

  for (const field of REQUIRED_TEXT_FIELDS) {
    if (field === 'title') continue;
    if (!isNonEmptyString(record[field])) {
      invalidFields.push(field);
    }
  }

  if (!hasPdf) {
    invalidFields.push('pdf');
  }

  return { valid: invalidFields.length === 0, invalidFields };
}
