import * as vscode from 'vscode';
import * as path from 'path';
import { PythonAnalyzer } from './analyzer';
import { InheritanceStore, FileData, ClassNode } from './inheritanceStore';

let store: InheritanceStore;
let outputChannel: vscode.LogOutputChannel;

const BUILTIN_TYPES = new Set([
  'object', 'type', 'classmethod', 'staticmethod', 'property',
  'ABC', 'ABCMeta', 'dict', 'list', 'str', 'int', 'set', 'tuple', 'bool', 'None'
]);

export async function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel('Python Inheritance', { log: true });
  outputChannel.info('Extension "vscode-python-inheritance" is now active!');
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

  const overridesVarDecorationType = vscode.window.createTextEditorDecorationType({
    gutterIconPath: context.asAbsolutePath(path.join('resources', 'overrides_var.svg')),
    gutterIconSize: 'contain'
  });

  const overriddenVarDecorationType = vscode.window.createTextEditorDecorationType({
    gutterIconPath: context.asAbsolutePath(path.join('resources', 'overridden_var.svg')),
    gutterIconSize: 'contain'
  });

  const bothVarDecorationType = vscode.window.createTextEditorDecorationType({
    gutterIconPath: context.asAbsolutePath(path.join('resources', 'both_var.svg')),
    gutterIconSize: 'contain'
  });

  async function updateDecorations(editor: vscode.TextEditor) {
    if (editor.document.languageId !== 'python') return;

    let fileData = store.get(editor.document.uri);
    if (!fileData) {
      outputChannel.info(`No data for ${editor.document.uri.toString()}, triggering immediate analysis...`);
      fileData = await analyzeFile(editor.document, 0);
      if (fileData) {
        store.set(editor.document.uri, fileData);
      }
    }

    if (!fileData) return;

    const overrides: vscode.Range[] = [];
    const overridden: vscode.Range[] = [];
    const both: vscode.Range[] = [];
    const overridesVar: vscode.Range[] = [];
    const overriddenVar: vscode.Range[] = [];
    const bothVar: vscode.Range[] = [];

    for (const node of fileData.classes) {
      const mro = store.getFullMRO(editor.document.uri.toString(), node.className);
      const subClasses = store.getSubclasses(editor.document.uri.toString(), node.className);

      for (const member of node.members || []) {
        const range = InheritanceStore.toRange(member.selectionRange);
        const isMethod = member.kind === vscode.SymbolKind.Method || member.kind === vscode.SymbolKind.Function;

        const isOverride = mro.some(p => p.members?.some(pm => pm.name === member.name));
        const isOverridden = subClasses.some(s => s.members?.some(sm => sm.name === member.name));

        if (isOverride && isOverridden) {
          if (isMethod) both.push(range); else bothVar.push(range);
        } else if (isOverride) {
          if (isMethod) overrides.push(range); else overridesVar.push(range);
        } else if (isOverridden) {
          if (isMethod) overridden.push(range); else overriddenVar.push(range);
        }
      }
    }

    editor.setDecorations(overridesDecorationType, overrides);
    editor.setDecorations(overriddenDecorationType, overridden);
    editor.setDecorations(bothDecorationType, both);
    editor.setDecorations(overridesVarDecorationType, overridesVar);
    editor.setDecorations(overriddenVarDecorationType, overriddenVar);
    editor.setDecorations(bothVarDecorationType, bothVar);
  }

  async function resolveSymbolDeeply(uri: vscode.Uri, position: vscode.Position, depth: number = 0): Promise<{ uri: vscode.Uri, range: vscode.Range } | undefined> {
    if (depth > 4) return undefined;

    const definitions = await vscode.commands.executeCommand<vscode.Location[] | vscode.LocationLink[]>(
      'vscode.executeDefinitionProvider',
      uri,
      position
    );

    if (!definitions || definitions.length === 0) {
      return undefined;
    }

    const def = definitions[0];
    const targetUri = 'uri' in def ? def.uri : (def as vscode.LocationLink).targetUri;
    const targetRange = 'range' in def ? def.range : (def as vscode.LocationLink).targetRange;
    const targetSelectionRange = 'targetSelectionRange' in def ? (def as vscode.LocationLink).targetSelectionRange || targetRange : targetRange;

    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      'vscode.executeDocumentSymbolProvider',
      targetUri
    );

    if (symbols) {
      const isClassAtPosition = (syms: vscode.DocumentSymbol[]): boolean => {
        for (const s of syms) {
          if ((s.kind === vscode.SymbolKind.Class || s.kind === vscode.SymbolKind.Interface) && s.range.contains(targetSelectionRange.start)) {
            return true;
          }
          if (s.children && isClassAtPosition(s.children)) return true;
        }
        return false;
      };

      if (isClassAtPosition(symbols)) {
        outputChannel.info(`[Inheritance] Resolved definition: ${targetUri.toString()}`);
        return { uri: targetUri, range: targetSelectionRange };
      }
    }

    return resolveSymbolDeeply(targetUri, targetSelectionRange.start, depth + 1);
  }

  async function analyzeFile(document: vscode.TextDocument, depth: number = 0, visitedUris: Set<string> = new Set()): Promise<FileData | undefined> {
    if (depth > 5) return undefined;
    if (visitedUris.has(document.uri.toString())) {
      outputChannel.info(`Skipping already visited: ${document.uri.toString()}`);
      return undefined;
    }
    visitedUris.add(document.uri.toString());

    outputChannel.info(`Starting analysis for: ${document.uri.toString()} (depth: ${depth})`);

    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      'vscode.executeDocumentSymbolProvider',
      document.uri
    );

    if (!symbols) {
      outputChannel.warn(`No symbols returned for ${document.uri.toString()}`);
      return undefined;
    }

    const classes: ClassNode[] = [];

    async function processSymbols(syms: vscode.DocumentSymbol[]) {
      for (const s of syms) {
        if (s.kind === vscode.SymbolKind.Class || s.kind === vscode.SymbolKind.Interface) {
          const members = s.children
            .filter(c =>
              c.kind === vscode.SymbolKind.Method ||
              c.kind === vscode.SymbolKind.Function ||
              c.kind === vscode.SymbolKind.Variable ||
              c.kind === vscode.SymbolKind.Field ||
              c.kind === vscode.SymbolKind.Property ||
              c.kind === vscode.SymbolKind.EnumMember ||
              c.kind === vscode.SymbolKind.Constant
            )
            .map(m => ({
              name: m.name,
              kind: m.kind,
              range: InheritanceStore.fromRange(m.range),
              selectionRange: InheritanceStore.fromRange(m.selectionRange)
            }));

          // Parse bases
          const bases: any[] = [];
          let headerText = "";
          let currentLine = s.range.start.line;
          let openParens = 0;
          let foundColon = false;

          while (currentLine < document.lineCount && currentLine <= s.range.end.line) {
            const line = document.lineAt(currentLine).text;
            headerText += line + "\n";
            const commentIdx = line.indexOf('#');
            const codePart = commentIdx === -1 ? line : line.substring(0, commentIdx);
            for (const char of codePart) {
              if (char === '(') openParens++;
              else if (char === ')') openParens--;
              else if (char === ':' && openParens === 0) {
                foundColon = true;
                break;
              }
            }
            if (foundColon) break;
            currentLine++;
          }

          const headerMatch = headerText.match(/class\s+\w+\s*(?:\(([\s\S]*?)\))?\s*:/);
          if (headerMatch && headerMatch[1]) {
            const baseNamesStr = headerMatch[1];
            const baseNames = baseNamesStr.split(',').map(n => n.trim()).filter(n => n.length > 0);
            let lastOffset = 0;
            for (const name of baseNames) {
              if (name.includes('=') || BUILTIN_TYPES.has(name) || name.includes('classmethod') || name.includes('staticmethod')) continue;

              const nameOffset = headerText.indexOf(name, lastOffset);
              if (nameOffset === -1) continue;
              lastOffset = nameOffset + name.length;

              const linesBefore = headerText.substring(0, nameOffset).split('\n');
              const baseLine = s.range.start.line + linesBefore.length - 1;
              const colInLine = linesBefore[linesBefore.length - 1].length;

              // Point to the last part of a dotted name (e.g. JSONEncoder in json.JSONEncoder)
              const lastDot = name.lastIndexOf('.');
              const charOffset = lastDot === -1 ? 0 : lastDot + 1;
              const baseChar = colInLine + charOffset;

              outputChannel.info(`[Inheritance] Resolving base class: "${name}" at ${document.uri.toString()}:${baseLine}:${baseChar}`);

              const deepDef = await resolveSymbolDeeply(document.uri, new vscode.Position(baseLine, baseChar));

              if (!deepDef) {
                outputChannel.warn(`[Inheritance] No deep definition found for "${name}" at ${baseLine}:${baseChar}`);
                continue;
              }

              const { uri, range } = deepDef;
              outputChannel.info(`[Inheritance] Resolved deeper definition: ${uri.toString()}`);

              if (!store.get(uri)) {
                try {
                  outputChannel.info(`[Inheritance] Analyzing external base class: ${uri.toString()}`);
                  const baseDoc = await vscode.workspace.openTextDocument(uri);
                  const baseData = await analyzeFile(baseDoc, depth + 1, visitedUris);
                  if (baseData) {
                    outputChannel.info(`[Inheritance] Successfully indexed ${baseData.classes.length} classes in ${uri.toString()}`);
                    store.set(uri, baseData);
                  } else {
                    outputChannel.warn(`[Inheritance] No classes found in external library: ${uri.toString()}`);
                  }
                } catch (e) {
                  outputChannel.error(`[Inheritance] Failed to analyze base class at ${uri.toString()}:`, e);
                }
              }

              bases.push({
                name: name.includes('.') ? name.split('.').pop()! : name,
                uri: uri.toString(),
                range: InheritanceStore.fromRange(range)
              });
            }
          }

          classes.push({
            uri: document.uri.toString(),
            className: s.name,
            range: InheritanceStore.fromRange(s.range),
            selectionRange: InheritanceStore.fromRange(s.selectionRange),
            members,
            bases
          });
        }
        if (s.children) await processSymbols(s.children);
      }
    }

    await processSymbols(symbols);
    return { mtime: 0, classes };
  }

  const codeLensProvider = new InheritanceCodeLensProvider();
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ language: 'python' }, codeLensProvider)
  );

  async function runIndexing(force: boolean = false) {
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: force ? "Forcing Python inheritance re-indexing..." : "Indexing Python inheritance...",
      cancellable: true
    }, async (progress, token) => {
      const files = await vscode.workspace.findFiles('**/*.py', '**/node_modules/**');
      outputChannel.info(`Found ${files.length} python files for indexing. (Force: ${force})`);
      const total = files.length;
      for (let i = 0; i < total; i++) {
        if (token.isCancellationRequested) break;
        const file = files[i];
        progress.report({ message: `${Math.round((i / total) * 100)}% - ${path.basename(file.fsPath)}`, increment: 100 / total });
        try {
          const stat = await vscode.workspace.fs.stat(file);
          if (!force) {
            const cached = store.get(file);
            if (cached && cached.mtime === stat.mtime) continue;
          }
          const doc = await vscode.workspace.openTextDocument(file);
          const data = await analyzeFile(doc, 0);
          if (data) {
            data.mtime = stat.mtime;
            store.set(file, data);
          }
          if (i % 20 === 0 && vscode.window.activeTextEditor) {
            updateDecorations(vscode.window.activeTextEditor);
            codeLensProvider.refresh();
          }
        } catch (e) { }
      }
      await store.save();
      if (vscode.window.activeTextEditor) {
        updateDecorations(vscode.window.activeTextEditor);
        codeLensProvider.refresh();
      }
    });
  }

  runIndexing();

  if (vscode.window.activeTextEditor) {
    updateDecorations(vscode.window.activeTextEditor);
  }

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (doc: vscode.TextDocument) => {
      if (doc.languageId !== 'python') return;
      const data = await analyzeFile(doc, 0);
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
    }),
    vscode.commands.registerCommand('pythonInheritance.resetCache', async () => {
      await context.workspaceState.update(InheritanceStore.STORAGE_KEY, undefined);
      vscode.window.showInformationMessage('Inheritance Cache cleared. Reload window to re-index.');
    }),
    vscode.commands.registerCommand('pythonInheritance.reindex', async () => {
      await runIndexing(true);
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

      for (const member of node.members || []) {
        const range = InheritanceStore.toRange(member.range);
        const supers = mro
          .map(p => ({ class: p, member: p.members?.find(m => m.name === member.name) }))
          .filter(x => x.member)
          .map(x => ({ ...x.member!, uri: x.class.uri, className: x.class.className }));

        if (supers.length > 0) {
          lenses.push(new vscode.CodeLens(range, {
            title: `↑ overrides ${supers.length} base definitions`,
            command: 'pythonInheritance.showTargets',
            arguments: [supers, 'Base implementations']
          }));
        }

        const subs = subClasses
          .map(s => ({ class: s, member: s.members?.find(m => m.name === member.name) }))
          .filter(x => x.member)
          .map(x => ({ ...x.member!, uri: x.class.uri, className: x.class.className }));

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
