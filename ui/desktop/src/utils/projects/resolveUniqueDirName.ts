/**
 * Unique directory-name suffixing (requirement 9.4): the first candidate is the desired
 * name, then `name-2`, `name-3`, … until one is not already taken. Comparison is
 * case-insensitive to match NTFS, where `Report` and `report` are the same directory.
 */
export function resolveUniqueDirName(desired: string, existing: ReadonlySet<string>): string {
  const taken = new Set<string>();
  for (const name of existing) {
    taken.add(name.toLowerCase());
  }

  if (!taken.has(desired.toLowerCase())) {
    return desired;
  }

  let suffix = 2;
  while (taken.has(`${desired.toLowerCase()}-${suffix}`)) {
    suffix += 1;
  }
  return `${desired}-${suffix}`;
}
