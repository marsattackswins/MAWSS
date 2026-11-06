import { MAWS } from "@/lib/maws/brand";

export type BrokerId = "binance" | "okx";

export type Broker = {
  id: BrokerId;
  name: string;
  tagline: string;
  rating: number | null;
  badge: "featured" | "beta" | null;
  enabled: boolean;
};

/** Add or edit brokers here. Connect adapters in `connectBroker`. */
export const BROKERS: Broker[] = [
  {
    id: "binance",
    name: "Binance",
    tagline: `USDT-M futures via the ${MAWS} server`,
    rating: 4.2,
    badge: null,
    enabled: true,
  },
  {
    id: "okx",
    name: "OKX",
    tagline: "Spot and perpetual swaps",
    rating: 4.6,
    badge: null,
    enabled: false,
  },
];

export function brokerById(id: BrokerId) {
  return BROKERS.find((b) => b.id === id) ?? null;
}

export async function connectBroker(id: BrokerId): Promise<void> {
  const broker = brokerById(id);
  if (!broker?.enabled) return;
  if (id === "binance") {
    const { connectLiveBroker } = await import("@/lib/live/bridge");
    await connectLiveBroker();
  }
}
