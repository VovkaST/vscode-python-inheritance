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
}

export interface ClassNode {
    uri: string;
    className: string;
    range: SerializedRange;
    selectionRange: SerializedRange;
    methods: { name: string, range: SerializedRange, selectionRange: SerializedRange }[];
    bases: ClassBase[];
}

export interface FileData {
    mtime: number;
    classes: ClassNode[];
}

export class InheritanceStore {
    private static readonly STORAGE_KEY = 'pythonInheritanceGraph';
    private cache: Map<string, FileData> = new Map();

    constructor(private context: vscode.ExtensionContext) {
        this.load();
    }

    private load() {
        const stored = this.context.workspaceState.get<Record<string, FileData>>(InheritanceStore.STORAGE_KEY);
        if (stored) {
            this.cache = new Map(Object.entries(stored));
        }
    }

    public async save() {
        const obj: Record<string, FileData> = {};
        for (const [uri, data] of this.cache) {
            obj[uri] = data;
        }
        await this.context.workspaceState.update(InheritanceStore.STORAGE_KEY, obj);
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
