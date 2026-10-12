const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** Conservative product defaults: no inferred story requirements and no corpus claim. */
export function defaultFull15Input() {
  return { requirements: { c05_applicable: false }, references: { sources: [] }, profile: 'no_corpus' };
}

/** Translate only frozen machine fields from this creation's saved requestSpec. */
export function full15InputFromRequestSpec(requestSpec) {
  const source = requestSpec?.requirements;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return defaultFull15Input();
  const minimum = integer(source.targetHanMin), maximum = integer(source.targetHanMax), chapters = integer(source.targetChapterCount);
  const requirements = { count_basis: 'han', c05_applicable: source.usesChapter4Cut === true };
  if (minimum !== undefined) requirements.min_body_length = minimum;
  if (maximum !== undefined) requirements.max_body_length = maximum;
  if (chapters !== undefined) requirements.min_chapters = requirements.max_chapters = chapters;
  return { requirements, references: { sources: [] }, profile: 'no_corpus' };
}
