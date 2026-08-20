import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./env.mjs";

const require = createRequire(import.meta.url);
const solc = require("solc");

/** Resolve `@somnia-chain/...` style imports out of node_modules. */
function readImport(path) {
  const candidates = [join(ROOT, "contracts", path), join(ROOT, "node_modules", path), join(ROOT, path)];
  for (const c of candidates) {
    if (existsSync(c)) return { contents: readFileSync(c, "utf8") };
  }
  return { error: `File not found: ${path}` };
}

/**
 * Compile one contract file and return { abi, bytecode }.
 * `entry` is relative to contracts/, e.g. "DeskArena.sol".
 */
export function compile(entry, contractName) {
  const source = readFileSync(join(ROOT, "contracts", entry), "utf8");
  const input = {
    language: "Solidity",
    sources: { [entry]: { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: false,
      outputSelection: { "*": { "*": ["abi", "evm.bytecode"] } },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: readImport }));
  const fatal = (output.errors ?? []).filter((e) => e.severity === "error");
  if (fatal.length) {
    throw new Error(fatal.map((e) => e.formattedMessage).join("\n"));
  }
  const warnings = (output.errors ?? []).filter((e) => e.severity === "warning");
  for (const w of warnings) {
    if (/SPDX|Unused|shadow/i.test(w.formattedMessage ?? "")) continue;
    console.warn(w.formattedMessage.trim());
  }
  const artifact = output.contracts?.[entry]?.[contractName];
  if (!artifact) throw new Error(`${contractName} not found in ${entry}`);
  const bytecode = `0x${artifact.evm.bytecode.object}`;
  if (bytecode === "0x") throw new Error(`${contractName} compiled to empty bytecode`);
  return { abi: artifact.abi, bytecode };
}
