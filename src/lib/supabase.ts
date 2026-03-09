import { createClient } from "@supabase/supabase-js";
import { getEnv } from "@/config/env";

const env = getEnv();

if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.warn("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing");
}

const supabaseUrl = env.SUPABASE_URL || "https://placeholder.supabase.co";
const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY || "placeholder-service-role-key";

export const supabaseAdmin = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});
