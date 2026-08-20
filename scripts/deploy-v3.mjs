/**
 * Deploy the self-driving trio: QUP v3, QDWN v3, and the QuorumBrain that
 * feeds and wakes them. Then fund the brain's 32 STT reactivity bond and arm
 * both subscriptions.
 *
 *   DEPLOYER_KEY=0x… node scripts/deploy-v3.mjs
 *
 * Gas reality on Somnia: deploying this 13KB contract genuinely costs ~42M gas
 * (~0.3 STT) — trust the node's estimate; a hand-pinned "sane" limit is an
 * out-of-gas revert that still burns the whole limit. The node occasionally
 * rejects a send with "Missing or invalid parameters"; that is transient, so
 * every send retries.
 */
import { parseEther, formatEther } from "viem";
import { compile } from "./lib/compile.mjs";
import { publicClient, walletFor } from "./lib/chain.mjs";

const TEST_USDC = "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E";
const MODULE = "0x3ecC694Cef705358864a646142ac17A90E29e388";
const OUTCOME_TOKEN = "0xB52c5934113Af5c0Bb20eb3C72290C8215f755b9";
const CREATOR_15M = "0x94d963b6670ab96e78c8d0c46ca35d196d606efe";
const BOND = parseEther("33");

const wallet = walletFor(process.env.DEPLOYER_KEY);
const balance = await publicClient.getBalance({ address: wallet.account.address });
console.log(`deployer ${wallet.account.address}: ${formatEther(balance)} STT`);
if (balance < parseEther("35")) {
  console.error("need ~40 STT: three ~0.3 STT deploys, the 33 STT brain bond, and headroom");
  process.exit(1);
}

async function withRetry(label, fn) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const message = String(error?.message ?? error);
      if (!/Missing or invalid parameters|nonce/i.test(message) || attempt === 5) throw error;
      console.log(`${label}: node rejected the send (attempt ${attempt}), retrying…`);
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }
}

async function deploy(file, name, args, label) {
  const { abi, bytecode } = compile(file, name);
  const receipt = await withRetry(label, async () => {
    const hash = await wallet.deployContract({ abi, bytecode, args });
    const r = await publicClient.waitForTransactionReceipt({ hash });
    if (r.status === "reverted") throw new Error(`${label} reverted`);
    return r;
  });
  console.log(`${label} -> ${receipt.contractAddress} (gas ${receipt.gasUsed})`);
  return { address: receipt.contractAddress, abi };
}

async function write(target, functionName, args, label, value) {
  return withRetry(label, async () => {
    const hash = await wallet.writeContract({ address: target.address, abi: target.abi, functionName, args, value });
    const r = await publicClient.waitForTransactionReceipt({ hash });
    if (r.status === "reverted") throw new Error(`${label} reverted`);
    console.log(`${label}: ok`);
    return r;
  });
}

const up = await deploy("QuorumVaultV3.sol", "QuorumVaultV3", [TEST_USDC, MODULE, OUTCOME_TOKEN, true, "Quorum Up", "QUP"], "QUP v3");
const down = await deploy("QuorumVaultV3.sol", "QuorumVaultV3", [TEST_USDC, MODULE, OUTCOME_TOKEN, false, "Quorum Down", "QDWN"], "QDWN v3");
const brain = await deploy("QuorumBrain.sol", "QuorumBrain", [CREATOR_15M, up.address, down.address], "QuorumBrain");

await write(up, "setBrain", [brain.address], "QUP.setBrain");
await write(down, "setBrain", [brain.address], "QDWN.setBrain");
await write(up, "depositFree", [100_000_000n], "seed QUP 100");
await write(down, "depositFree", [100_000_000n], "seed QDWN 100");

// The bond that makes it self-driving, then both subscriptions.
await write(brain, "fund", [], "fund brain 33 STT", BOND);
await write(brain, "armEvents", [], "arm MarketCreated subscription");
await write(brain, "rearm", [], "arm quarter-hour heartbeat");

console.log("\nenv updates:");
console.log(`NEXT_PUBLIC_QUP_ADDRESS=${up.address}`);
console.log(`NEXT_PUBLIC_QDWN_ADDRESS=${down.address}`);
console.log(`NEXT_PUBLIC_BRAIN_ADDRESS=${brain.address}`);
console.log("deployer STT left:", formatEther(await publicClient.getBalance({ address: wallet.account.address })));
