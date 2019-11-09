import * as vscode from 'vscode';
import * as cs from '../cs';
import IWireUpCommands from '../wireUpCommand';
import { DynamicsWebApi } from '../api/Types';
import ApiRepository from '../repositories/apiRepository';
import QuickPicker from '../helpers/QuickPicker';
import DynamicsTerminal, { TerminalCommand } from '../views/DynamicsTerminal';
import * as path from 'path';
import { TS } from 'typescript-linq';

export default class RegisterPluginAssembly implements IWireUpCommands {
    public workspaceConfiguration:vscode.WorkspaceConfiguration;

    public wireUpCommands(context: vscode.ExtensionContext, wconfig: vscode.WorkspaceConfiguration) {
        this.workspaceConfiguration = wconfig;

        // now wire a command into the context
        context.subscriptions.push(
			vscode.commands.registerCommand(cs.dynamics.controls.explorer.registerPluginFile, async (file?:vscode.Uri, ...arg2:any) => {
				vscode.commands.executeCommand(cs.dynamics.deployment.registerPluginAssembly, undefined, undefined, file);
			}),

            vscode.commands.registerCommand(cs.dynamics.deployment.registerPluginAssembly, async (config?:DynamicsWebApi.Config, pluginAssembly?:any, file?:vscode.Uri, solution?:any):Promise<any> => { 
                const workspaceFolder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0 ? vscode.workspace.workspaceFolders[0] : null;

                file = file || <vscode.Uri>await QuickPicker.pickAnyFile(workspaceFolder ? workspaceFolder.uri : undefined, false, "Choose the plugin assembly", { 'Assemblies': ['dll'] });
                if (!file) { return; }

                config = config || await QuickPicker.pickDynamicsOrganization(context, "Choose a Dynamics 365 Organization", true);
				if (!config) { return; }

				solution = solution || await QuickPicker.pickDynamicsSolution(config, "Choose a solution", true);
                pluginAssembly = pluginAssembly || await QuickPicker.pickDynamicsSolutionComponent(config, solution, DynamicsWebApi.SolutionComponent.PluginAssembly, "Choose a plugin assembly to update (or none for new)");

                const api = new ApiRepository(config);

                return DynamicsTerminal.showTerminal(path.join(context.globalStoragePath, "\\Tools\\CloudSmith.Dynamics365.AssemblyScanner\\"))
                    .then(async terminal => { 
                        return await terminal.run(new TerminalCommand(`.\\AssemblyScanner.exe "${file.fsPath}"`))
                            .then(tc => {
                                const assemblyInfo = JSON.parse(tc.output);
                                const types:any[] = new TS.Linq.Enumerator(assemblyInfo.Types).where(t => new TS.Linq.Enumerator((<any>t).Interfaces).any(i => i === "Microsoft.Xrm.Sdk.IPlugin")).toArray();
                                let assemblyId:string;

                                if (!types || types.length === 0) {
                                    vscode.window.showWarningMessage(`The plugin assembly could not find any valid Plugin classes when scanning '${file.fsPath}'`);

                                    return;
                                }

                                return api.uploadPluginAssembly(file, pluginAssembly ? pluginAssembly.pluginassemblyid : null)
                                    .then(pluginAssemblyId => {
                                        assemblyId = pluginAssemblyId;

                                        if (!pluginAssembly && solution) {
                                            return api.addSolutionComponent(solution, pluginAssemblyId, DynamicsWebApi.SolutionComponent.PluginAssembly, true, false);
                                        }                        
                                    })
                                    .then(response => {
                                        const promises:Promise<void>[] = [];

                                        for (let i = 0; i < types.length; i++) {
                                            promises.push(api.upsertPluginType(assemblyId, types[i].Name));
                                        }
                                        
                                        return Promise.all(promises);
                                    }).then(responses => {
                                        if (!pluginAssembly) {
                                            vscode.commands.executeCommand(cs.dynamics.controls.pluginStep.open, {});
                                        }
                                    }).then(() => {
                                        vscode.window.showInformationMessage(`The plugin assembly '${file.fsPath}' has been registered on the Dynamics 365 server.`);
                                    });
                            });                      
                    });
            })
        );
    }
}