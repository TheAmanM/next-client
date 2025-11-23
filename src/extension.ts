import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { parse } from "@babel/parser";
import traverse from "@babel/traverse";

interface ModuleInfo {
  filePath: string;
  hasUseClient: boolean; // True if the file explicitly contains "use client"
  imports: Set<string>; // A set of absolute paths to other modules it imports
}

const moduleGraph = new Map<string, ModuleInfo>();
const importerMap = new Map<string, Set<string>>(); // Maps a module to all modules that import it
const clientModuleCache = new Map<string, boolean>(); // Cache for isClientModule checks
const pathResolutionCache = new Map<string, string | null>(); // Cache for path resolutions

let isReady = false;
let isEnabled = true;

let clientComponentDecorationType: vscode.TextEditorDecorationType;

function clearAllDecorations() {
  vscode.window.visibleTextEditors.forEach((editor) => {
    editor.setDecorations(clientComponentDecorationType, []);
  });
}

function refreshDecorationStyle() {
  if (clientComponentDecorationType) {
    clientComponentDecorationType.dispose();
  }

  const config = vscode.workspace.getConfiguration("nextClient.styling");

  clientComponentDecorationType = vscode.window.createTextEditorDecorationType({
    backgroundColor: config.get<string>("backgroundColor"),
    color: config.get<string>("color"),
    dark: {
      color: config.get<string>("darkColor"),
    },
  });
}

function updateImporterMap(
  oldModuleInfo: ModuleInfo | undefined,
  newModuleInfo: ModuleInfo
) {
  const filePath = newModuleInfo.filePath;
  const oldImports = oldModuleInfo?.imports ?? new Set();
  const newImports = newModuleInfo.imports;

  for (const oldImport of oldImports) {
    if (!newImports.has(oldImport)) {
      importerMap.get(oldImport)?.delete(filePath);
    }
  }
  for (const newImport of newImports) {
    if (!oldImports.has(newImport)) {
      if (!importerMap.has(newImport)) {
        importerMap.set(newImport, new Set());
      }
      importerMap.get(newImport)!.add(filePath);
    }
  }
}

async function processFile(
  fileUri: vscode.Uri,
  workspaceRoot: string,
  fileContent?: string
): Promise<ModuleInfo | null> {
  const filePath = fileUri.fsPath;
  try {
    const content =
      fileContent ?? (await fs.promises.readFile(filePath, "utf-8"));
    const imports = new Set<string>();

    const ast = parse(content, {
      sourceType: "module",
      plugins: ["jsx", "typescript"],
      errorRecovery: true,
    });

    const hasUseClient = ast.program.directives.some(
      (d) => d.value.value === "use client"
    );

    if (hasUseClient) {
      console.log(`Found "use client" directive in: ${filePath}`);
    }

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

    return {
      filePath,
      hasUseClient,
      imports,
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      console.log(`File not found during processing, skipping: ${filePath}`);
    } else {
      console.error(`Failed to process ${filePath}:`, error);
    }
    return null;
  }
}

async function scanWorkspace() {
  console.log("Starting workspace scan...");
  moduleGraph.clear();
  importerMap.clear();
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) {
    console.log("No workspace folders found.");
    return;
  }
  const workspaceRoot = workspaceFolders[0].uri.fsPath;

  const allJsxFiles = await vscode.workspace.findFiles(
    "**/*.{js,jsx,ts,tsx}",
    "{**/node_modules/**,**/.next/**,**/out/**,**/dist/**}"
  );
  console.log(`Found ${allJsxFiles.length} files to scan.`);

  const processPromises = allJsxFiles.map((fileUri) =>
    processFile(fileUri, workspaceRoot)
  );

  const results = await Promise.all(processPromises);

  for (const moduleInfo of results) {
    if (moduleInfo) {
      moduleGraph.set(moduleInfo.filePath, moduleInfo);
      for (const importedPath of moduleInfo.imports) {
        if (!importerMap.has(importedPath)) {
          importerMap.set(importedPath, new Set());
        }
        importerMap.get(importedPath)!.add(moduleInfo.filePath);
      }
    }
  }

  console.log(
    `Module graph created with ${moduleGraph.size} modules and importer map with ${importerMap.size} entries.`
  );
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
  if (pathResolutionCache.has(absolutePath)) {
    return pathResolutionCache.get(absolutePath)!;
  }

  const extensions = ["", ".js", ".jsx", ".ts", ".tsx"];
  // Check for file with extension
  for (const ext of extensions) {
    const pathWithExt = absolutePath + ext;
    try {
      const stats = await fs.promises.stat(pathWithExt);
      if (stats.isFile()) {
        pathResolutionCache.set(absolutePath, pathWithExt);
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
        pathResolutionCache.set(absolutePath, indexPath);
        return indexPath;
      }
    } catch (e) {
      // ignore
    }
  }

  pathResolutionCache.set(absolutePath, null); // Cache the failure
  return null;
}

function isSpecialNextJsFile(filePath: string): boolean {
  const basename = path.basename(filePath);
  const specialPrefixes = ["page.", "layout.", "template.", "error.", "loading."];
  return specialPrefixes.some((prefix) => basename.startsWith(prefix));
}

function isClientModule(
  filePath: string,
  visited: Set<string> = new Set()
): boolean {
  if (clientModuleCache.has(filePath)) {
    return clientModuleCache.get(filePath)!;
  }
  if (visited.has(filePath)) {
    return false; // Cycle detected
  }
  visited.add(filePath);

  const moduleInfo = moduleGraph.get(filePath);
  if (!moduleInfo) {
    return false;
  }

  if (moduleInfo.hasUseClient) {
    clientModuleCache.set(filePath, true);
    return true;
  }

  // Stop upward traversal at special Next.js files
  if (isSpecialNextJsFile(filePath)) {
    clientModuleCache.set(filePath, false);
    return false;
  }

  const importers = importerMap.get(filePath);
  if (importers) {
    for (const importerPath of importers) {
      if (isClientModule(importerPath, visited)) {
        clientModuleCache.set(filePath, true);
        return true;
      }
    }
  }

  clientModuleCache.set(filePath, false);
  return false;
}

async function updateDecorations(editor: vscode.TextEditor | undefined) {
  if (!editor || !isReady) {
    return;
  }

  if (!isEnabled) {
    editor.setDecorations(clientComponentDecorationType, []);
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

    const moduleInfo = moduleGraph.get(currentFilePath);
    const currentFileHasUseClient = moduleInfo?.hasUseClient ?? false;
    const currentFileIsClientByContext = isClientModule(currentFilePath);

    // Part 1: Highlight definitions only if the file has the "use client" directive
    if (currentFileHasUseClient) {
      traverse(ast, {
        FunctionDeclaration({ node }) {
          if (node.id && node.id.name[0] === node.id.name[0].toUpperCase()) {
            if (node.id.start != null && node.id.end != null) {
              const start = editor.document.positionAt(node.id.start);
              const end = editor.document.positionAt(node.id.end);
              decorations.push({ range: new vscode.Range(start, end) });
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
                decorations.push({ range: new vscode.Range(start, end) });
              }
            }
          }
        },
      });
    }

    // Part 2: Highlight usages of components that are client components in this context
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
      JSXElement({ node }) {
        if (node.openingElement.name.type === "JSXIdentifier") {
          const componentName = node.openingElement.name.name;
          if (componentName[0] !== componentName[0].toLowerCase()) {
            jsxElements.push(node);
          }
        }
      },
    });

    for (const node of jsxElements) {
      const componentName = node.openingElement.name.name;
      const importSource = importMap.get(componentName);
      if (importSource) {
        const absoluteImportPath = await resolveImportPath(
          importSource,
          currentFilePath,
          workspaceRoot
        );
        if (absoluteImportPath) {
          const importedModuleInfo = moduleGraph.get(absoluteImportPath);
          // Highlight a usage if:
          // 1. The current file is a client component (by context).
          // 2. OR the imported component ITSELF has the "use client" directive.
          if (currentFileIsClientByContext || importedModuleInfo?.hasUseClient) {
            const openNode = node.openingElement.name;
            if (openNode.start != null && openNode.end != null) {
              const start = editor.document.positionAt(openNode.start);
              const end = editor.document.positionAt(openNode.end);
              decorations.push({ range: new vscode.Range(start, end) });
            }
            const closeNode = node.closingElement?.name;
            if (closeNode && closeNode.start != null && closeNode.end != null) {
              const start = editor.document.positionAt(closeNode.start);
              const end = editor.document.positionAt(closeNode.end);
              decorations.push({ range: new vscode.Range(start, end) });
            }
          }
        }
      }
    }
  } catch (e) {
    console.error("Error during decoration update", e);
  }

  editor.setDecorations(clientComponentDecorationType, decorations);
}

export function activate(context: vscode.ExtensionContext) {
  console.log('Congratulations, your extension "client-js" is now active!');

  isEnabled = context.globalState.get<boolean>("nextClient.isEnabled", true);
  vscode.commands.executeCommand("setContext", "nextClient.enabled", isEnabled);

  const reprocessAndDecorate = () => {
    clientModuleCache.clear();
    console.log("Client module cache cleared.");
    vscode.window.visibleTextEditors.forEach(updateDecorations);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("next-client.enable", () => {
      isEnabled = true;
      context.globalState.update("nextClient.isEnabled", isEnabled);
      vscode.commands.executeCommand("setContext", "nextClient.enabled", true);
      reprocessAndDecorate();
      console.log("Next Client extension enabled.");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("next-client.disable", () => {
      isEnabled = false;
      context.globalState.update("nextClient.isEnabled", isEnabled);
      vscode.commands.executeCommand("setContext", "nextClient.enabled", false);
      clearAllDecorations();
      console.log("Next Client extension disabled.");
    })
  );

  refreshDecorationStyle();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("nextClient.styling")) {
        console.log("Styling configuration changed. Re-applying decorations.");
        refreshDecorationStyle();
        if (isEnabled) {
          vscode.window.visibleTextEditors.forEach(updateDecorations);
        }
      }
    })
  );

  scanWorkspace().then(() => {
    reprocessAndDecorate();
    isReady = true;
    console.log("Extension is ready to apply decorations.");
  });

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (isEnabled) {
        updateDecorations(editor);
      }
    })
  );

  let debounceTimer: NodeJS.Timeout;
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (!isEnabled || !vscode.workspace.workspaceFolders) return;
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor && event.document === activeEditor.document) {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
          const filePath = event.document.uri.fsPath;
          const workspaceRoot = vscode.workspace.workspaceFolders![0].uri.fsPath;

          const oldModuleInfo = moduleGraph.get(filePath);
          const newModuleInfo = await processFile(
            event.document.uri,
            workspaceRoot,
            event.document.getText()
          );

          if (newModuleInfo) {
            updateImporterMap(oldModuleInfo, newModuleInfo);
            moduleGraph.set(filePath, newModuleInfo);
            reprocessAndDecorate();
          } else {
            updateDecorations(activeEditor);
          }
        }, 400);
      }
    })
  );

  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders) {
    const workspaceRoot = workspaceFolders[0].uri.fsPath;
    const watcher = vscode.workspace.createFileSystemWatcher("**/*.{js,jsx,ts,tsx}");
    context.subscriptions.push(watcher);

    watcher.onDidChange(async (uri) => {
      const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === uri.fsPath);
      if (doc && doc.isDirty) return;

      const oldModuleInfo = moduleGraph.get(uri.fsPath);
      const newModuleInfo = await processFile(uri, workspaceRoot);
      if (newModuleInfo) {
        updateImporterMap(oldModuleInfo, newModuleInfo);
        moduleGraph.set(uri.fsPath, newModuleInfo);
        reprocessAndDecorate();
      }
    });

    watcher.onDidCreate(async (uri) => {
      pathResolutionCache.clear();
      const oldModuleInfo = moduleGraph.get(uri.fsPath);
      const newModuleInfo = await processFile(uri, workspaceRoot);
      if (newModuleInfo) {
        updateImporterMap(oldModuleInfo, newModuleInfo);
        moduleGraph.set(uri.fsPath, newModuleInfo);
        reprocessAndDecorate();
      }
    });

    watcher.onDidDelete((uri) => {
      pathResolutionCache.clear();
      const filePath = uri.fsPath;
      const deletedModuleInfo = moduleGraph.get(filePath);
      if (deletedModuleInfo) {
        for (const importedPath of deletedModuleInfo.imports) {
          importerMap.get(importedPath)?.delete(filePath);
        }
        moduleGraph.delete(filePath);
        reprocessAndDecorate();
      }
    });
  }
}

export function deactivate() {}