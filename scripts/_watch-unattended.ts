// @ts-nocheck — throwaway observer, run with tsx only
/**
 * READ-ONLY watcher. It sends nothing — the whole point is to observe the
 * chain driving the vaults with no help: MarketCreated events feeding windows,
 * the heartbeat firing runEpoch, epochs settling on their own.
 */
import { createPublicClient, defineChain, http, formatUnits } from "viem";
const { compile } = await import("./lib/compile.mjs");
const vaultAbi = compile("QuorumVaultV3.sol", "QuorumVaultV3").abi;
const brainAbi = compile("QuorumBrain.sol", "QuorumBrain").abi;
const RPC = "https://api.infra.testnet.somnia.network";
const shannon = defineChain({ id: 50312, name: "S", nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain: shannon, transport: http(RPC) });
const BRAIN = "0x10134e4ffc3dce9c21b4c749a4b230e353b05d97" as const;
const VAULTS = { QUP: "0x399188fa159469a6ab9b93d7419b5b44a40fc196", QDWN: "0xdf816f7cb8f9afa17f2b3f2eae3d48df59888f11" } as const;

let last = "";
const deadline = Date.now() + 55 * 60 * 1000;
while (Date.now() < deadline) {
  try {
    const [fires, fed, armedFor] = await Promise.all([
      pub.readContract({ address: BRAIN, abi: brainAbi, functionName: "fireCount" } as never),
      pub.readContract({ address: BRAIN, abi: brainAbi, functionName: "windowsFed" } as never),
      pub.readContract({ address: BRAIN, abi: brainAbi, functionName: "armedForMs" } as never),
    ]);
    const parts: string[] = [`brain fires=${fires} windowsFed=${fed} armedFor=${new Date(Number(armedFor)).toISOString().slice(11, 19)}`];
    let settledBoth = 0;
    for (const [name, addr] of Object.entries(VAULTS)) {
      const [phase, epoch, cash, price, wc] = await Promise.all([
        pub.readContract({ address: addr as never, abi: vaultAbi, functionName: "phase" } as never),
        pub.readContract({ address: addr as never, abi: vaultAbi, functionName: "epoch" } as never),
        pub.readContract({ address: addr as never, abi: vaultAbi, functionName: "cash" } as never),
        pub.readContract({ address: addr as never, abi: vaultAbi, functionName: "lastSettlePrice" } as never),
        pub.readContract({ address: addr as never, abi: vaultAbi, functionName: "windowCount" } as never),
      ]);
      if (Number(epoch) >= 1) settledBoth++;
      parts.push(`${name}: ${Number(phase) === 0 ? "OPEN" : "DEPLOYED"} epoch=${epoch} cash=${formatUnits(cash as bigint, 6)} lastPrice=${(price as bigint) === 0n ? "-" : Number(formatUnits(price as bigint, 18)).toFixed(4)} windows=${wc}`);
    }
    const line = parts.join(" | ");
    if (line !== last) {
      console.log(new Date().toISOString().slice(11, 19), line);
      last = line;
    }
    if (settledBoth === 2) {
      console.log("BOTH VAULTS COMPLETED AN UNATTENDED EPOCH — self-driving confirmed");
      break;
    }
  } catch (e) {
    console.log("read hiccup:", String((e as Error).message).slice(0, 80));
  }
  await new Promise((r) => setTimeout(r, 30_000));
}
process.exit(0);
