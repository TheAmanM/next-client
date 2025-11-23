import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { parse } from "@babel/parser";
import traverse from "@babel/traverse";

interface ModuleInfo {
  filePath: string;
  isClient: boolean;
  imports: Set<string>; // A set of absolute paths to other modules it imports
}

const moduleGraph = new Map<string, ModuleInfo>();
let isReady = false;

const clientComponentDecorationType =
  vscode.window.createTextEditorDecorationType({
    backgroundColor: "rgba(255, 0, 0, 0.2)",
    borderRadius: "2px",
    color: "rgba(255, 0, 0, 0.9)",
    dark: {
      color: "rgba(255, 100, 100, 0.9)",
    },
  });

async function scanWorkspace() {
  console.log("Starting workspace scan...");
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) {
    console.log("No workspace folders found.");
    return;
  }
  const workspaceRoot = workspaceFolders[0].uri.fsPath;

  const allJsxFiles = await vscode.workspace.findFiles(
    "**/*.{js,jsx,ts,tsx}",
    "{**/node_modules/**,**/.next/**}"
  );
  console.log(`Found ${allJsxFiles.length} files to scan.`);

  for (const fileUri of allJsxFiles) {
    const filePath = fileUri.fsPath;
    try {
      const fileContent = await fs.promises.readFile(filePath, "utf-8");
      const isClient = fileContent.substring(0, 200).includes("use client");
      if (isClient) {
        console.log(`Found "use client" in: ${filePath}`);
      }
      const imports = new Set<string>();

      const ast = parse(fileContent, {
        sourceType: "module",
        plugins: ["jsx", "typescript"],
        errorRecovery: true,
      });

      const importPromises: Promise<void>[] = [];
      traverse(ast, {
        ImportDeclaration({ node }) {
          const promise = (async () => {
            const importPath = await resolveImportPath(
              node.source.value,
              filePath,
              workspaceRoot
            );
            if (importPath) {
              imports.add(importPath);
            }
          })();
          importPromises.push(promise);
        },
      });

      await Promise.all(importPromises);

      moduleGraph.set(filePath, {
        filePath,
        isClient,
        imports,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        console.log(`File not found, skipping: ${filePath}`);
      } else {
        console.error(`Failed to process ${filePath}:`, error);
      }
    }
  }
  console.log(`Module graph created with ${moduleGraph.size} modules.`);
}

async function resolveImportPath(
  importSource: string,
  currentFilePath: string,
  workspaceRoot: string
): Promise<string | null> {
  try {
    if (importSource.startsWith(".")) {
      const absolutePath = path.resolve(
        path.dirname(currentFilePath),
        importSource
      );
      return await resolveFileExtension(absolutePath);
    }
    if (importSource.startsWith("@/")) {
      // A real implementation would read tsconfig.json for path aliases.
      const absolutePath = path.resolve(
        workspaceRoot,
        importSource.substring(2)
      );
      return await resolveFileExtension(absolutePath);
    }
  } catch (e) {
    // Ignore resolving errors
  }
  return null;
}

async function resolveFileExtension(
  absolutePath: string
): Promise<string | null> {
  const extensions = ["", ".js", ".jsx", ".ts", ".tsx"];
  // Check for file with extension
  for (const ext of extensions) {
    const pathWithExt = absolutePath + ext;
    try {
      const stats = await fs.promises.stat(pathWithExt);
      if (stats.isFile()) {
        return pathWithExt;
      }
    } catch (e) {
      // ignore
    }
  }
  // Check for index file in directory
  for (const ext of extensions) {
    const indexPath = path.join(absolutePath, "index" + ext);
    try {
      const stats = await fs.promises.stat(indexPath);
      if (stats.isFile()) {
        return indexPath;
      }
    } catch (e) {
      // ignore
    }
  }
  return null;
}

function propagateClientStatus() {
  console.log("Starting client status propagation...");
  const queue: string[] = [];
  for (const [filePath, moduleInfo] of moduleGraph.entries()) {
    if (moduleInfo.isClient) {
      queue.push(filePath);
    }
  }
  console.log(`Initial client components in queue: ${queue.length}`);

  let count = 0;
  const MAX_ITERATIONS = 10000; // Safeguard against infinite loops

  while (queue.length > 0 && count < MAX_ITERATIONS) {
    count++;
    const clientModulePath = queue.shift();
    if (!clientModulePath) {
      continue;
    }

    const moduleInfo = moduleGraph.get(clientModulePath);
    if (!moduleInfo) {
      continue;
    }

    for (const importedModulePath of moduleInfo.imports) {
      const importedModuleInfo = moduleGraph.get(importedModulePath);
      if (importedModuleInfo && !importedModuleInfo.isClient) {
        console.log(
          `Propagating client status to: ${importedModuleInfo.filePath}`
        );
        importedModuleInfo.isClient = true;
        queue.push(importedModulePath);
      }
    }
  }
  const finalClientCount = Array.from(moduleGraph.values()).filter(
    (m) => m.isClient
  ).length;
  console.log(
    `Client status propagation complete. Total client components: ${finalClientCount}`
  );
}

async function updateDecorations(editor: vscode.TextEditor | undefined) {
  if (!editor || !isReady) {
    return;
  }
  const currentFilePath = editor.document.uri.fsPath;
  const decorations: vscode.DecorationOptions[] = [];
  const fileContent = editor.document.getText();
  const workspaceRoot = vscode.workspace.workspaceFolders![0].uri.fsPath;

  try {
    const ast = parse(fileContent, {
      sourceType: "module",
      plugins: ["jsx", "typescript"],
      errorRecovery: true,
    });

    // Part 1: Highlight definitions if current file is a client component
    const moduleInfo = moduleGraph.get(currentFilePath);
    if (moduleInfo && moduleInfo.isClient) {
      console.log(
        `File ${currentFilePath} is a client component. Finding definitions to highlight.`
      );
      traverse(ast, {
        FunctionDeclaration({ node }) {
          if (node.id && node.id.name[0] === node.id.name[0].toUpperCase()) {
            if (node.id.start != null && node.id.end != null) {
              const start = editor.document.positionAt(node.id.start);
              const end = editor.document.positionAt(node.id.end);
              const range = new vscode.Range(start, end);
              decorations.push({ range });
              console.log(`Highlighting definition: ${node.id.name}`);
            }
          }
        },
        VariableDeclarator({ node }) {
          if (
            node.id.type === "Identifier" &&
            node.id.name[0] === node.id.name[0].toUpperCase()
          ) {
            if (
              node.init &&
              (node.init.type === "ArrowFunctionExpression" ||
                node.init.type === "FunctionExpression")
            ) {
              if (node.id.start != null && node.id.end != null) {
                const start = editor.document.positionAt(node.id.start);
                const end = editor.document.positionAt(node.id.end);
                const range = new vscode.Range(start, end);
                decorations.push({ range });
                console.log(`Highlighting definition: ${node.id.name}`);
              }
            }
          }
        },
        ClassDeclaration({ node }) {
          if (node.id && node.id.name[0] === node.id.name[0].toUpperCase()) {
            if (node.id.start != null && node.id.end != null) {
              const start = editor.document.positionAt(node.id.start);
              const end = editor.document.positionAt(node.id.end);
              const range = new vscode.Range(start, end);
              decorations.push({ range });
              console.log(`Highlighting definition: ${node.id.name}`);
            }
          }
        },
      });
    }

    // Part 2: Highlight usages of imported client components
    console.log(`Scanning ${currentFilePath} for usages of client components.`);
    const importMap = new Map<string, string>();
    const jsxElements: any[] = [];
    traverse(ast, {
      ImportDeclaration({ node }) {
        for (const specifier of node.specifiers) {
          if (
            specifier.type === "ImportSpecifier" ||
            specifier.type === "ImportDefaultSpecifier"
          ) {
            importMap.set(specifier.local.name, node.source.value);
          }
        }
      },
      JSXOpeningElement({ node }) {
        if (node.name.type === "JSXIdentifier") {
          const componentName = node.name.name;
          if (componentName[0] !== componentName[0].toLowerCase()) {
            jsxElements.push(node);
          }
        }
      },
    });

    for (const node of jsxElements) {
      const componentName = node.name.name;
      const importSource = importMap.get(componentName);
      if (importSource) {
        const absoluteImportPath = await resolveImportPath(
          importSource,
          currentFilePath,
          workspaceRoot
        );
        if (absoluteImportPath) {
          const importedModuleInfo = moduleGraph.get(absoluteImportPath);
          if (importedModuleInfo && importedModuleInfo.isClient) {
            console.log(
              `Highlighting usage: <${componentName}> in ${currentFilePath}`
            );
            if (node.name.start != null && node.name.end != null) {
              const start = editor.document.positionAt(node.name.start);
              const end = editor.document.positionAt(node.name.end);
              const range = new vscode.Range(start, end);
              decorations.push({ range });
            }
          }
        }
      }
    }
  } catch (e) {
    console.error("Error during decoration update", e);
  }

  console.log(
    `Applying ${decorations.length} total decorations to ${currentFilePath}.`
  );
  editor.setDecorations(clientComponentDecorationType, decorations);
}

export function activate(context: vscode.ExtensionContext) {
  console.log('Congratulations, your extension "client-js" is now active!');

  scanWorkspace().then(() => {
    console.log("Workspace scan complete.");
    propagateClientStatus();
    isReady = true;
    console.log("Extension is ready to apply decorations.");

    // Initial decoration for the active editor
    if (vscode.window.activeTextEditor) {
      updateDecorations(vscode.window.activeTextEditor);
    }
  });

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      updateDecorations(editor);
    })
  );

  let debounceTimer: NodeJS.Timeout;
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (
        vscode.window.activeTextEditor &&
        event.document === vscode.window.activeTextEditor.document
      ) {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          updateDecorations(vscode.window.activeTextEditor);
        }, 300);
      }
    })
  );
}

export function deactivate() {}
