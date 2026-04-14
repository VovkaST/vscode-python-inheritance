import * as vscode from 'vscode';

export interface InheritanceInfo {
  onOverrides: vscode.Location[];
  isOverriddenBy: vscode.Location[];
}

export class PythonAnalyzer {
  /**
   * Finds base class implementations of a given member (method or variable).
   */
  static async findSuperImplementations(uri: vscode.Uri, position: vscode.Position, memberName: string, memberKind?: vscode.SymbolKind): Promise<vscode.Location[]> {
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
        const loc = await this.findMemberInFile(parent.uri, parent.name, memberName, memberKind);
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

      // 2. Read the class declaration (potentially multi-line)
      const doc = await vscode.workspace.openTextDocument(uri);
      let headerText = "";
      let currentLine = classSym.range.start.line;
      let openParens = 0;
      let foundColon = false;

      while (currentLine < doc.lineCount && currentLine <= classSym.range.end.line) {
        const line = doc.lineAt(currentLine).text;
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
        const baseNames = baseNamesStr.split(',').map(s => s.trim()).filter(n => n.length > 0);

        let lastOffset = 0;
        for (const baseName of baseNames) {
          if (baseName.includes('=')) continue;

          const nameOffset = headerText.indexOf(baseName, lastOffset);
          if (nameOffset === -1) continue;
          lastOffset = nameOffset + baseName.length;

          const linesBefore = headerText.substring(0, nameOffset).split('\n');
          const baseLine = classSym.range.start.line + linesBefore.length - 1;
          const baseChar = linesBefore[linesBefore.length - 1].length;

          const definitions = await vscode.commands.executeCommand<vscode.Location[] | vscode.LocationLink[]>(
            'vscode.executeDefinitionProvider',
            uri,
            new vscode.Position(baseLine, baseChar)
          );

          if (definitions && definitions.length > 0) {
            const def = definitions[0];
            const baseUri = 'uri' in def ? def.uri : def.targetUri;
            const baseClassName = baseName.includes('.') ? baseName.split('.').pop()! : baseName;
            const loc = await this.findMemberInFile(baseUri, baseClassName, memberName, memberKind);
            if (loc) superLocs.push(loc);
          }
        }
      }
    }

    return superLocs;
  }

  /**
   * Helper to find a member within a specific class in a file.
   */
  private static async findMemberInFile(uri: vscode.Uri, className: string, memberName: string, memberKind?: vscode.SymbolKind): Promise<vscode.Location | undefined> {
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      'vscode.executeDocumentSymbolProvider',
      uri
    );
    if (!symbols) return undefined;

    const findMember = (syms: vscode.DocumentSymbol[]): vscode.DocumentSymbol | undefined => {
      for (const s of syms) {
        if (s.name === className && (s.kind === vscode.SymbolKind.Class || s.kind === vscode.SymbolKind.Interface)) {
          return s.children.find(child =>
            child.name === memberName &&
            (!memberKind || child.kind === memberKind)
          );
        }
        const found = findMember(s.children);
        if (found) return found;
      }
      return undefined;
    };

    const memberSym = findMember(symbols);
    return memberSym ? new vscode.Location(uri, memberSym.selectionRange) : undefined;
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
