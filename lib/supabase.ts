import { createClient } from "@supabase/supabase-js";

export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
);

export const MCP_URL = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/fixnet/mcp`;
export const PUBLIC_URL = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/fixnet/public`;
