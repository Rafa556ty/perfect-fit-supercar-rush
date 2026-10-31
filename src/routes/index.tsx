import { createFileRoute } from "@tanstack/react-router";
import { RacingGame } from "@/components/RacingGame";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Revuelto Rodovia — Jogo de Corrida" },
      {
        name: "description",
        content: "Pilote uma Lamborghini Revuelto preta pela rodovia. Acelere, freie e desvie do trânsito.",
      },
      { property: "og:title", content: "Revuelto Rodovia — Jogo de Corrida" },
      {
        property: "og:description",
        content: "Pilote uma Lamborghini Revuelto preta pela rodovia. Acelere, freie e desvie do trânsito.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: RacingGame,
});
