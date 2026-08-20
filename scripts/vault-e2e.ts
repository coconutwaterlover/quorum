/**
 * Full lifecycle of the real vaults, on Shannon, with real transactions:
 *
 *   faucet -> deposit while OPEN -> keeper deploys & buys -> window settles ->
 *   keeper redeems, returns, settles the epoch -> queue a deposit mid-epoch ->
 *   withdraw everything.
 *
 * Needs: DEPLOYER_KEY (acts as the user), NEXT_PUBLIC_QUP_ADDRESS,
 * QUORUM_EXEC_UP_KEY (for the keeper) — all in .env.local.
 *
 *   npx tsx scripts/vault-e2e.ts
 */
import { createPublicClient, createWalletClient, defineChain, formatUnits, http, parseUnits, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { keeperTick } from "../src/somnia/vaults";
import { quorumVaultAbi } from "../src/somnia/vaultAbi";

const RPC = "https://api.infra.testnet.somnia.network";
const shannon = defineChain({
  id: 50312, name: "Somnia Shannon",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } }, testnet: true,
});
const TEST_USDC = "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E" as Address;
const erc20 = [
  { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "faucet", type: "function", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
] as const;

const VAULT = process.env.NEXT_PUBLIC_QUP_ADDRESS as Address;
const userKey = process.env.DEPLOYER_KEY as Hex;
if (!VAULT || !userKey) throw new Error("need NEXT_PUBLIC_QUP_ADDRESS and DEPLOYER_KEY");

const publicClient = createPublicClient({ chain: shannon, transport: http(RPC) });
const user = createWalletClient({ account: privateKeyToAccount(userKey), chain: shannon, transport: http(RPC) });
const me = user.account.address;
const stamp = () => new Date().toISOString().slice(11, 19);
const log = (m: string) => console.log(`${stamp()}  ${m}`);

async function tx(params: Parameters<typeof user.writeContract>[0]) {
  const hash = await user.writeContract(params);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status === "reverted") throw new Error(`reverted: ${hash}`);
  return receipt;
}
const read = <T,>(functionName: string) =>
  publicClient.readContract({ address: VAULT, abi: quorumVaultAbi, functionName } as never) as Promise<T>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function tick(label: string) {
  log(`keeper: ${label}`);
  for (const a of await keeperTick()) log(`  [${a.vault}] ${a.action}: ${a.detail}`);
}

// 1. money
await tx({ address: TEST_USDC, abi: erc20, functionName: "faucet", args: [parseUnits("1000", 6)] });
await tx({ address: TEST_USDC, abi: erc20, functionName: "approve", args: [VAULT, parseUnits("1000000", 6)] });
log("faucet + approve done");

// 2. deposit while OPEN (settle first if a previous run left it deployed)
if (Number(await read<bigint>("phase")) !== 0) {
  log("vault deployed from a previous run — waiting for the keeper to settle it");
  while (Number(await read<bigint>("phase")) !== 0) { await tick("settle sweep"); await sleep(20_000); }
}
await tx({ address: VAULT, abi: quorumVaultAbi, functionName: "deposit", args: [parseUnits("100", 6)] });
const shares = await publicClient.readContract({ address: VAULT, abi: quorumVaultAbi, functionName: "balanceOf", args: [me] });
log(`deposited 100 -> hold ${formatUnits(shares, 6)} QUP (price ${formatUnits(await read<bigint>("openPrice"), 18)})`);

// 3. keeper deploys and buys
await tick("deploy + buy");
log(`phase now ${Number(await read<bigint>("phase")) === 1 ? "DEPLOYED" : "OPEN"}`);

// 4. mid-epoch queue: request another 25
if (Number(await read<bigint>("phase")) === 1) {
  await tx({ address: VAULT, abi: quorumVaultAbi, functionName: "requestDeposit", args: [parseUnits("25", 6)] });
  log("queued 25 for the next settle");
}

// 5. wait out the window, keeper settles
log("waiting for the 15m windows to resolve…");
const deadline = Date.now() + 25 * 60 * 1000;
while (Date.now() < deadline) {
  await sleep(45_000);
  await tick("sweep");
  if (Number(await read<bigint>("phase")) === 0) break;
}
const epoch = await read<bigint>("epoch");
const price = await read<bigint>("lastSettlePrice");
const sharesAfter = await publicClient.readContract({ address: VAULT, abi: quorumVaultAbi, functionName: "balanceOf", args: [me] });
log(`epoch ${epoch} settled at ${formatUnits(price, 18)} — now hold ${formatUnits(sharesAfter, 6)} QUP`);

// 6. withdraw everything at the flat price
const before = await publicClient.readContract({ address: TEST_USDC, abi: erc20, functionName: "balanceOf", args: [me] });
await tx({ address: VAULT, abi: quorumVaultAbi, functionName: "withdraw", args: [sharesAfter] });
const after = await publicClient.readContract({ address: TEST_USDC, abi: erc20, functionName: "balanceOf", args: [me] });
log(`withdrew ${formatUnits(sharesAfter, 6)} QUP -> ${formatUnits(after - before, 6)} tUSDC. Done.`);
process.exit(0);
