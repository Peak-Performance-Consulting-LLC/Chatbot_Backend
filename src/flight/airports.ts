export type AirportSuggestion = {
  code: string;
  city: string;
  airport: string;
  label: string;
  score: number;
};

type AirportRecord = {
  code: string;
  city: string;
  airport: string;
  aliases?: string[];
};

const AIRPORTS: AirportRecord[] = [
  { code: "JFK", city: "New York", airport: "John F. Kennedy International Airport", aliases: ["nyc", "new york city"] },
  { code: "LGA", city: "New York", airport: "LaGuardia Airport", aliases: ["nyc"] },
  { code: "EWR", city: "Newark", airport: "Newark Liberty International Airport", aliases: ["new york area"] },
  { code: "LAX", city: "Los Angeles", airport: "Los Angeles International Airport", aliases: ["la"] },
  { code: "SFO", city: "San Francisco", airport: "San Francisco International Airport" },
  { code: "SEA", city: "Seattle", airport: "Seattle-Tacoma International Airport" },
  { code: "ORD", city: "Chicago", airport: "O'Hare International Airport" },
  { code: "DFW", city: "Dallas", airport: "Dallas Fort Worth International Airport" },
  { code: "MIA", city: "Miami", airport: "Miami International Airport" },
  { code: "DEN", city: "Denver", airport: "Denver International Airport" },
  { code: "DEL", city: "Delhi", airport: "Indira Gandhi International Airport", aliases: ["new delhi"] },
  { code: "BOM", city: "Mumbai", airport: "Chhatrapati Shivaji Maharaj International Airport", aliases: ["bombay"] },
  { code: "DXB", city: "Dubai", airport: "Dubai International Airport" },
  { code: "LHR", city: "London", airport: "Heathrow Airport" },
  { code: "CDG", city: "Paris", airport: "Charles de Gaulle Airport" }
];

function normalize(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toSuggestion(item: AirportRecord, score: number): AirportSuggestion {
  return {
    code: item.code,
    city: item.city,
    airport: item.airport,
    label: `${item.city} (${item.code})`,
    score
  };
}

export function suggestAirports(query: string, limit = 8): AirportSuggestion[] {
  const q = normalize(query);
  if (!q) {
    return AIRPORTS.slice(0, limit).map((item) => toSuggestion(item, 80));
  }

  return AIRPORTS
    .map((item) => {
      const city = normalize(item.city);
      const airport = normalize(item.airport);
      const aliases = item.aliases?.map(normalize) ?? [];
      let score = 0;
      if (q === item.code.toLowerCase()) score = 120;
      else if (city === q) score = 110;
      else if (city.includes(q) || airport.includes(q) || aliases.some((alias) => alias.includes(q))) score = 90;
      return toSuggestion(item, score);
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function defaultAirportSuggestions(limit = 8): AirportSuggestion[] {
  return AIRPORTS.slice(0, limit).map((item) => toSuggestion(item, 80));
}

export function resolveAirport(query: string): AirportSuggestion | null {
  const cleaned = query.trim();
  const code = cleaned.match(/^[A-Za-z]{3}$/)?.[0]?.toUpperCase();
  if (code) {
    const hit = AIRPORTS.find((item) => item.code === code);
    return hit ? toSuggestion(hit, 120) : { code, city: code, airport: "Provided airport code", label: code, score: 100 };
  }

  const [best] = suggestAirports(cleaned, 1);
  return best ?? null;
}
