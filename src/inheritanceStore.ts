import * as vscode from 'vscode';

export interface SerializedRange {
  startLine: number;
  startChar: number;
  endLine: number;
  endChar: number;
}

export interface ClassBase {
  name: string;
  uri: string;
  range: SerializedRange;
  resolvePos?: { line: number, character: number };
}

export interface ClassNode {
  uri: string;
  className: string;
  range: SerializedRange;
  selectionRange: SerializedRange;
  members: { name: string, kind: number, range: SerializedRange, selectionRange: SerializedRange }[];
  bases: ClassBase[];
}

export interface FileData {
  mtime: number;
  classes: ClassNode[];
}

export interface StoredData {
  version: string;
  files: Record<string, FileData>;
}

export class InheritanceStore {
  public static readonly STORAGE_KEY = 'pythonInheritanceGraph';
  private cache: Map<string, FileData> = new Map();
  public readonly version: string;

  constructor(private context: vscode.ExtensionContext) {
    this.version = context.extension.packageJSON.version;
    this.load();
  }

  private load() {
    const stored = this.context.workspaceState.get<any>(InheritanceStore.STORAGE_KEY);
    if (stored) {
      let files: Record<string, any>;

      // Handle migration from old format (Record<string, FileData>) to new format (StoredData)
      if (stored.version && stored.files) {
        files = stored.files;
        if (stored.version !== this.version) {
          console.log(`[InheritanceStore] Version mismatch: stored=${stored.version}, current=${this.version}`);
          // Potential migration logic here
        }
      } else {
        files = stored;
      }

      for (const fileUri in files) {
        const fileData = files[fileUri];
        if (fileData.classes) {
          for (const node of fileData.classes) {
            // Existing migration for members/methods
            if ((node as any).methods && !node.members) {
              node.members = (node as any).methods.map((m: any) => ({
                ...m,
                kind: m.kind || vscode.SymbolKind.Method
              }));
              delete (node as any).methods;
            }
          }
        }
      }
      this.cache = new Map(Object.entries(files));
    }
  }

  public async save() {
    const files: Record<string, FileData> = {};
    for (const [uri, data] of this.cache) {
      files[uri] = data;
    }

    const storedData: StoredData = {
      version: this.version,
      files
    };

    await this.context.workspaceState.update(InheritanceStore.STORAGE_KEY, storedData);
  }

  public get(uri: vscode.Uri): FileData | undefined {
    return this.cache.get(uri.toString());
  }

  public set(uri: vscode.Uri, data: FileData) {
    this.cache.set(uri.toString(), data);
  }

  /**
   * Finds all parents of a class (recursive)
   */
  public getFullMRO(uri: string, className: string): ClassNode[] {
    const mro: ClassNode[] = [];
    const visited = new Set<string>();
    const queue: { uri: string, name: string }[] = [{ uri, name: className }];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const key = `${current.uri}#${current.name}`;
      if (visited.has(key)) continue;
      visited.add(key);

      const fileData = this.cache.get(current.uri);
      if (fileData) {
        const node = fileData.classes.find(c => c.className === current.name);
        if (node) {
          if (key !== `${uri}#${className}`) {
            mro.push(node);
          }
          for (const base of node.bases) {
            queue.push({ uri: base.uri, name: base.name });
          }
        }
      }
    }
    return mro;
  }

  /**
   * Finds all direct subclasses of a class
   */
  public getSubclasses(uri: string, className: string): ClassNode[] {
    const subs: ClassNode[] = [];
    for (const [fileUri, data] of this.cache) {
      for (const node of data.classes) {
        if (node.bases.some(b => b.uri === uri && b.name === className)) {
          subs.push(node);
        }
      }
    }
    return subs;
  }

  public static toRange(sr: SerializedRange): vscode.Range {
    return new vscode.Range(sr.startLine, sr.startChar, sr.endLine, sr.endChar);
  }

  public static fromRange(r: vscode.Range): SerializedRange {
    return {
      startLine: r.start.line,
      startChar: r.start.character,
      endLine: r.end.line,
      endChar: r.end.character
    };
  }
}
