import * as vscode from 'vscode';
import * as path from 'path';
import DiscoveryRepository from './discoveryRepository';
import ApiRepository from './apiRepository';
import { Utilities } from './Utilities';
import MetadataRepository from './metadataRepository';
import * as cs from './cs';
import { IWireUpCommands } from './wireUpCommand';
import { DynamicsUrlResolver } from './DynamicsWebApi/DynamicsUrlResolver';
import ExtensionConfiguration from './ExtensionConfiguration';

export default class DynamicsTreeView implements IWireUpCommands {
    public wireUpCommands(context: vscode.ExtensionContext, config?: vscode.WorkspaceConfiguration) {
        // register the provider and connect it to the treeview window
        // {
        //     authType: AuthenticationType.Windows,
        //     domain: "CONTOSO",
        //     username: "Administrator",
        //     password: "p@ssw0rd1",
        //     serverUrl: "http://win-a6ljo0slrsh/",
        //     webApiVersion: "v8.2" 
        // };

        const treeProvider = new DynamicsServerTreeProvider(context);

        vscode.window.registerTreeDataProvider(cs.dynamics.viewContainers.connections, treeProvider);
        
        // setup commands
        context.subscriptions.push(
            vscode.commands.registerCommand(cs.dynamics.controls.treeView.refreshEntry, (item?: TreeEntry) => {
                treeProvider.refresh(item);
            }) // <-- no semi-colon, comma starts next command registration

            , vscode.commands.registerCommand(cs.dynamics.controls.treeView.addConnection, (config: DynamicsWebApi.Config) => {
                // add the connection and refresh treeview
                treeProvider.addConnection(config);
                // create the message, if id exists this was an edit
                let message = '';
                if (config.id) {
                    message = `Updated Dynamics Connection: ${config.webApiUrl}`;
                } else {
                    message = `Added Dynamics Connection: ${config.webApiUrl}`;
                }
                // show the message
                vscode.window.showInformationMessage(
                    message
                );
            }) // <-- no semi-colon, comma starts next command registration

            , vscode.commands.registerCommand(cs.dynamics.controls.treeView.clickEntry, (label?: string) => { // Match name of command to package.json command
                // Run command code
                vscode.window.showInformationMessage(`Clicked ${label || ''}`);
            }) // <-- no semi-colon, comma starts next command registration
            
            , vscode.commands.registerCommand(cs.dynamics.controls.treeView.deleteEntry, (item: TreeEntry) => { // Match name of command to package.json command
                // Run command code
                treeProvider.removeConnection(item.config);
                vscode.window.showInformationMessage(
                    `Delete Dynamics Connection: ${item.config.webApiUrl}`
                );
            }) // <-- no semi-colon, comma starts next command registration
            , vscode.commands.registerCommand(cs.dynamics.controls.treeView.addEntry, (item: TreeEntry) => { // Match name of command to package.json command
                if (!item)
                {
                    vscode.commands.executeCommand(cs.dynamics.controls.treeView.openConnection);
                }

                if (item.itemType === EntryType.Solutions)
                {
                    vscode.env.openExternal(DynamicsUrlResolver.getSolutionUri(item.config)).then(opened =>
                        {
                            if (!opened)
                            {
                                treeProvider.retryWithMessage("There was a problem opening the Dynamics 365 browser window", () => {
                                    vscode.commands.executeCommand(cs.dynamics.controls.treeView.addEntry, item);
                                });
                            }
                        });
    
                        return;    
                }
            })   
            , vscode.commands.registerCommand(cs.dynamics.controls.treeView.editEntry, (item: TreeEntry) => { // Match name of command to package.json command
                // Run command code
                if (item.itemType === EntryType.Connection) {
                    vscode.commands.executeCommand(cs.dynamics.controls.treeView.openConnection, item.config);

                    return;
                }

                if (item.itemType === EntryType.Solution) {
                    vscode.env.openExternal(DynamicsUrlResolver.getSolutionUri(item.config, item.context.solutionid)).then(opened =>
                    {
                        if (!opened)
                        {
                            treeProvider.retryWithMessage("There was a problem opening the Dynamics 365 browser window", () => {
                                vscode.commands.executeCommand(cs.dynamics.controls.treeView.editEntry, item);
                            });
                        }
                    });

                    return;
                }

                vscode.window.showInformationMessage(cs.dynamics.controls.treeView.editEntry);
            }) // <-- no semi-colon, comma starts next command registration
        );
    }
}

class DynamicsServerTreeProvider implements vscode.TreeDataProvider<TreeEntry> {

    readonly connectionsGlobalStateKey = 'cloudsmith:dynamicsConnections';
	private _onDidChangeTreeData: vscode.EventEmitter<TreeEntry | undefined> = new vscode.EventEmitter<TreeEntry | undefined>();
    readonly onDidChangeTreeData: vscode.Event<TreeEntry | undefined> = this._onDidChangeTreeData.event;
    private _connections: DynamicsWebApi.Config[] = [];
    private _context: vscode.ExtensionContext;

	constructor(context: vscode.ExtensionContext) {
        this._context = context;
        const connections: DynamicsWebApi.Config[] | undefined = this._context.globalState.get(this.connectionsGlobalStateKey);
        if (connections && connections.length > 0) {
            this._connections = connections;
            this.refresh();
        }
    }
    
    public addConnection(...options: DynamicsWebApi.Config[]): void {
        options.forEach(o => {
            // Make sure the connection has an id
            if (!o.id) {
                // give this an id
                o.id = Utilities.NewGuid();
                // add it to the list
                this._connections.push(o); 
            } else {
                const updateIndex = this._connections.findIndex(c => c.id === o.id);
                this._connections[updateIndex] = o;
            }
        });

        // save to state
        this._context.globalState.update(this.connectionsGlobalStateKey, this._connections);
        // refresh the treeview
        this.refresh();
    }

    public removeConnection(connection: DynamicsWebApi.Config): void {
        const removeIndex = this._connections.findIndex(c => c.webApiUrl === connection.webApiUrl);
        if (removeIndex >= 0) {
            this._connections.splice(removeIndex, 1);
            this._context.globalState.update(this.connectionsGlobalStateKey, this._connections);
            this.refresh();
        }
    }

    refresh(item?:TreeEntry): void {
        this._onDidChangeTreeData.fire(item);
    }

	getTreeItem(element: TreeEntry): vscode.TreeItem {
		return element;
	}

	getChildren(element?: TreeEntry): Thenable<TreeEntry[]> {
        if (element) {
            const commandPrefix:string = Utilities.RemoveTrailingSlash(((element.command && element.command.arguments) || '').toString());

            switch (element.itemType) {
                case EntryType.Connection:
                    return this.getConnectionDetails(element, commandPrefix);
                case EntryType.Organization:
                    return Promise.resolve(this.getSolutionLevelDetails(element, commandPrefix));
                case EntryType.Solutions:
                    return this.getSolutionDetails(element, commandPrefix);
                case EntryType.Solution:
                    return Promise.resolve(this.getSolutionLevelDetails(element, commandPrefix));
                case EntryType.Processes:
                    return this.getProcessDetails(element, commandPrefix, element.context);
                case EntryType.Plugins:
                    return this.getPluginDetails(element, commandPrefix, element.context);
                case EntryType.Entities:
                    return this.getEntityDetails(element, commandPrefix, element.context);
                case EntryType.WebResources:
                    return this.getWebResourcesDetails(element, commandPrefix, element.context);
            }

            return; //return nothing if type falls through
        }

        return Promise.resolve(this.getConnections());
    }
    
	getConnections(): TreeEntry[] {
        const result: TreeEntry[] = [];
        
        this._connections.forEach(connection => {
            const displayName = (connection.name)
                ? connection.name
                : connection.webApiUrl.replace("http://", "").replace("https://", "");

            result.push(new TreeEntry(
                displayName, 
                EntryType.Connection, 
                vscode.TreeItemCollapsibleState.Collapsed, 
                connection.workstation || connection.domain,
                {
                    command: cs.dynamics.controls.treeView.clickEntry,
                    title: connection.webApiUrl,
                    arguments: [connection.webApiUrl]
                },
                connection                
            ));
        });

        return result;
    }
    
    retryWithMessage(errorMessage:string, retryFunction:any): void
    {
        vscode.window.showErrorMessage(errorMessage, "Try Again", "Close").then(selectedItem =>
            {
                switch (selectedItem)
                {
                    case "Try Again":
                        if (typeof retryFunction === "function")
                        {
                            retryFunction();
                        }

                        break;
                    case "Close":
                        break;
                }

                Promise.resolve(this);
            });
    }

    getConnectionDetails(element: TreeEntry, commandPrefix?:string): Promise<TreeEntry[]> {
        const connection = element.config;
		const api = new DiscoveryRepository(connection);
        
        return api.retrieveOrganizations()
            .then(orgs => {
                const result : TreeEntry[] = new Array();
                
                for (let i = 0; i < orgs.length; i++) {
                    const org = orgs[i];
                    const versionSplit = org.Version.split('.');

                    // Clone the current connection and override the endpoint and version.
                    const orgConnection = Utilities.Clone<DynamicsWebApi.Config>(connection);

                    orgConnection.webApiUrl = org.ApiUrl;
                    orgConnection.webApiVersion = `${versionSplit[0]}.${versionSplit[1]}`;

                    result.push(
                        new TreeEntry(
                            org.FriendlyName, 
                            EntryType.Organization,
                            vscode.TreeItemCollapsibleState.Collapsed,
                            org.Version, 
                            {
                                command: cs.dynamics.controls.treeView.clickEntry,
                                title: org.FriendlyName,
                                arguments: [`${commandPrefix || ''}/${org.Id}`]
                            },
                            orgConnection,
                            org)
                    );
                }
                return result;
            })
            .catch(err => {
                console.error(err.innererror ? err.innererror : err);

                this.retryWithMessage(`An error occurred while accessing organizations from ${connection.webApiUrl}`, () => this.getConnectionDetails(element, commandPrefix));

                return null;
            });
    }

    getSolutionLevelDetails(element: TreeEntry, commandPrefix?:string) : TreeEntry[] {
        let returnObject = [];
        const showDefaultSolution = ExtensionConfiguration.getConfigurationValue<boolean>(cs.dynamics.configuration.showDefaultSolution);
        
        if (element.itemType === EntryType.Solution || showDefaultSolution) {
            returnObject.push(new TreeEntry(
                'Entities',
                EntryType.Entities,
                vscode.TreeItemCollapsibleState.Collapsed, 
                null,
                {
                    command: cs.dynamics.controls.treeView.clickEntry,
                    title: 'Entities',
                    arguments: [`${commandPrefix || ''}/Entities`]
                },
                element.config,
                element.itemType === EntryType.Solution ? element.context.solutionid : undefined
            ));

            returnObject.push(new TreeEntry(
                'Processes',
                EntryType.Processes,
                vscode.TreeItemCollapsibleState.Collapsed, 
                null,
                {
                    command: cs.dynamics.controls.treeView.clickEntry,
                    title: 'Processes',
                    arguments: [`${commandPrefix || ''}/Processes`]
                },
                element.config,
                element.itemType === EntryType.Solution ? element.context.solutionid : undefined
            ));

            returnObject.push(new TreeEntry(
                'Web Resources',
                EntryType.WebResources,
                vscode.TreeItemCollapsibleState.Collapsed, 
                null,
                {
                    command: cs.dynamics.controls.treeView.clickEntry,
                    title: 'Web Resources',
                    arguments: [`${commandPrefix || ''}/WebResources`]
                },
                element.config,
                element.itemType === EntryType.Solution ? element.context.solutionid : undefined
            ));

            returnObject.push(new TreeEntry(
                'Plugins',
                EntryType.Plugins,
                vscode.TreeItemCollapsibleState.Collapsed, 
                null,
                {
                    command: cs.dynamics.controls.treeView.clickEntry,
                    title: 'Plugins',
                    arguments: [`${commandPrefix || ''}/Plugins`]
                },
                element.config,
                element.itemType === EntryType.Solution ? element.context.solutionid : undefined
            ));
        }

        if (element.itemType !== EntryType.Solution)
        {
            returnObject.push(
                new TreeEntry(
                    'Solutions',
                    EntryType.Solutions,
                    vscode.TreeItemCollapsibleState.Collapsed, 
                    null,
                    {
                        command: cs.dynamics.controls.treeView.clickEntry,
                        title: 'Solutions',
                        arguments: [`${commandPrefix || ''}/Solutions`]
                    },
                    element.config
                ));
        }

        return returnObject;
    }

    getSolutionDetails(element: TreeEntry, commandPrefix?:string): Promise<TreeEntry[]> {
		const api = new ApiRepository(element.config);
        
        return api.retrieveSolutions()
            .then(solutions => {
                const result : TreeEntry[] = new Array();

                if (!solutions)
                {
                    return;
                }

                for (let i = 0; i < solutions.length; i++) {
                    const solution: any = solutions[i];
                    result.push(
                        new TreeEntry(
                            solution.friendlyname, 
                            EntryType.Solution,
                            vscode.TreeItemCollapsibleState.Collapsed,
                            `v${solution.version} (${solution.ismanaged ? "Managed" :  "Unmanaged"})`, 
                            {
                                command: cs.dynamics.controls.treeView.clickEntry,
                                title: solution.friendlyname,
                                arguments: [`${commandPrefix || ''}/${solution.solutionid}`]
                            },
                            element.config,
                            solution)
                    );
                }
                return result;
            })
            .catch(err => {
                console.error(err.innererror ? err.innererror : err);

                this.retryWithMessage(`An error occurred while retrieving solutions from ${element.config.webApiUrl}`, () => this.getSolutionDetails(element, commandPrefix));

                return null;
            });
    }

    getPluginDetails(element: TreeEntry, commandPrefix?: string, solutionId?: string): Thenable<TreeEntry[]> {
		const api = new ApiRepository(element.config);
        
        return api.retrievePluginAssemblies(solutionId)
            .then(plugins => {
                const result : TreeEntry[] = new Array();

                if (!plugins) {
                    return;
                }

                for (let i = 0; i < plugins.length; i++) {
                    const plugin: any = plugins[i];
                    result.push(
                        new TreeEntry(
                            plugin.name, 
                            EntryType.Plugin,
                            vscode.TreeItemCollapsibleState.None,
                            `v${plugin.version} (${plugin.publickeytoken})`, 
                            {
                                command: cs.dynamics.controls.treeView.clickEntry,
                                title: plugin.friendlyname,
                                arguments: [`${commandPrefix || ''}/${plugin.pluginassemblyid}`]
                            },
                            element.config,
                            plugin)
                    );
                }
                return result;
            })
            .catch(err => {
                console.error(err.innererror ? err.innererror : err);

                this.retryWithMessage(`An error occurred while retrieving plug-in assemblies from ${element.config.webApiUrl}`, () => this.getPluginDetails(element, commandPrefix, solutionId));

                return null;
            });
    }

    getWebResourcesDetails(element: TreeEntry, commandPrefix?: string, solutionId?: string): Thenable<TreeEntry[]> {
		const api = new ApiRepository(element.config);
        
        return api.retrieveWebResources(solutionId)
            .then(webresources => {
                const result : TreeEntry[] = new Array();

                if (!webresources) {
                    return;
                }

                for (let i = 0; i < webresources.length; i++) {
                    const webresource: any = webresources[i];
                    result.push(
                        new TreeEntry(
                            webresource.name, 
                            EntryType.WebResource,
                            vscode.TreeItemCollapsibleState.None,
                            webresource.displayname, 
                            {
                                command: cs.dynamics.controls.treeView.clickEntry,
                                title: webresource.displayname,
                                arguments: [`${commandPrefix || ''}/${webresource.webresourceid}`]
                            },
                            element.config,
                            webresource)
                    );
                }
                return result;
            })
            .catch(err => {
                console.error(err.innererror ? err.innererror : err);

                this.retryWithMessage(`An error occurred while retrieving web resources from ${element.config.webApiUrl}`, () => this.getWebResourcesDetails(element, commandPrefix, solutionId));

                return null;
            });
    }

    getProcessDetails(element: TreeEntry, commandPrefix?: string, solutionId?: string): Thenable<TreeEntry[]> {
		const api = new ApiRepository(element.config);
        
        return api.retrieveProcesses(solutionId)
            .then(processes => {
                const result : TreeEntry[] = new Array();

                if (!processes) {
                    return;
                }

                for (let i = 0; i < processes.length; i++) {
                    const process: any = processes[i];
                    result.push(
                        new TreeEntry(
                            process.name, 
                            EntryType.Process,
                            vscode.TreeItemCollapsibleState.None,
                            process.displayname, 
                            {
                                command: cs.dynamics.controls.treeView.clickEntry,
                                title: process.displayname,
                                arguments: [`${commandPrefix || ''}/${process.workflowid}`]
                            },
                            element.config,
                            process)
                    );
                }
                return result;
            })
            .catch(err => {
                console.error(err.innererror ? err.innererror : err);

                this.retryWithMessage(`An error occurred while retrieving business processes from ${element.config.webApiUrl}`, () => this.getProcessDetails(element, commandPrefix, solutionId));

                return null;
            });
    }
    getEntityDetails(element: TreeEntry, commandPrefix?: string, solutionId?: string): Thenable<TreeEntry[]> {
		const api = new MetadataRepository(element.config);
        
        return api.retrieveEntities(solutionId)
            .then(entities => {
                const result : TreeEntry[] = new Array();
                
                if (!entities) {
                    return;
                }

                for (let i = 0; i < entities.length; i++) {
                    const entity = entities[i];
                    let displayName = entity.DisplayName && entity.DisplayName.LocalizedLabels && entity.DisplayName.LocalizedLabels.length > 0 ? entity.DisplayName.LocalizedLabels[0].Label : "";

                    result.push(
                        new TreeEntry(
                            displayName,
                            EntryType.Entity,
                            vscode.TreeItemCollapsibleState.None,
                            entity.LogicalName, 
                            {
                                command: cs.dynamics.controls.treeView.clickEntry,
                                title: displayName,
                                arguments: [`${commandPrefix || ''}/${entity.LogicalName}`]
                            },
                            element.config,
                            entity)
                    );
                }
                return result;
            })
            .catch(err => {
                console.error(err.innererror ? err.innererror : err);

                this.retryWithMessage(`An error occurred while retrieving entities from ${element.config.webApiUrl}`, () => this.getEntityDetails(element, commandPrefix, solutionId));

                return null;
            });
    }
}

class TreeEntry extends vscode.TreeItem {

	constructor(
        public readonly label: string,
        public readonly itemType: EntryType,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly subtext?: string,
        public readonly command?: vscode.Command,
        public readonly config?: DynamicsWebApi.Config,
        public readonly context?: any
	) {
        super(label, collapsibleState);
        this.contextValue = itemType.toString();

        switch (itemType) {
            case EntryType.Connection:
                    this.iconPath = {
                        light: path.join(__filename, '..', '..', 'resources', 'icons', 'light', 'server.svg'),
                        dark: path.join(__filename, '..', '..', 'resources', 'icons', 'dark', 'server.svg')
                    };
                break;
            case EntryType.Organization:
                  this.iconPath = {
                        light: path.join(__filename, '..', '..', 'resources', 'icons', 'light', 'dependency.svg'),
                        dark: path.join(__filename, '..', '..', 'resources', 'icons', 'dark', 'dependency.svg')
                    };
                break;
            case EntryType.Entities:
            case EntryType.Entity:
                    this.iconPath = {
                        light: path.join(__filename, '..', '..', 'resources', 'icons', 'light', 'object-ungroup.svg'),
                        dark: path.join(__filename, '..', '..', 'resources', 'icons', 'dark', 'object-ungroup.svg')
                    };
                break;
            case EntryType.Plugins:
            case EntryType.Plugin:
                  this.iconPath = {
                        light: path.join(__filename, '..', '..', 'resources', 'icons', 'light', 'plug.svg'),
                        dark: path.join(__filename, '..', '..', 'resources', 'icons', 'dark', 'plug.svg')
                    };
                break;
            case EntryType.Solutions:
            case EntryType.Solution:
                  this.iconPath = {
                        light: path.join(__filename, '..', '..', 'resources', 'icons', 'light', 'puzzle-piece.svg'),
                        dark: path.join(__filename, '..', '..', 'resources', 'icons', 'dark', 'puzzle-piece.svg')
                    };
                break;
        }
	}

	get tooltip(): string {
		return `${this.label}`;
	}

	get description(): string {
		return this.subtext || this.itemType.toString(); 
	}
}

enum EntryType {
    Connection = "Connection",
    Organization = "Organization",
    Entities = "Entities",
    Plugins = "Plugins",
    WebResources = "WebResources",
    Processes = "Processes",
    Solutions = "Solutions",
    Entity = "Entity",
    Plugin = "Plugin",
    WebResource = "WebResource",
    Process = "Process",
    Solution = "Solution",
    Entry = "Entry",
    Entries = "Entries"
}