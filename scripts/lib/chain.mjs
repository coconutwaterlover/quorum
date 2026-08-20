import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadEnv } from "./env.mjs";

loadEnv();

export const RPC = process.env.NEXT_PUBLIC_SOMNIA_RPC_URL ?? "https://api.infra.testnet.somnia.network";

export const shannon = defineChain({
  id: 50312,
  name: "Somnia Shannon",
  nativeCurrency: { name: "Somnia Test Token", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
  blockExplorers: {
    default: { name: "Shannon Explorer", url: "https://shannon-explorer.somnia.network" },
  },
  testnet: true,
});

export const publicClient = createPublicClient({ chain: shannon, transport: http(RPC) });

export function walletFor(privateKey) {
  const key = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
  const account = privateKeyToAccount(key);
  return createWalletClient({ account, chain: shannon, transport: http(RPC) });
}

export function explorerTx(hash) {
  return `${shannon.blockExplorers.default.url}/tx/${hash}`;
}

export function explorerAddress(address) {
  return `${shannon.blockExplorers.default.url}/address/${address}`;
}

/** Sequential sends from one key: read the pending nonce each time and wait for the receipt. */
export async function send(wallet, params) {
  const nonce = await publicClient.getTransactionCount({
    address: wallet.account.address,
    blockTag: "pending",
  });
  const hash = await wallet.writeContract({ ...params, nonce });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status === "reverted") throw new Error(`reverted: ${hash}`);
  return { hash, receipt };
}
