import Link from "next/link";

export default function HomePage() {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-10 px-6 py-16">
      <header className="space-y-2">
        <p className="text-sm uppercase tracking-widest text-emerald-400/90">
          Ganga Poker
        </p>
        <h1 className="text-4xl font-semibold text-white">
          Host tables. Approve guests. Play Hold&apos;em in real time.
        </h1>
        <p className="text-lg text-slate-400">
          Create a room, share one link, and run a fair, server-shuffled game
          with seats, a ledger, and an optional admin audit trail.
        </p>
      </header>

      <div className="flex flex-wrap gap-3">
        <Link
          href="/start"
          className="rounded-lg bg-emerald-500 px-6 py-3 font-medium text-slate-950 shadow-lg shadow-emerald-500/20 transition hover:bg-emerald-400"
        >
          Start game
        </Link>
        <Link
          href="/admin"
          className="rounded-lg border border-slate-700 px-6 py-3 font-medium text-slate-200 hover:border-slate-500"
        >
          Admin
        </Link>
      </div>

      <section className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900/60 p-8">
        <h2 className="text-xl font-medium text-white">About the platform</h2>
        <ul className="list-inside list-disc space-y-2 text-slate-300">
          <li>
            <strong>Hosts</strong> spin up a table, control seats, and start
            hands when the table is ready.
          </li>
          <li>
            <strong>Guests</strong> request to join over the live socket—hosts
            approve or reject in real time.
          </li>
          <li>
            <strong>Admins</strong> can inspect audit logs, ledger lines, and
            open a read-only observer feed of any active game.
          </li>
        </ul>
      </section>
    </main>
  );
}
