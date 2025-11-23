import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { parse } from "@babel/parser";
import traverse from "@babel/traverse";

interface ModuleInfo {
  filePath: string;
  isClient: boolean; // The calculated status after propagation
  hasUseClient: boolean; // True if the file explicitly contains "use client"
  imports: Set<string>; // A set of absolute paths to other modules it imports
}

const moduleGraph = new Map<string, ModuleInfo>();
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

    // Correctly check for the "use client" directive in the AST
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
      isClient: hasUseClient, // Initially, isClient is the same as hasUseClient
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
  moduleGraph.clear(); // Clear the graph for a full rescan
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

  // Reset state before propagation
  const queue: string[] = [];
  for (const moduleInfo of moduleGraph.values()) {
    moduleInfo.isClient = moduleInfo.hasUseClient; // Reset to its explicit status
    if (moduleInfo.isClient) {
      queue.push(moduleInfo.filePath);
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
          if (importedModuleInfo && importedModuleInfo.isClient) {
            // Highlight opening tag
            const openNode = node.openingElement.name;
            if (openNode.start != null && openNode.end != null) {
              console.log(
                `Highlighting usage (open): <${componentName}> in ${currentFilePath}`
              );
              const start = editor.document.positionAt(openNode.start);
              const end = editor.document.positionAt(openNode.end);
              decorations.push({ range: new vscode.Range(start, end) });
            }

            // Highlight closing tag
            const closeNode = node.closingElement?.name;
            if (closeNode && closeNode.start != null && closeNode.end != null) {
              console.log(
                `Highlighting usage (close): </${componentName}> in ${currentFilePath}`
              );
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

  console.log(
    `Applying ${decorations.length} total decorations to ${currentFilePath}.`
  );
  editor.setDecorations(clientComponentDecorationType, decorations);
}

export function activate(context: vscode.ExtensionContext) {
  console.log('Congratulations, your extension "client-js" is now active!');

  // Load the persisted state, defaulting to true (enabled)
  isEnabled = context.globalState.get<boolean>("nextClient.isEnabled", true);

  vscode.commands.executeCommand("setContext", "nextClient.enabled", isEnabled);

  context.subscriptions.push(
    vscode.commands.registerCommand("next-client.enable", () => {
      isEnabled = true;
      context.globalState.update("nextClient.isEnabled", isEnabled);
      vscode.commands.executeCommand(
        "setContext",
        "nextClient.enabled",
        isEnabled
      );
      vscode.window.visibleTextEditors.forEach(updateDecorations);
      console.log("Next Client extension enabled.");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("next-client.disable", () => {
      isEnabled = false;
      context.globalState.update("nextClient.isEnabled", isEnabled);
      vscode.commands.executeCommand(
        "setContext",
        "nextClient.enabled",
        isEnabled
      );
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

  const reprocessGraphAndUpdateDecorations = () => {
    propagateClientStatus();
    // Update decorations for all visible editors
    vscode.window.visibleTextEditors.forEach(updateDecorations);
    console.log("Graph reprocessed and decorations updated.");
  };

  scanWorkspace().then(() => {
    console.log("Workspace scan complete.");
    reprocessGraphAndUpdateDecorations();
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
      if (!isEnabled || !vscode.workspace.workspaceFolders) {
        return;
      }
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor && event.document === activeEditor.document) {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
          console.log(
            `Text changed in buffer for ${event.document.uri.fsPath}, reprocessing...`
          );
          const workspaceRoot =
            vscode.workspace.workspaceFolders![0].uri.fsPath;

          // Get live content from the editor buffer
          const liveContent = event.document.getText();
          const moduleInfo = await processFile(
            event.document.uri,
            workspaceRoot,
            liveContent
          );

          // Try to update the graph, but don't let it stop the decoration update
          let graphWasUpdated = false;
          if (moduleInfo) {
            moduleGraph.set(moduleInfo.filePath, moduleInfo);
            propagateClientStatus();
            graphWasUpdated = true;
            console.log("Module graph updated from buffer change.");
          } else {
            console.log(
              "Could not update module graph, likely due to transient syntax error."
            );
          }

          // Always update the current editor's decorations
          updateDecorations(activeEditor);

          // If the graph changed, update other visible editors too
          if (graphWasUpdated) {
            vscode.window.visibleTextEditors.forEach((editor) => {
              if (editor !== activeEditor) {
                updateDecorations(editor);
              }
            });
          }
        }, 200);
      }
    })
  );

  // --- File System Watcher for external changes (e.g., git checkout) ---
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders) {
    const workspaceRoot = workspaceFolders[0].uri.fsPath;

    const watcher = vscode.workspace.createFileSystemWatcher(
      "**/*.{js,jsx,ts,tsx}"
    );
    context.subscriptions.push(watcher);

    // onDidChange is covered by onDidChangeTextDocument for open files,
    // but this handles changes made outside of the editor (e.g. git pull)
    watcher.onDidChange(async (uri) => {
      // Only process if the file is not open and dirty, as onDidChangeTextDocument will handle it
      const doc = vscode.workspace.textDocuments.find(
        (d) => d.uri.fsPath === uri.fsPath
      );
      if (doc && doc.isDirty) {
        return;
      }

      console.log(`File changed on disk: ${uri.fsPath}`);
      const moduleInfo = await processFile(uri, workspaceRoot);
      if (moduleInfo) {
        moduleGraph.set(moduleInfo.filePath, moduleInfo);
        reprocessGraphAndUpdateDecorations();
      }
    });

    watcher.onDidCreate(async (uri) => {
      console.log(`File created: ${uri.fsPath}`);
      const moduleInfo = await processFile(uri, workspaceRoot);
      if (moduleInfo) {
        moduleGraph.set(moduleInfo.filePath, moduleInfo);
        reprocessGraphAndUpdateDecorations();
      }
    });

    watcher.onDidDelete((uri) => {
      const filePath = uri.fsPath;
      console.log(`File deleted: ${filePath}`);
      if (moduleGraph.has(filePath)) {
        moduleGraph.delete(filePath);
        // Also remove it from any module that imports it
        for (const moduleInfo of moduleGraph.values()) {
          if (moduleInfo.imports.has(filePath)) {
            moduleInfo.imports.delete(filePath);
          }
        }
        reprocessGraphAndUpdateDecorations();
      }
    });
  }
}

export function deactivate() {}
