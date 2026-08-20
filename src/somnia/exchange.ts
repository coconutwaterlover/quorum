/**
 * The one place a `SomniaMarkets` instance is built.
 *
 * Everything here is server-only: the SDK never reaches the browser bundle, so
 * the UI talks to API routes and no wallet key or RPC socket lives in the page.
 * Two exchanges are cached — a read-only one used by every request, and a
 * signing one that only exists when trading has been explicitly switched on.
 */

import { SomniaMarkets, SOMNIA_MAINNET_ADDRESSES, SOMNIA_TESTNET_ADDRESSES } from "@somnia-chain/markets-sdk";
import { somniaMainnet, somniaShannon } from "@somnia-chain/markets-sdk/chains";

export type Network = "testnet" | "mainnet";

export interface VenueConfig {
  readonly network: Network;
  readonly indexerUrl: string;
  readonly wsRpcUrl: string;
  /**
   * The venue to trade. A deployment hosts several side by side and the indexer
   * returns all of them together, so an unscoped app quotes markets it never
   * meant to. Default is the rolling "closes at or above its opening price"
   * venue — the actual event-contract product.
   */
  readonly venueId: string;
  readonly collateralLabel: string;
  readonly explorer: string;
}

const TESTNET: VenueConfig = {
  network: "testnet",
  indexerUrl: "https://dev.smk.somnia.host/v1/graphql",
  wsRpcUrl: "wss://api.infra.testnet.somnia.network/ws",
  venueId: "0x679795a0195a1b76cdebb7c51d74e058aee92919b8c3389af86ef24535e8a28c",
  collateralLabel: "tUSDC",
  explorer: "https://shannon-explorer.somnia.network",
};

const MAINNET: VenueConfig = {
  network: "mainnet",
  indexerUrl: "https://prd.smk.somnia.host/v1/graphql",
  wsRpcUrl: "wss://api.infra.mainnet.somnia.network/ws",
  venueId: "",
  collateralLabel: "USDso",
  explorer: "https://explorer.somnia.network",
};

export function venueConfig(): VenueConfig {
  const network: Network = process.env.QUORUM_NETWORK === "mainnet" ? "mainnet" : "testnet";
  const base = network === "mainnet" ? MAINNET : TESTNET;
  return {
    ...base,
    indexerUrl: process.env.QUORUM_INDEXER_URL || base.indexerUrl,
    wsRpcUrl: process.env.QUORUM_WS_RPC_URL || base.wsRpcUrl,
    // An empty venue id means "every venue the indexer knows", which is a
    // deliberate escape hatch, not the default.
    venueId: process.env.QUORUM_VENUE_ID ?? base.venueId,
  };
}

function addresses(network: Network) {
  return network === "mainnet" ? SOMNIA_MAINNET_ADDRESSES : SOMNIA_TESTNET_ADDRESSES;
}

function chain(network: Network) {
  return network === "mainnet" ? somniaMainnet : somniaShannon;
}

let reader: SomniaMarkets | null = null;

export function readExchange(): SomniaMarkets {
  if (reader) return reader;
  const cfg = venueConfig();
  reader = new SomniaMarkets({
    indexerUrl: cfg.indexerUrl,
    chain: chain(cfg.network),
    wsRpcUrl: cfg.wsRpcUrl,
    addresses: addresses(cfg.network),
  });
  return reader;
}

export interface TradingMode {
  readonly enabled: boolean;
  /** Why trading is off, for the UI to state plainly instead of failing quietly. */
  readonly reason: string | null;
  /** Hard ceiling on the collateral one request may commit. */
  readonly maxStake: number;
}

export function tradingMode(): TradingMode {
  const key = process.env.QUORUM_PRIVATE_KEY;
  const allowed = process.env.QUORUM_ALLOW_TRADING === "1";
  const maxStake = Number(process.env.QUORUM_MAX_STAKE ?? 25);
  if (!allowed) {
    return { enabled: false, reason: "QUORUM_ALLOW_TRADING is not set to 1", maxStake };
  }
  if (!key) return { enabled: false, reason: "QUORUM_PRIVATE_KEY is not set", maxStake };
  return { enabled: true, reason: null, maxStake };
}

let signer: SomniaMarkets | null = null;

/** The signing exchange, or null when trading is off. Never throws on absence. */
export function signerExchange(): SomniaMarkets | null {
  if (!tradingMode().enabled) return null;
  if (signer) return signer;
  const cfg = venueConfig();
  signer = new SomniaMarkets({
    indexerUrl: cfg.indexerUrl,
    chain: chain(cfg.network),
    wsRpcUrl: cfg.wsRpcUrl,
    addresses: addresses(cfg.network),
    privateKey: process.env.QUORUM_PRIVATE_KEY as `0x${string}`,
  });
  return signer;
}

export function collateralAddress(): `0x${string}` {
  return addresses(venueConfig().network).collateral as `0x${string}`;
}
