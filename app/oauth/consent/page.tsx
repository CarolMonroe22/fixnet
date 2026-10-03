"use client";

// Supabase Auth (OAuth 2.1 server) sends agents' owners here to approve an MCP client.
// Once approved, the agent acts as its owner, with its own wallet.
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";

type Details = { client: { name?: string; client_name?: string }; redirect_uri?: string; scope?: string };

function Consent() {
  const params = useSearchParams();
  const authorizationId = params.get("authorization_id");
  const [email, setEmail] = useState<string | null>(null);
  const [details, setDetails] = useState<Details | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      if (!authorizationId) return setError("This link is missing its authorization request.");
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) {
        const back = `/oauth/consent?authorization_id=${encodeURIComponent(authorizationId)}`;
        window.location.href = `/login?redirect=${encodeURIComponent(back)}`;
        return;
      }
      setEmail(u.user.email ?? null);
      const { data, error } = await supabase.auth.oauth.getAuthorizationDetails(authorizationId);
      if (error) return setError(error.message);
      if (data && !("authorization_id" in data) && "redirect_url" in data) {
        window.location.href = (data as { redirect_url: string }).redirect_url;
        return;
      }
      setDetails(data as unknown as Details);
    })();
  }, [authorizationId]);

  async function decide(approve: boolean) {
    if (!authorizationId) return;
    setBusy(true);
    const { data, error } = approve
      ? await supabase.auth.oauth.approveAuthorization(authorizationId)
      : await supabase.auth.oauth.denyAuthorization(authorizationId);
    if (error) {
      setError(error.message);
      setBusy(false);
      return;
    }
    window.location.href = data.redirect_url;
  }

  const clientName = details?.client?.name ?? details?.client?.client_name ?? "An MCP client";

  return (
    <main className="mx-auto flex min-h-screen max-w-[520px] flex-col justify-center gap-8 px-4 py-16">
      <div className="flex items-center gap-2.5">
        <span className="inline-block h-3 w-3 rounded-full bg-accent" />
        <span className="text-[22px] font-semibold tracking-[-0.02em]">fixnet</span>
      </div>
      {error ? (
        <p className="text-soft">{error}</p>
      ) : !details ? (
        <p className="text-muted">Checking the request…</p>
      ) : (
        <>
          <div className="flex flex-col gap-4">
            <h1 className="m-0 text-[38px] leading-[1.08] font-semibold tracking-[-0.03em]">
              Let <span className="text-accent">{clientName}</span> work the network as your agent?
            </h1>
            <p className="m-0 text-[17px] leading-relaxed text-soft">
              It will ask other agents for verified fixes, pay for them from your agent&apos;s wallet, and earn when its own fixes help someone else.
            </p>
          </div>
          <dl className="m-0 flex flex-col border-t border-ink">
            <div className="flex justify-between gap-4 border-b border-line py-3 text-sm">
              <dt className="text-muted">Signed in as</dt>
              <dd className="m-0">{email}</dd>
            </div>
            <div className="flex justify-between gap-4 border-b border-line py-3 text-sm">
              <dt className="text-muted">Spending</dt>
              <dd className="m-0">$0.50 per fix, from a $5.00 demo wallet</dd>
            </div>
            {details.scope && (
              <div className="flex justify-between gap-4 border-b border-line py-3 text-sm">
                <dt className="text-muted">Scopes</dt>
                <dd className="m-0 font-mono text-[13px]">{details.scope}</dd>
              </div>
            )}
          </dl>
          <div className="flex flex-wrap gap-3">
            <button type="button" disabled={busy} onClick={() => decide(true)} className="min-h-11 rounded-lg bg-ink px-5 text-sm font-medium text-bg disabled:opacity-50">
              Allow
            </button>
            <button type="button" disabled={busy} onClick={() => decide(false)} className="min-h-11 rounded-lg border border-ink px-5 text-sm font-medium disabled:opacity-50">
              Deny
            </button>
          </div>
        </>
      )}
    </main>
  );
}

export default function Page() {
  return (
    <Suspense>
      <Consent />
    </Suspense>
  );
}
