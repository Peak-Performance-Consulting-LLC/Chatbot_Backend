import { resolveTxt } from "node:dns/promises";
import type { DomainVerificationStatus } from "@/platform/repository";

export type DnsVerificationResult = {
  verified: boolean;
  status: DomainVerificationStatus;
  records: string[];
  error?: string;
};

function normalizeTxtRecord(raw: string): string {
  return raw.replace(/^"+|"+$/g, "").replace(/"\s*"/g, "").trim();
}

async function resolveTxtFromGoogleDns(txtName: string): Promise<string[]> {
  const query = new URL("https://dns.google/resolve");
  query.searchParams.set("name", txtName);
  query.searchParams.set("type", "TXT");

  const response = await fetch(query.toString(), {
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    return [];
  }

  const json = (await response.json().catch(() => ({}))) as {
    Answer?: Array<{ data?: string }>;
  };

  return (json.Answer ?? [])
    .map((item) => normalizeTxtRecord(item.data ?? ""))
    .filter(Boolean);
}

async function resolveTxtRecords(txtName: string): Promise<string[]> {
  try {
    const records = await resolveTxt(txtName);
    const values = records
      .map((segments) => normalizeTxtRecord(segments.join("")))
      .filter(Boolean);

    if (values.length > 0) {
      return Array.from(new Set(values));
    }
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code?: string }).code) : "";
    if (code !== "ENODATA" && code !== "ENOTFOUND" && code !== "ETIMEOUT") {
      throw error;
    }
  }

  return Array.from(new Set(await resolveTxtFromGoogleDns(txtName)));
}

export async function verifyDnsTxtRecord(input: {
  txtName: string;
  expectedValue: string;
}): Promise<DnsVerificationResult> {
  try {
    const records = await resolveTxtRecords(input.txtName);

    if (records.length === 0) {
      return {
        verified: false,
        status: "txt_not_found",
        records
      };
    }

    if (records.includes(input.expectedValue)) {
      return {
        verified: true,
        status: "verified",
        records
      };
    }

    return {
      verified: false,
      status: "txt_mismatch",
      records
    };
  } catch (error) {
    return {
      verified: false,
      status: "pending",
      records: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
