import * as path from 'path';
import * as vscode from 'vscode';
import { ClassNode, FileData, InheritanceStore } from './inheritanceStore';

let store: InheritanceStore;
let outputChannel: vscode.LogOutputChannel;
let changeTimeout: NodeJS.Timeout | undefined;

// Tracking unresolved bases for background resolution
const pendingBases = new Set<{ uri: string, className: string, baseName: string, line: number, character: number }>();
const resolutionCache = new Map<string, string>(); // name#contextDoc -> targetUri
const globalResolutionCache = new Map<string, string>(); // baseName -> targetUri (Global for dotted names)
const projectClassIndex = new Map<string, string[]>(); // className -> URI[]

const BUILTIN_TYPES = new Set([
  'object', 'type', 'classmethod', 'staticmethod', 'property',
  'ABC', 'ABCMeta', 'dict', 'list', 'str', 'int', 'set', 'tuple', 'bool', 'None'
]);

/**
 * Simple semaphore to limit concurrent Pylance requests during background resolution
 */
class Semaphore {
  private queue: (() => void)[] = [];
  private activeCount = 0;

  constructor(private maxConcurrency: number) { }

  async acquire(): Promise<void> {
    if (this.activeCount < this.maxConcurrency) {
      this.activeCount++;
      return;
    }
    return new Promise(resolve => this.queue.push(resolve));
  }

  release(): void {
    this.activeCount--;
    if (this.queue.length > 0) {
      this.activeCount++;
      const next = this.queue.shift();
      if (next) next();
    }
  }

  async run<T>(task: () => Thenable<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }
}

const pylanceSemaphore = new Semaphore(8);

export async function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel('Python Inheritance', { log: true });
  outputChannel.info('Extension "vscode-python-inheritance" is now active!');
  store = new InheritanceStore(context);
  outputChannel.info(`Version ${store.version} is now ready!`);

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

  function getConfiguration() {
    return vscode.workspace.getConfiguration('pythonInheritance');
  }

  function safeRegisterCommand(commandId: string, callback: (...args: any[]) => any) {
    return vscode.commands.registerCommand(commandId, async (...args: any[]) => {
      try {
        await callback(...args);
      } catch (err: any) {
        outputChannel.error(`Error executing command ${commandId}: ${err.message}`);
        if (err.stack) outputChannel.error(err.stack);
        vscode.window.showErrorMessage(`Python Inheritance error: ${err.message}`);
      }
    });
  }

  async function updateDecorations(editor: vscode.TextEditor) {
    if (editor.document.languageId !== 'python') return;

    const config = getConfiguration();
    const showVars = config.get<boolean>('visualizeClassVariables', true);
    const showMethods = config.get<boolean>('visualizeMethods', true);

    let fileData = store.get(editor.document.uri);
    if (!fileData) {
      outputChannel.debug(`No cache for ${editor.document.uri.toString()}, triggering fast indexing...`);
      fileData = await analyzeFile(editor.document.uri, true);
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

        if (isMethod && !showMethods) continue;
        if (!isMethod && !showVars) continue;

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

    const definitions = await pylanceSemaphore.run(() =>
      vscode.commands.executeCommand<vscode.Location[] | vscode.LocationLink[]>(
        'vscode.executeDefinitionProvider',
        uri,
        position
      )
    );

    if (!definitions || definitions.length === 0) return undefined;

    const def = definitions[0];
    const targetUri = 'uri' in def ? def.uri : (def as vscode.LocationLink).targetUri;
    const targetRange = 'range' in def ? def.range : (def as vscode.LocationLink).targetRange;
    const targetSelectionRange = 'targetSelectionRange' in def ? (def as vscode.LocationLink).targetSelectionRange || targetRange : targetRange;

    const symbols = await pylanceSemaphore.run(() =>
      vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        targetUri
      )
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
        return { uri: targetUri, range: targetSelectionRange };
      }
    }

    return resolveSymbolDeeply(targetUri, targetSelectionRange.start, depth + 1);
  }

  async function analyzeFile(uri: vscode.Uri, shallow: boolean = false): Promise<FileData | undefined> {
    const symbols = await pylanceSemaphore.run(() =>
      vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        uri
      )
    );

    if (!symbols) return undefined;

    const config = getConfiguration();
    const showVars = config.get<boolean>('visualizeClassVariables', true);
    const showMethods = config.get<boolean>('visualizeMethods', true);

    const classes: ClassNode[] = [];
    let document: vscode.TextDocument | undefined;

    async function processSymbols(syms: vscode.DocumentSymbol[]) {
      for (const s of syms) {
        if (s.kind === vscode.SymbolKind.Class || s.kind === vscode.SymbolKind.Interface) {
          const className = s.name;
          const uriStr = uri.toString();

          const existing = projectClassIndex.get(className) || [];
          if (!existing.includes(uriStr)) {
            existing.push(uriStr);
            projectClassIndex.set(className, existing);
          }

          const members = s.children
            .filter(c => {
              const isMethod = c.kind === vscode.SymbolKind.Method || c.kind === vscode.SymbolKind.Function;
              const isVariable = c.kind === vscode.SymbolKind.Variable ||
                c.kind === vscode.SymbolKind.Field ||
                c.kind === vscode.SymbolKind.Property ||
                c.kind === vscode.SymbolKind.EnumMember ||
                c.kind === vscode.SymbolKind.Constant;

              if (isMethod && !showMethods) return false;
              if (isVariable && !showVars) return false;
              return isMethod || isVariable;
            })
            .map(m => ({
              name: m.name,
              kind: m.kind,
              range: InheritanceStore.fromRange(m.range),
              selectionRange: InheritanceStore.fromRange(m.selectionRange)
            }));

          const bases: any[] = [];
          if (!document) document = await vscode.workspace.openTextDocument(uri);

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
              if (name.includes('=') || BUILTIN_TYPES.has(name)) continue;

              const nameOffset = headerText.indexOf(name, lastOffset);
              if (nameOffset === -1) continue;
              lastOffset = nameOffset + name.length;

              const linesBefore = headerText.substring(0, nameOffset).split('\n');
              const baseLine = s.range.start.line + linesBefore.length - 1;
              const colInLine = linesBefore[linesBefore.length - 1].length;

              const lastDot = name.lastIndexOf('.');
              const charOffset = lastDot === -1 ? 0 : lastDot + 1;
              const baseChar = colInLine + charOffset;

              const baseEntry: any = {
                name: name.includes('.') ? name.split('.').pop()! : name,
                uri: "",
                range: { startLine: 0, startChar: 0, endLine: 0, endChar: 0 },
                resolvePos: { line: baseLine, character: baseChar }
              };

              bases.push(baseEntry);
              pendingBases.add({
                uri: uri.toString(),
                className: s.name,
                baseName: name,
                line: baseLine,
                character: baseChar
              });
            }
          }

          classes.push({
            uri: uri.toString(),
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

  async function limitConcurrency(tasks: (() => Promise<void>)[], limit: number, progressCb?: (count: number) => void) {
    let active = 0;
    let index = 0;
    let completed = 0;

    return new Promise<void>((resolve) => {
      const next = () => {
        if (index >= tasks.length && active === 0) {
          resolve();
          return;
        }

        while (active < limit && index < tasks.length) {
          active++;
          const taskIndex = index++;
          tasks[taskIndex]().then(() => {
            active--;
            completed++;
            if (progressCb) progressCb(completed);
            next();
          }).catch(err => {
            active--;
            completed++;
            next();
          });
        }
      };
      next();
    });
  }

  async function resolvePendingBases(token: vscode.CancellationToken, progress: vscode.Progress<{ message?: string, increment?: number }>) {
    const total = pendingBases.size;
    if (total === 0) return;

    outputChannel.info(`Starting background resolution for ${total} bases...`);
    const pendingList = Array.from(pendingBases);
    pendingBases.clear();

    const tasks = pendingList.map(item => async () => {
      if (token.isCancellationRequested) return;

      const baseSimpleName = item.baseName.includes('.') ? item.baseName.split('.').pop()! : item.baseName;
      const isDotted = item.baseName.includes('.');

      let targetUriStr = isDotted ? globalResolutionCache.get(item.baseName) : undefined;

      if (!targetUriStr) {
        const cacheKey = `${item.baseName}#${item.uri}`;
        targetUriStr = resolutionCache.get(cacheKey);
      }

      if (!targetUriStr) {
        const localMatches = projectClassIndex.get(baseSimpleName) || [];

        if (localMatches.length === 1 && !isDotted) {
          targetUriStr = localMatches[0];
        } else {
          const uriObj = vscode.Uri.parse(item.uri);
          const deepDef = await resolveSymbolDeeply(uriObj, new vscode.Position(item.line, item.character));
          if (deepDef) {
            targetUriStr = deepDef.uri.toString();
            if (isDotted) globalResolutionCache.set(item.baseName, targetUriStr);

            if (!store.get(deepDef.uri)) {
              const libData = await analyzeFile(deepDef.uri, true);
              if (libData) store.set(deepDef.uri, libData);
            }
          }
        }

        if (targetUriStr) resolutionCache.set(`${item.baseName}#${item.uri}`, targetUriStr);
      }

      if (targetUriStr) {
        const fileData = store.get(vscode.Uri.parse(item.uri));
        if (fileData) {
          const cls = fileData.classes.find(c => c.className === item.className);
          if (cls) {
            const base = cls.bases.find(b => b.resolvePos?.line === item.line && b.resolvePos?.character === item.character);
            if (base) {
              base.uri = targetUriStr;
            }
          }
        }
      }
    });

    let completed = 0;
    await limitConcurrency(tasks, 12, (count) => {
      completed++;
      if (completed % 250 === 0) {
        progress.report({ message: `Resolving: ${completed}/${total}` });
        if (completed % 1000 === 0) store.save();
      }
    });

    await store.save();
    outputChannel.info(`Background resolution completed.`);
  }

  function rebuildProjectIndex() {
    projectClassIndex.clear();
    for (const [uri, data] of (store as any).cache) {
      for (const cls of data.classes) {
        const existing = projectClassIndex.get(cls.className) || [];
        if (!existing.includes(uri)) {
          existing.push(uri);
          projectClassIndex.set(cls.className, existing);
        }
      }
    }
  }

  async function runIndexing(force: boolean = false) {
    const config = getConfiguration();
    const concurrency = config.get<number>('indexingConcurrency', 6);

    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "Python Inheritance Indexing",
      cancellable: true
    }, async (progress, token) => {
      const startTime = Date.now();
      rebuildProjectIndex();
      const allFiles = await vscode.workspace.findFiles('**/*.py', '**/node_modules/**');
      outputChannel.info(`Found ${allFiles.length} files. Starting discovery...`);

      const filesToIndex: vscode.Uri[] = [];
      const fileStats = new Map<string, number>();

      const statTasks = allFiles.map(file => async () => {
        if (token.isCancellationRequested) return;
        try {
          const stat = await vscode.workspace.fs.stat(file);
          fileStats.set(file.toString(), stat.mtime);
          if (force || !store.get(file) || store.get(file)!.mtime !== stat.mtime) {
            filesToIndex.push(file);
          }
        } catch (e) { }
      });

      await limitConcurrency(statTasks, 100);
      const totalToIndex = filesToIndex.length;

      if (totalToIndex > 0) {
        outputChannel.info(`[1/2] Discovering ${totalToIndex} project files...`);
        const projectTasks = filesToIndex.map(file => async () => {
          if (token.isCancellationRequested) return;
          const data = await analyzeFile(file, true);
          if (data) {
            data.mtime = fileStats.get(file.toString()) || 0;
            store.set(file, data);
          }
        });

        let lastReportedProgress = 0;
        await limitConcurrency(projectTasks, concurrency, (completed) => {
          const currentProgress = Math.round((completed / totalToIndex) * 100);
          if (currentProgress > lastReportedProgress) {
            progress.report({
              message: `[1/2] Discovery: ${currentProgress}%`,
              increment: currentProgress - lastReportedProgress
            });
            lastReportedProgress = currentProgress;
          }
          if (completed % 500 === 0) {
            outputChannel.info(`Discovery: ${completed}/${totalToIndex} files.`);
          }
        });

        await store.save();
        outputChannel.info(`[1/2] Discovery phase completed. Project ready.`);
      }

      await resolvePendingBases(token, progress);
      if (vscode.window.activeTextEditor) updateDecorations(vscode.window.activeTextEditor);
      codeLensProvider.refresh();
      outputChannel.info(`Total indexing completed in ${Date.now() - startTime}ms.`);
    });
  }

  const codeLensProvider = new InheritanceCodeLensProvider();
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ language: 'python' }, codeLensProvider)
  );

  if (getConfiguration().get<boolean>('indexOnStartup', true)) {
    runIndexing();
  }

  if (vscode.window.activeTextEditor) {
    updateDecorations(vscode.window.activeTextEditor);
  }

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (doc: vscode.TextDocument) => {
      if (doc.languageId !== 'python') return;
      if (getConfiguration().get<string>('indexingStrategy') !== 'onSave') return;

      const data = await analyzeFile(doc.uri, true);
      if (data) {
        const stat = await vscode.workspace.fs.stat(doc.uri);
        data.mtime = stat.mtime;
        store.set(doc.uri, data);
        await store.save();
        vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "Resolving..." }, (progress, token) => resolvePendingBases(token, progress));
      }
      if (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document === doc) {
        updateDecorations(vscode.window.activeTextEditor);
        codeLensProvider.refresh();
      }
    }),
    vscode.window.onDidChangeActiveTextEditor((editor: vscode.TextEditor | undefined) => {
      if (editor) updateDecorations(editor);
    }),

    safeRegisterCommand('pythonInheritance.resetCache', async () => {
      await context.workspaceState.update(InheritanceStore.STORAGE_KEY, undefined);
      vscode.window.showInformationMessage('Inheritance Cache cleared. Reload window to re-index.');
    }),

    safeRegisterCommand('pythonInheritance.reindex', async () => {
      await runIndexing(true);
    }),

    safeRegisterCommand('pythonInheritance.showTargets', async (targets: any[], title: string) => {
      if (targets.length === 0) return;

      const formatPath = (uriStr: string) => {
        const uri = vscode.Uri.parse(uriStr);
        const relPath = vscode.workspace.asRelativePath(uri);

        // If it's a library (contains site-packages), make it pretty
        if (uriStr.includes('site-packages')) {
          const parts = uriStr.split('site-packages');
          return parts[parts.length - 1].replace(/^[\\\/]/, '');
        } else if (uriStr.includes('dist-packages')) {
          const parts = uriStr.split('dist-packages');
          return parts[parts.length - 1].replace(/^[\\\/]/, '');
        } else if (uriStr.includes('lib/python')) { // Standard library fallback
          const parts = uriStr.split(/lib\/python\d\.\d+/);
          return parts[parts.length - 1].replace(/^[\\\/]/, '');
        }

        return relPath;
      };

      const jumpTo = async (target: any) => {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(target.uri));
        const editor = await vscode.window.showTextDocument(doc);
        const range = InheritanceStore.toRange(target.range);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        editor.selection = new vscode.Selection(range.start, range.start);
      };

      // Rule 1: If only 1 target, jump immediately
      if (targets.length === 1) {
        return await jumpTo(targets[0]);
      }

      // Rule 2: Show formatted list
      const items = targets.map(t => ({
        label: `${t.className}.${t.name}`,
        description: formatPath(t.uri),
        target: t
      }));

      const selected = await vscode.window.showQuickPick(items, { title });
      if (selected) {
        await jumpTo(selected.target);
      }
    }),

    safeRegisterCommand('pythonInheritance.goToSuper', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const fileData = store.get(editor.document.uri);
      if (!fileData) return;

      const cursor = editor.selection.active;
      const cls = fileData.classes.find(c => InheritanceStore.toRange(c.range).contains(cursor));
      if (!cls) return;

      const mro = store.getFullMRO(editor.document.uri.toString(), cls.className);
      if (mro.length > 0) {
        const target = mro[0];
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(target.uri));
        const targetEditor = await vscode.window.showTextDocument(doc);
        const range = InheritanceStore.toRange(target.selectionRange);
        targetEditor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        targetEditor.selection = new vscode.Selection(range.start, range.start);
      }
    }),

    safeRegisterCommand('pythonInheritance.goToSub', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const fileData = store.get(editor.document.uri);
      if (!fileData) return;

      const cursor = editor.selection.active;
      const cls = fileData.classes.find(c => InheritanceStore.toRange(c.range).contains(cursor));
      if (!cls) return;

      const subs = store.getSubclasses(editor.document.uri.toString(), cls.className);
      if (subs.length > 0) {
        const target = subs[0];
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(target.uri));
        const targetEditor = await vscode.window.showTextDocument(doc);
        const range = InheritanceStore.toRange(target.selectionRange);
        targetEditor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        targetEditor.selection = new vscode.Selection(range.start, range.start);
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

    const config = vscode.workspace.getConfiguration('pythonInheritance');
    const showVars = config.get<boolean>('visualizeClassVariables', true);
    const showMethods = config.get<boolean>('visualizeMethods', true);

    const lenses: vscode.CodeLens[] = [];
    for (const node of fileData.classes) {
      const mro = store.getFullMRO(document.uri.toString(), node.className);
      const subClasses = store.getSubclasses(document.uri.toString(), node.className);

      for (const member of node.members || []) {
        const isMethod = member.kind === vscode.SymbolKind.Method || member.kind === vscode.SymbolKind.Function;
        if (isMethod && !showMethods) continue;
        if (!isMethod && !showVars) continue;

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
