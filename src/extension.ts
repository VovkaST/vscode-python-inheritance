import * as vscode from 'vscode';
import * as path from 'path';
import { PythonAnalyzer } from './analyzer';
import { InheritanceStore, FileData, ClassNode } from './inheritanceStore';

let store: InheritanceStore;

export async function activate(context: vscode.ExtensionContext) {
  console.log('Python Inheritance Visualizer is now active!');
  store = new InheritanceStore(context);

  const overridesDecorationType = vscode.window.createTextEditorDecorationType({
    gutterIconPath: context.asAbsolutePath(path.join('resources', 'overrides.svg')),
    gutterIconSize: 'contain'
  });

  const overriddenDecorationType = vscode.window.createTextEditorDecorationType({
    gutterIconPath: context.asAbsolutePath(path.join('resources', 'overridden.svg')),
    gutterIconSize: 'contain'
  });

  const bothDecorationType = vscode.window.createTextEditorDecorationType({
    gutterIconPath: context.asAbsolutePath(path.join('resources', 'both.svg')),
    gutterIconSize: 'contain'
  });

  async function updateDecorations(editor: vscode.TextEditor) {
    if (editor.document.languageId !== 'python') return;

    const fileData = store.get(editor.document.uri);
    if (!fileData) return;

    const overrides: vscode.Range[] = [];
    const overridden: vscode.Range[] = [];
    const both: vscode.Range[] = [];

    for (const node of fileData.classes) {
        const mro = store.getFullMRO(editor.document.uri.toString(), node.className);
        const subClasses = store.getSubclasses(editor.document.uri.toString(), node.className);

        for (const method of node.methods) {
            const range = InheritanceStore.toRange(method.selectionRange);
            const isOverride = mro.some(p => p.methods.some(pm => pm.name === method.name));
            const isOverridden = subClasses.some(s => s.methods.some(sm => sm.name === method.name));

            if (isOverride && isOverridden) {
                both.push(range);
            } else if (isOverride) {
                overrides.push(range);
            } else if (isOverridden) {
                overridden.push(range);
            }
        }
    }

    editor.setDecorations(overridesDecorationType, overrides);
    editor.setDecorations(overriddenDecorationType, overridden);
    editor.setDecorations(bothDecorationType, both);
  }

  async function analyzeFile(document: vscode.TextDocument): Promise<FileData | undefined> {
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      'vscode.executeDocumentSymbolProvider',
      document.uri
    );
    if (!symbols) return undefined;

    const classes: ClassNode[] = [];
    
    async function processSymbols(syms: vscode.DocumentSymbol[]) {
        for (const s of syms) {
            if (s.kind === vscode.SymbolKind.Class || s.kind === vscode.SymbolKind.Interface) {
                const methods = s.children
                    .filter(c => c.kind === vscode.SymbolKind.Method || c.kind === vscode.SymbolKind.Function)
                    .map(m => ({
                        name: m.name,
                        range: InheritanceStore.fromRange(m.range),
                        selectionRange: InheritanceStore.fromRange(m.selectionRange)
                    }));

                // Parse bases
                const bases: any[] = [];
                const lineText = document.lineAt(s.range.start.line).text;
                const match = lineText.match(/class\s+\w+\s*\(([^)]+)\)/);
                if (match) {
                    const baseNames = match[1].split(',').map(n => n.trim());
                    for (const name of baseNames) {
                        const namePos = lineText.indexOf(name);
                        const definitions = await vscode.commands.executeCommand<vscode.Location[] | vscode.LocationLink[]>(
                            'vscode.executeDefinitionProvider',
                            document.uri,
                            new vscode.Position(s.range.start.line, namePos)
                        );
                        if (definitions && definitions.length > 0) {
                            const def = definitions[0];
                            const uri = 'uri' in def ? def.uri : def.targetUri;
                            const range = 'range' in def ? def.range : def.targetRange;
                            bases.push({
                                name: name.includes('.') ? name.split('.').pop()! : name,
                                uri: uri.toString(),
                                range: InheritanceStore.fromRange(range)
                            });
                        }
                    }
                }

                classes.push({
                    uri: document.uri.toString(),
                    className: s.name,
                    range: InheritanceStore.fromRange(s.range),
                    selectionRange: InheritanceStore.fromRange(s.selectionRange),
                    methods,
                    bases
                });
            }
            if (s.children) await processSymbols(s.children);
        }
    }

    await processSymbols(symbols);
    return { mtime: 0, classes }; // mtime will be set by caller
  }

  // Background Indexing
  const codeLensProvider = new InheritanceCodeLensProvider();
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ language: 'python' }, codeLensProvider)
  );

  vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: "Индексация наследования Python...",
    cancellable: true
  }, async (progress, token) => {
    const files = await vscode.workspace.findFiles('**/*.py', '**/node_modules/**');
    const total = files.length;
    for (let i = 0; i < total; i++) {
        if (token.isCancellationRequested) break;
        const file = files[i];
        progress.report({ message: `${Math.round((i/total)*100)}% - ${path.basename(file.fsPath)}`, increment: 100/total });
        
        try {
            const stat = await vscode.workspace.fs.stat(file);
            const cached = store.get(file);
            if (cached && cached.mtime === stat.mtime) continue;

            const doc = await vscode.workspace.openTextDocument(file);
            const data = await analyzeFile(doc);
            if (data) {
                data.mtime = stat.mtime;
                store.set(file, data);
            }
            if (i % 20 === 0 && vscode.window.activeTextEditor) {
                updateDecorations(vscode.window.activeTextEditor);
                codeLensProvider.refresh();
            }
        } catch (e) {}
    }
    await store.save();
    if (vscode.window.activeTextEditor) {
        updateDecorations(vscode.window.activeTextEditor);
        codeLensProvider.refresh();
    }
  });

  if (vscode.window.activeTextEditor) {
    updateDecorations(vscode.window.activeTextEditor);
  }

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (doc: vscode.TextDocument) => {
      if (doc.languageId !== 'python') return;
      const data = await analyzeFile(doc);
      if (data) {
          const stat = await vscode.workspace.fs.stat(doc.uri);
          data.mtime = stat.mtime;
          store.set(doc.uri, data);
          await store.save();
      }
      if (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document === doc) {
        updateDecorations(vscode.window.activeTextEditor);
        codeLensProvider.refresh();
      }
    }),
    vscode.window.onDidChangeActiveTextEditor((editor: vscode.TextEditor | undefined) => {
      if (editor) updateDecorations(editor);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('pythonInheritance.showTargets', async (targets: any[], title: string) => {
      if (targets.length === 1) {
        const target = targets[0];
        const uri = vscode.Uri.parse(target.uri);
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { selection: InheritanceStore.toRange(target.selectionRange) });
      } else {
        const items = targets.map(target => ({
            label: `${target.className}`,
            description: vscode.workspace.asRelativePath(vscode.Uri.parse(target.uri)),
            detail: `Line ${target.selectionRange.startLine + 1}`,
            target: target
        }));
        const pick = await vscode.window.showQuickPick(items, { title });
        if (pick) {
            const uri = vscode.Uri.parse(pick.target.uri);
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc, { selection: InheritanceStore.toRange(pick.target.selectionRange) });
        }
      }
    })
  );
}

class InheritanceCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;

  public refresh(): void {
    this._onDidChangeCodeLenses.fire();
  }

  async provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.CodeLens[]> {
    const fileData = store.get(document.uri);
    if (!fileData) return [];

    const lenses: vscode.CodeLens[] = [];
    for (const node of fileData.classes) {
        const mro = store.getFullMRO(document.uri.toString(), node.className);
        const subClasses = store.getSubclasses(document.uri.toString(), node.className);

        for (const method of node.methods) {
            const range = InheritanceStore.toRange(method.range);
            
            // Find base implementations
            const supers = mro
                .map(p => ({ class: p, method: p.methods.find(m => m.name === method.name) }))
                .filter(x => x.method)
                .map(x => ({ ...x.method!, uri: x.class.uri, className: x.class.className }));

            if (supers.length > 0) {
                lenses.push(new vscode.CodeLens(range, {
                    title: `↑ overrides ${supers.length} base definitions`,
                    command: 'pythonInheritance.showTargets',
                    arguments: [supers, 'Base implementations']
                }));
            }

            // Find subclass overrides
            const subs = subClasses
                .map(s => ({ class: s, method: s.methods.find(m => m.name === method.name) }))
                .filter(x => x.method)
                .map(x => ({ ...x.method!, uri: x.class.uri, className: x.class.className }));

            if (subs.length > 0) {
                lenses.push(new vscode.CodeLens(range, {
                    title: `↓ overridden in ${subs.length} subclasses`,
                    command: 'pythonInheritance.showTargets',
                    arguments: [subs, 'Overridden in subclasses']
                }));
            }
        }
    }
    return lenses;
  }
}
