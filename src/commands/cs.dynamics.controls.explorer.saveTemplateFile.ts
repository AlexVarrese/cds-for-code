import * as cs from "../cs";
import * as vscode from 'vscode';
import { TemplateType } from "../controls/Templates/Types";

/**
 * This command can be invoked by the Explorer file viewer and saves a file in your workspace as a template
 * @export run command function
 * @param {vscode.Uri} [defaultUri] that invoked the command
 * @returns void
 */
export default async function run(defaultUri?: vscode.Uri) {
	return await vscode.commands.executeCommand(cs.dynamics.templates.saveTemplate, defaultUri, TemplateType.ItemTemplate);
}