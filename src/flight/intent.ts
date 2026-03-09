const strongFlightKeywords = [
  "flight",
  "flights",
  "flite",
  "fligt",
  "flght",
  "airfare",
  "book flight",
  "book a flight",
  "flight deal",
  "flight deals",
  "air ticket",
  "airticket",
  "cheap flight",
  "cheap flights",
  "round-trip",
  "round trip",
  "one-way",
  "one way",
  "oneway",
  "depart",
  "departure",
  "arrival",
  "airport",
  "nonstop"
];

const contextualFlightKeywords = ["fare", "ticket", "tickets", "price", "book", "booking", "deal", "deals"];
const contextualTravelWords = ["flight", "airline", "airport", "route", "depart", "arrival", "one-way", "round-trip"];
const flightRestartKeywords = [
  "find flight deals",
  "new flight search",
  "start over",
  "start new search",
  "another flight",
  "book another flight"
];
const flightRefineKeywords = [
  "change dates",
  "change date",
  "change passengers",
  "change cabin",
  "change route",
  "change origin",
  "change destination",
  "update route",
  "modify route",
  "search again",
  "retry flight search",
  "retry",
  "refine",
  "fewer stops",
  "max budget",
  "budget"
];
const paymentKeywords = ["payment", "pay", "card", "credit card", "debit card", "cvv", "expiry"];

function normalizeWords(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function normalizeText(input: string): string {
  return normalizeWords(input).join(" ");
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const matrix = Array.from({ length: b.length + 1 }, (_, idx) => [idx]);
  for (let col = 0; col <= a.length; col += 1) matrix[0][col] = col;
  for (let row = 1; row <= b.length; row += 1) {
    for (let col = 1; col <= a.length; col += 1) {
      if (b[row - 1] === a[col - 1]) {
        matrix[row][col] = matrix[row - 1][col - 1] as number;
      } else {
        matrix[row][col] = Math.min(
          (matrix[row - 1][col - 1] as number) + 1,
          (matrix[row][col - 1] as number) + 1,
          (matrix[row - 1][col] as number) + 1
        );
      }
    }
  }
  return matrix[b.length][a.length] as number;
}

function hasFuzzyFlightWord(words: string[]): boolean {
  return words.some((word) => word.length >= 4 && levenshtein(word, "flight") <= 2);
}

export function detectFlightIntent(message: string): boolean {
  const text = normalizeText(message);
  const words = normalizeWords(message);

  if (strongFlightKeywords.some((keyword) => text.includes(keyword))) return true;

  const hasContextualKeyword = contextualFlightKeywords.some((keyword) => text.includes(keyword));
  const hasTravelContext = contextualTravelWords.some((keyword) => text.includes(keyword));
  if (hasContextualKeyword && hasTravelContext) return true;

  if (hasFuzzyFlightWord(words)) return true;
  if (/\bfrom\s+.+\s+to\s+.+/i.test(message)) return true;
  if (/\b[A-Za-z]{3}\b/.test(message) && /\b\d{4}[-/.]\d{2}[-/.]\d{2}\b/.test(message)) return true;
  if (flightRestartKeywords.some((keyword) => text.includes(keyword))) return true;

  return false;
}

export function detectFlightRestartIntent(message: string): boolean {
  const text = normalizeText(message);
  return flightRestartKeywords.some((keyword) => text.includes(keyword));
}

export function detectFlightStateUpdateIntent(message: string): boolean {
  const text = normalizeText(message);

  if (flightRefineKeywords.some((keyword) => text.includes(keyword))) return true;
  if (/\b\d{4}[-/.]\d{2}[-/.]\d{2}\b/.test(message)) return true;
  if (/\b(one[- ]?way|round[- ]?trip|roundtrip)\b/i.test(message)) return true;
  if (/\b(economy|premium economy|business|first)\b/i.test(message)) return true;
  if (/\b(adults?|children?|infants?)\b/i.test(message)) return true;
  if (/^\s*\d+\s*([/,-]\s*\d+\s*([/,-]\s*\d+)?)?\s*$/.test(message.trim())) return true;
  if (/\bfrom\s+.+\s+to\s+.+/i.test(message)) return true;
  if (/^[A-Za-z]{3}$/.test(message.trim())) return true;

  return false;
}

export function detectPaymentIntent(message: string): boolean {
  const text = message.toLowerCase();
  return paymentKeywords.some((keyword) => text.includes(keyword));
}
