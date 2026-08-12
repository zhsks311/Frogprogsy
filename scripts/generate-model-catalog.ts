import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { generateModelCatalog } from "../src/model-catalog-generator";

type CliOptions = {
  sourceCommit: string;
  generatedAt: string;
  outputPath: string;
  check: boolean;
};

function parseArguments(arguments_: string[]): CliOptions {
  let sourceCommit: string | undefined;
  let generatedAt: string | undefined;
  let outputPath: string | undefined;
  let check = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--check") {
      check = true;
      continue;
    }

    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${argument}`);
    }
    index += 1;

    if (argument === "--source-commit") {
      sourceCommit = value;
    } else if (argument === "--generated-at") {
      generatedAt = value;
    } else if (argument === "--out") {
      outputPath = value;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (sourceCommit === undefined) {
    throw new Error("Missing required argument: --source-commit <40-char-sha>");
  }
  if (generatedAt === undefined) {
    throw new Error("Missing required argument: --generated-at <ISO-8601>");
  }
  if (outputPath === undefined) {
    throw new Error("Missing required argument: --out <path>");
  }

  return { sourceCommit, generatedAt, outputPath, check };
}

async function run(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const document = generateModelCatalog({
    sourceCommit: options.sourceCommit,
    generatedAt: options.generatedAt,
  });
  const bytes = `${JSON.stringify(document, null, 2)}\n`;

  if (options.check) {
    let currentBytes: string;
    try {
      currentBytes = await readFile(options.outputPath, "utf8");
    } catch {
      console.error(`Model catalog is missing: ${options.outputPath}`);
      process.exitCode = 1;
      return;
    }
    if (currentBytes !== bytes) {
      console.error(`Model catalog is stale: ${options.outputPath}`);
      process.exitCode = 1;
    }
    return;
  }

  const temporaryPath = `${options.outputPath}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, bytes, "utf8");
    await rename(temporaryPath, options.outputPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

run().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
