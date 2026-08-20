import { compile } from "./lib/compile.mjs";

const { abi, bytecode } = compile("QuorumVault.sol", "QuorumVault");
const size = (bytecode.length - 2) / 2;
console.log(`QuorumVault ${size} bytes (${size > 24576 ? "OVER EIP-170 LIMIT" : "ok"}), ${abi.length} abi entries`);
