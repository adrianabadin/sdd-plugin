import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(projectRoot, "src", "generated", "prisma", "package.json");
const destinationDirectory = path.join(projectRoot, "dist", "generated", "prisma");

mkdirSync(destinationDirectory, { recursive: true });
function copyRuntimeFiles(sourceDirectory, destinationDirectory) {
  mkdirSync(destinationDirectory, { recursive: true });
  for (const entry of readdirSync(sourceDirectory)) {
    const sourcePath = path.join(sourceDirectory, entry);
    const destinationPath = path.join(destinationDirectory, entry);
    if (statSync(sourcePath).isDirectory()) {
      copyRuntimeFiles(sourcePath, destinationPath);
      continue;
    }
    if (/\.(?:js|d\.ts|mjs|wasm)$/.test(entry)) {
      copyFileSync(sourcePath, destinationPath);
    }
  }
}

copyRuntimeFiles(path.dirname(source), destinationDirectory);
const packageJson = JSON.parse(readFileSync(source, "utf8"));
packageJson.type = "commonjs";
writeFileSync(path.join(destinationDirectory, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
