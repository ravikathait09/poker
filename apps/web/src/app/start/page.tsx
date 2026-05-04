"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function StartPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const trimmedEmail = email.trim();
      const body: { username: string; email?: string } = {
        username: username.trim() || "Host",
      };
      if (trimmedEmail) body.email = trimmedEmail;
      const res = await fetch("/api/games", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as {
        gameId?: string;
        error?: string;
      };
      if (!res.ok) {
        setError(data.error ?? "Could not create game");
        return;
      }
      const { token, gameId } = data as { token: string; gameId: string };
      sessionStorage.setItem(`ganga_host_${gameId}`, token);
      router.push(`/game/${gameId}`);
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto max-w-md px-6 py-16">
      <h1 className="text-2xl font-semibold text-white">Start a game</h1>
      <p className="mt-2 text-slate-400">
        Choose a host name. You&apos;ll get a shareable link for players.
      </p>
      <form onSubmit={onSubmit} className="mt-8 space-y-4">
        <label className="block text-sm text-slate-400">
          Host username
          <input
            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-white outline-none focus:border-emerald-500"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="e.g. Rhea"
            maxLength={32}
          />
        </label>
        <label className="block text-sm text-slate-400">
          Email (optional)
          <input
            type="email"
            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-white outline-none focus:border-emerald-500"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            maxLength={120}
          />
          <span className="mt-1 block text-[11px] text-slate-500">
            Used so you can find your past games and stats in your history.
          </span>
        </label>
        {error ? <p className="text-sm text-red-400">{error}</p> : null}
        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-lg bg-emerald-500 py-3 font-medium text-slate-950 disabled:opacity-60"
        >
          {loading ? "Creating…" : "Create room"}
        </button>
      </form>
    </main>
  );
}
