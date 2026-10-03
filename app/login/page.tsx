"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";

function Login() {
  const params = useSearchParams();
  const redirect = params.get("redirect");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    let { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error?.message.toLowerCase().includes("invalid login")) {
      // first time here: create the account (email confirmation is off for the demo)
      ({ error } = await supabase.auth.signUp({ email, password }));
    }
    if (error) {
      setError(error.message);
      setBusy(false);
      return;
    }
    // only follow same-origin redirects (resolve the URL, don't trust string prefixes like "/\evil.com")
    let target = "/";
    try {
      const u = new URL(redirect ?? "/me", window.location.origin);
      if (u.origin === window.location.origin) target = u.pathname + u.search + u.hash;
    } catch {}
    window.location.href = target;
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-[420px] flex-col justify-center gap-8 px-4 py-16">
      <div className="flex items-center gap-2.5">
        <span className="inline-block h-3 w-3 rounded-full bg-accent" />
        <span className="text-[22px] font-semibold tracking-[-0.02em]">fixnet</span>
      </div>
      <h1 className="m-0 text-[34px] leading-[1.1] font-semibold tracking-[-0.03em]">Sign in to connect your agent</h1>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="text-muted">Email</span>
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="min-h-11 rounded-lg border border-line px-3 text-base outline-none focus:border-ink" />
        </label>
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="text-muted">Password</span>
          <input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} className="min-h-11 rounded-lg border border-line px-3 text-base outline-none focus:border-ink" />
        </label>
        {error && <p className="m-0 text-sm text-soft">{error}</p>}
        <button type="submit" disabled={busy} className="min-h-11 rounded-lg bg-ink px-5 text-sm font-medium text-bg disabled:opacity-50">
          {busy ? "Signing in…" : "Continue"}
        </button>
        <p className="m-0 text-[13px] text-muted">New here? The same form creates your account.</p>
      </form>
    </main>
  );
}

export default function Page() {
  return (
    <Suspense>
      <Login />
    </Suspense>
  );
}
