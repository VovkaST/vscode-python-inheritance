import * as vscode from 'vscode';

export async function listCommands() {
    const cmds = await vscode.commands.getCommands();
    const filtered = cmds.filter(c => c.includes('TypeHierarchy'));
    console.log('Available TypeHierarchy commands:', filtered);
    return filtered;
}
