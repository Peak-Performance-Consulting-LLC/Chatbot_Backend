export type DnsVerificationResult = {
  verified: boolean;
  records: string[];
};

function normalizeTxtRecord(raw: string): string {
  return raw.replace(/^"+|"+$/g, "").replace(/"\s*"/g, "").trim();
}

export async function verifyDnsTxtRecord(input: {
  txtName: string;
  expectedValue: string;
}): Promise<DnsVerificationResult> {
  const query = new URL("https://dns.google/resolve");
  query.searchParams.set("name", input.txtName);
  query.searchParams.set("type", "TXT");

  const response = await fetch(query.toString(), {
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    return {
      verified: false,
      records: []
    };
  }

  const json = (await response.json().catch(() => ({}))) as {
    Answer?: Array<{ data?: string }>;
  };

  const records = (json.Answer ?? [])
    .map((item) => normalizeTxtRecord(item.data ?? ""))
    .filter(Boolean);

  return {
    verified: records.includes(input.expectedValue),
    records
  };
}

