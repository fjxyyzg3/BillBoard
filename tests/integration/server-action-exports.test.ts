import { readFileSync } from "node:fs";
import { relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const serverActionFiles = [
  "src/app/(app)/add/actions.ts",
  "src/app/(app)/records/actions.ts",
  "src/app/(app)/records/import/actions.ts",
];

function exportedRuntimeNames(sourceFile: ts.SourceFile) {
  const names: string[] = [];

  for (const statement of sourceFile.statements) {
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    const isExported = modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);

    if (!isExported) {
      continue;
    }

    if (ts.isFunctionDeclaration(statement)) {
      const isAsync = modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword);

      if (!isAsync && statement.name) {
        names.push(statement.name.text);
      }

      continue;
    }

    if (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) {
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          names.push(declaration.name.text);
        }
      }

      continue;
    }

    names.push(statement.getText(sourceFile));
  }

  return names;
}

describe("server action exports", () => {
  it("keeps use server modules limited to async runtime exports", () => {
    const invalidExports = serverActionFiles.flatMap((filePath) => {
      const source = readFileSync(filePath, "utf8");
      const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);

      return exportedRuntimeNames(sourceFile).map((name) => ({
        file: relative(process.cwd(), filePath),
        name,
      }));
    });

    expect(invalidExports).toEqual([]);
  });
});
