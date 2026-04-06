import * as vscode from 'vscode';

export interface InheritanceInfo {
    onOverrides: vscode.Location[];
    isOverriddenBy: vscode.Location[];
}

export class PythonAnalyzer {
    /**
     * Finds base class implementations of a given method.
     */
    static async findSuperImplementations(uri: vscode.Uri, position: vscode.Position, methodName: string): Promise<vscode.Location[]> {
        let superItems: vscode.TypeHierarchyItem[] = [];
        
        try {
            const items = await vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>(
                'vscode.prepareTypeHierarchy',
                uri,
                position
            );
            if (items && items.length > 0) {
                const commands = ['vscode.provideTypeHierarchySupertypes', 'vscode.executeTypeHierarchySupertypes'];
                for (const cmd of commands) {
                    try {
                        const result = await vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>(cmd, items[0]);
                        if (result) {
                            superItems = result;
                            break;
                        }
                    } catch (e) { /* ignore and try next command */ }
                }
            }
        } catch (e) {
            console.error('TypeHierarchy failed, using fallback:', e);
        }

        const superLocs: vscode.Location[] = [];

        if (superItems.length > 0) {
            // Standard approach using TypeHierarchy
            for (const parent of superItems) {
                const loc = await this.findMethodInFile(parent.uri, parent.name, methodName);
                if (loc) superLocs.push(loc);
            }
        } else {
            // FALLBACK: Parse class header to find base classes
            // 1. Get symbols to find the containing class
            const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                'vscode.executeDocumentSymbolProvider',
                uri
            );
            if (!symbols) return [];

            const findClassContaining = (syms: vscode.DocumentSymbol[]): vscode.DocumentSymbol | undefined => {
                for (const s of syms) {
                    if ((s.kind === vscode.SymbolKind.Class) && s.range.contains(position)) return s;
                    const found = findClassContaining(s.children);
                    if (found) return found;
                }
                return undefined;
            };

            const classSym = findClassContaining(symbols);
            if (!classSym) return [];

            // 2. Read the class declaration line
            const doc = await vscode.workspace.openTextDocument(uri);
            const classLine = doc.lineAt(classSym.range.start.line).text;
            
            // Regex to find parent classes: class Child(Base1, Base2):
            const match = classLine.match(/class\s+\w+\s*\(([^)]+)\)/);
            if (match) {
                const baseNames = match[1].split(',').map(s => s.trim());
                for (const baseName of baseNames) {
                    // Try to resolve the base class definition
                    const basePos = classLine.indexOf(baseName);
                    if (basePos === -1) continue;
                    
                    const definitions = await vscode.commands.executeCommand<vscode.Location[] | vscode.LocationLink[]>(
                        'vscode.executeDefinitionProvider',
                        uri,
                        new vscode.Position(classSym.range.start.line, basePos)
                    );

                    if (definitions && definitions.length > 0) {
                        const def = definitions[0];
                        const baseUri = 'uri' in def ? def.uri : def.targetUri;
                        const baseClassName = baseName.includes('.') ? baseName.split('.').pop()! : baseName;
                        const loc = await this.findMethodInFile(baseUri, baseClassName, methodName);
                        if (loc) superLocs.push(loc);
                    }
                }
            }
        }

        return superLocs;
    }

    /**
     * Helper to find a method within a specific class in a file.
     */
    private static async findMethodInFile(uri: vscode.Uri, className: string, methodName: string): Promise<vscode.Location | undefined> {
        const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
            'vscode.executeDocumentSymbolProvider',
            uri
        );
        if (!symbols) return undefined;

        const findMethod = (syms: vscode.DocumentSymbol[]): vscode.DocumentSymbol | undefined => {
            for (const s of syms) {
                if (s.name === className && (s.kind === vscode.SymbolKind.Class || s.kind === vscode.SymbolKind.Interface)) {
                    return s.children.find(child => child.name === methodName && (child.kind === vscode.SymbolKind.Method || child.kind === vscode.SymbolKind.Function));
                }
                const found = findMethod(s.children);
                if (found) return found;
            }
            return undefined;
        };

        const methodSym = findMethod(symbols);
        return methodSym ? new vscode.Location(uri, methodSym.selectionRange) : undefined;
    }

    /**
     * Finds subclass overrides of a given method.
     */
    static async findSubImplementations(uri: vscode.Uri, position: vscode.Position): Promise<vscode.Location[]> {
        const implementations = await vscode.commands.executeCommand<vscode.Location[] | vscode.LocationLink[]>(
            'vscode.executeImplementationProvider',
            uri,
            position
        );

        if (!implementations) {
            return [];
        }

        // Filter out the current location
        return implementations.filter((loc: vscode.Location | vscode.LocationLink) => {
            const l = 'uri' in loc ? loc.uri : loc.targetUri;
            const r = 'range' in loc ? loc.range : loc.targetRange;
            return !(l.toString() === uri.toString() && r.contains(position));
        }).map((loc: vscode.Location | vscode.LocationLink) => 'uri' in loc ? loc : new vscode.Location(loc.targetUri, loc.targetRange));
    }
}
