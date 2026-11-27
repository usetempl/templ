import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const sourcePath = new URL(
  "../../../packages/chat/src/client.ts",
  import.meta.url,
);
export const assetPath = new URL("../public/agent-client.mjs", import.meta.url);
const helper = (name) =>
  new URL(`../../../packages/chat/src/${name}.ts`, import.meta.url);
/** Inlined in this order: a helper may import only "viem" and helpers listed before it. */
export const dependencyPaths = {
  "./chains": helper("chains"),
  "./knowledge": helper("knowledge"),
  "./solana": helper("solana"),
  "./plans": helper("plans"),
  "./standard-plan": helper("standard-plan"),
  "./resolution-pricing": helper("resolution-pricing"),
  "./resolution-copy": helper("resolution-copy"),
  "./moderation-permissions": helper("moderation-permissions"),
  "./principal": helper("principal"),
  "./support": helper("support"),
  "./support-citations": helper("support-citations"),
  "./support-ai-interactions": helper("support-ai-interactions"),
  "./support-drafts": helper("support-drafts"),
  "./agent-api": helper("agent-api"),
  "./appearance": helper("appearance"),
  "./safety": helper("safety"),
  "./profiles": helper("profiles"),
  "./bots": helper("bots"),
  "./events": helper("events"),
  "./wallets": helper("wallets"),
  "./search": helper("search"),
  "./audit": helper("audit"),
  "./reactions": helper("reactions"),
};
const allowedImports = new Set(["node:crypto", "viem", "viem/siwe"]);
/** Top-level names every inlined piece declares; a repeat would shadow or break at load. */
function declaredNames(tree) {
  const names = [];
  for (const statement of tree.statements) {
    if (
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement)
    ) {
      if (statement.name) names.push(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name))
          names.push(declaration.name.text);
    }
  }
  return names;
}

/** Deterministic inclusion of reviewed local helpers; no environment or dependency discovery. */
export function generateAgentClient(source = readFileSync(sourcePath, "utf8")) {
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  const seen = new Set();
  const inlined = [];
  const strip = (input, name, dependency = false) => {
    const tree = ts.createSourceFile(
      name,
      input,
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TS,
    );
    const statements = tree.statements.filter((statement) => {
      if (!ts.isImportDeclaration(statement)) return true;
      const path = statement.moduleSpecifier;
      if (!ts.isStringLiteral(path))
        throw new Error("Unexpected runtime dependency.");
      // Type-only imports carry no runtime dependency and are erased.
      if (statement.importClause?.isTypeOnly) return false;
      if (path.text in dependencyPaths) {
        if (dependency && !inlined.includes(path.text))
          throw new Error(
            `Helper ${name} imports ${path.text} before it is inlined.`,
          );
        return false;
      }
      if (dependency && path.text !== "viem")
        throw new Error("Unexpected helper dependency.");
      return true;
    });
    for (const declared of declaredNames(tree)) {
      if (seen.has(declared))
        throw new Error(`Name ${declared} is declared twice across helpers.`);
      seen.add(declared);
    }
    return printer.printFile(ts.factory.updateSourceFile(tree, statements));
  };
  const dependencies = Object.entries(dependencyPaths).map(([name, path]) => {
    const input = readFileSync(path, "utf8");
    const output = strip(input, `${name}.ts`, true);
    inlined.push(name);
    return { name, input, output };
  });
  const combined = `${dependencies.map((item) => item.output).join("\n")}\n${strip(source, "client.ts")}`;
  const result = ts.transpileModule(combined, {
    fileName: "client.ts",
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      newLine: ts.NewLineKind.LineFeed,
      sourceMap: false,
      inlineSourceMap: false,
      removeComments: false,
    },
  });
  if (
    result.diagnostics?.some(
      (item) => item.category === ts.DiagnosticCategory.Error,
    )
  ) {
    throw new Error("The agent client source did not transpile.");
  }
  const parsed = ts.createSourceFile(
    "agent-client.mjs",
    result.outputText,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.JS,
  );
  const imports = parsed.statements.filter(ts.isImportDeclaration);
  const importedModules = new Set(
    imports.map((item) =>
      ts.isStringLiteral(item.moduleSpecifier)
        ? item.moduleSpecifier.text
        : null,
    ),
  );
  if (
    importedModules.size !== allowedImports.size ||
    imports.some(
      (item) =>
        !ts.isStringLiteral(item.moduleSpecifier) ||
        !allowedImports.has(item.moduleSpecifier.text),
    )
  ) {
    throw new Error("The agent client has an unexpected runtime dependency.");
  }
  const digest = createHash("sha256").update(source).digest("hex");
  return `// Generated from packages/chat/src/client.ts. Do not edit this file.\n// Source SHA-256: ${digest}\n${dependencies.map((item) => `// ${item.name} SHA-256: ${createHash("sha256").update(item.input).digest("hex")}`).join("\n")}\n// TypeScript ${ts.version}; ES2022 / ESNext. Regenerate: node apps/web/scripts/generate-agent-client.mjs\n${result.outputText}`;
}

export function checkAgentClient(
  source = readFileSync(sourcePath, "utf8"),
  asset = readFileSync(assetPath, "utf8"),
) {
  if (asset !== generateAgentClient(source)) {
    throw new Error(
      "agent-client.mjs is stale. Run node apps/web/scripts/generate-agent-client.mjs.",
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (
    process.argv.length > 3 ||
    (process.argv[2] && process.argv[2] !== "--check")
  ) {
    throw new Error(
      "Usage: node apps/web/scripts/generate-agent-client.mjs [--check]",
    );
  }
  if (process.argv[2] === "--check") checkAgentClient();
  else writeFileSync(assetPath, generateAgentClient());
}
