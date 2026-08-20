/**
 * Deploy QUP and QDWN to Somnia Shannon and gas up the two executor keys.
 *
 *   DEPLOYER_KEY=0x… EXEC_UP=0x…addr EXEC_DOWN=0x…addr node scripts/deploy-vaults.mjs
 *
 * The deployer needs ~5 STT: two contract creations plus two small STT
 * transfers so each executor can pay its own keeper gas.
 */
import { parseEther, formatEther } from "viem";
import { compile } from "./lib/compile.mjs";
import { publicClient, walletFor, send, explorerAddress } from "./lib/chain.mjs";

const TEST_USDC = "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E"; // Shannon faucet tUSDC

const deployerKey = process.env.DEPLOYER_KEY;
const execUp = process.env.EXEC_UP;
const execDown = process.env.EXEC_DOWN;
if (!deployerKey || !execUp || !execDown) {
  console.error("need DEPLOYER_KEY, EXEC_UP, EXEC_DOWN");
  process.exit(1);
}

const wallet = walletFor(deployerKey);
const balance = await publicClient.getBalance({ address: wallet.account.address });
console.log(`deployer ${wallet.account.address} holds ${formatEther(balance)} STT`);
if (balance < parseEther("4")) {
  console.error("fund the deployer with at least 5 STT first");
  process.exit(1);
}

const { abi, bytecode } = compile("QuorumVault.sol", "QuorumVault");

async function deploy(isUp, operator, name, symbol) {
  const hash = await wallet.deployContract({
    abi,
    bytecode,
    args: [TEST_USDC, isUp, operator, name, symbol],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status === "reverted") throw new Error(`${symbol} deploy reverted`);
  console.log(`${symbol} -> ${receipt.contractAddress}  (${explorerAddress(receipt.contractAddress)})`);
  return receipt.contractAddress;
}

const qup = await deploy(true, execUp, "Quorum Up", "QUP");
const qdwn = await deploy(false, execDown, "Quorum Down", "QDWN");

// Executor gas: each key signs deployFunds/settleEpoch/orders every epoch.
for (const [label, to] of [["execUp", execUp], ["execDown", execDown]]) {
  const hash = await wallet.sendTransaction({ to, value: parseEther("1.5") });
  await publicClient.waitForTransactionReceipt({ hash });
  console.log(`gassed ${label} ${to} with 1.5 STT`);
}

console.log("\nenv for .env.local and Vercel:");
console.log(`NEXT_PUBLIC_QUP_ADDRESS=${qup}`);
console.log(`NEXT_PUBLIC_QDWN_ADDRESS=${qdwn}`);
