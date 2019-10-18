// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as cs from './cs';
// config
import ExtensionConfiguration from './ExtensionConfiguration';
import ConnectionViewManager from './connectionViewManager';
import GenerateEntitiesCommand from './generateEntitiesCommand';
import PowerShellLoader from './powerShellLoader';
import DynamicsTreeView from './dynamicsTreeView';
import { IWireUpCommands } from './wireUpCommand';

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
// *****************
// More on activation events can be found here: https://code.visualstudio.com/api/references/activation-events#Start-up
// *****************
export function activate(context: vscode.ExtensionContext) {
	
	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('[CloudSmith]: extension:activate');
	
	// load and check extension configuration
	const config = ExtensionConfiguration.getConfiguration(cs.dynamics.configuration._namespace);

	// setup what we want to initialize
	const commands: IWireUpCommands[] = [
		// our views
		new DynamicsTreeView(),
		new ConnectionViewManager(),
		// our commands
		new PowerShellLoader(),
		new GenerateEntitiesCommand()
	];

	// call to wire up all commands
	commands.forEach(c => c.wireUpCommands(context, config));
	
	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json

	// They will all get pushed into these subscriptions using an ...items spread
	context.subscriptions.push(
		vscode.commands.registerCommand(cs.dynamics.powerShell.unpackSolution, () => { // Match name of command to package.json command
			// Run command code
			vscode.window.showInformationMessage(
				cs.dynamics.powerShell.unpackSolution
			);
		}) // <-- no semi-colon, comma starts next command registration

		, vscode.commands.registerCommand(cs.dynamics.powerShell.packSolution, () => { // Match name of command to package.json command
			// Run command code
			vscode.window.showInformationMessage(
				cs.dynamics.powerShell.packSolution
			);
		}) // <-- no semi-colon, comma starts next command registration
	);
}

// this method is called when your extension is deactivated
export function deactivate() { }