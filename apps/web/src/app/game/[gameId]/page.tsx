import { GameClient } from "./game-client";

export default async function GamePage({
  params,
  searchParams,
}: {
  params: Promise<{ gameId: string }>;
  searchParams: Promise<{ observe?: string }>;
}) {
  const { gameId } = await params;
  const sp = await searchParams;
  return <GameClient gameId={gameId} observe={sp.observe === "1"} />;
}
