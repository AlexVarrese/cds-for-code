import * as child_process from 'child_process';

/**
 * Helper funcion to open a folder in the user's file manager
 * @export
 * @param {string} folder folder to open
 */
export function openFolderInExplorer(folder: string) {
    let command = "";
    
    switch (process.platform) {
        case 'linux':
            command = 'xdg-open';
            break;
        case 'darwin':
            command = 'open';
            break;
        case 'win32':
            command = 'explorer.exe';
            break;
    }

	// executute open folder command
    if (command) {
        child_process.spawn(command, [folder]);
    }
}