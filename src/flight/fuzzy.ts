export function normalizeFuzzyToken(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function levenshteinDistance(a: string, b: string): number {
  const left = normalizeFuzzyToken(a);
  const right = normalizeFuzzyToken(b);

  if (left === right) {
    return 0;
  }

  if (!left.length) {
    return right.length;
  }

  if (!right.length) {
    return left.length;
  }

  const previous = Array.from({ length: right.length + 1 }, (_, i) => i);
  const current = new Array(right.length + 1).fill(0);

  for (let i = 1; i <= left.length; i += 1) {
    current[0] = i;

    for (let j = 1; j <= right.length; j += 1) {
      const substitutionCost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + substitutionCost
      );
    }

    for (let j = 0; j <= right.length; j += 1) {
      previous[j] = current[j];
    }
  }

  return previous[right.length];
}

export function fuzzyIncludes(message: string, candidates: string[], maxDistance = 1): boolean {
  const normalized = message.toLowerCase();

  for (const candidate of candidates) {
    if (normalized.includes(candidate.toLowerCase())) {
      return true;
    }
  }

  const tokens = normalized
    .split(/[^a-z0-9]+/)
    .map((token) => normalizeFuzzyToken(token))
    .filter(Boolean);

  for (const token of tokens) {
    for (const candidate of candidates) {
      const target = normalizeFuzzyToken(candidate);
      if (!target) {
        continue;
      }

      const distance = levenshteinDistance(token, target);
      if (distance <= maxDistance) {
        return true;
      }
    }
  }

  return false;
}

export function bestFuzzyMatch(
  input: string,
  candidates: string[],
  maxDistance = 2
): string | null {
  const normalized = normalizeFuzzyToken(input);
  if (!normalized) {
    return null;
  }

  let best: { value: string; distance: number } | null = null;

  for (const candidate of candidates) {
    const target = normalizeFuzzyToken(candidate);
    if (!target) {
      continue;
    }

    const distance = levenshteinDistance(normalized, target);
    if (distance > maxDistance) {
      continue;
    }

    if (!best || distance < best.distance) {
      best = { value: candidate, distance };
    }
  }

  return best?.value ?? null;
}
