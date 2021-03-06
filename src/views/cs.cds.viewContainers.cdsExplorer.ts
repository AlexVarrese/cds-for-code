import * as vscode from 'vscode';
import * as cs from '../cs';
import * as CdsUtilities from '../api/CdsUtilities';
import { Utilities } from '../core/Utilities';
import { TS } from 'typescript-linq/TS';
import { CdsWebApi } from '../api/cds-webapi/CdsWebApi';
import { CdsSolutions } from '../api/CdsSolutions';
import { ExtensionIconThemes } from "../components/WebDownloaders/Types";
import { extensionActivate } from '../core/Extension';
import DiscoveryRepository from '../repositories/discoveryRepository';
import ApiRepository from '../repositories/apiRepository';
import MetadataRepository from '../repositories/metadataRepository';
import CdsUrlResolver from '../api/CdsUrlResolver';
import ExtensionConfiguration from '../core/ExtensionConfiguration';
import Quickly from '../core/Quickly';
import SolutionMap from '../components/Solutions/SolutionMap';
import SolutionWorkspaceMapping from "../components/Solutions/SolutionWorkspaceMapping";
import logger from '../core/framework/Logger';
import command from '../core/Command';
import Dictionary from '../core/types/Dictionary';
import ExtensionContext from '../core/ExtensionContext';
import Telemetry, { telemetry } from '../core/framework/Telemetry';
import async = require('async');

/**
 * TreeView implementation that helps end-users navigate items in their Common Data Services (CDS) environments.
 * This class implements VSCode's TreeDataProvider and is used as a single-instance (singleton) in the CDS for Code toolkit.
 * @export
 * @class CdsExplorerView
 * @implements {vscode.TreeDataProvider<CdsTreeEntry>}
 */
export default class CdsExplorer implements vscode.TreeDataProvider<CdsTreeEntry> {
	private _onDidChangeTreeData: vscode.EventEmitter<CdsTreeEntry | undefined> = new vscode.EventEmitter<CdsTreeEntry | undefined>();
    readonly onDidChangeTreeData: vscode.Event<CdsTreeEntry | undefined> = this._onDidChangeTreeData.event;
    private _connections: CdsWebApi.Config[] = [];
    private _orgConnections: CdsWebApi.Config[] = [];

    private static instance: CdsExplorer;

	private constructor() {
        this._connections = DiscoveryRepository.getConnections(ExtensionContext.Instance);
    }

    /**
     * Gets the singleton implementation of CdsExplorerView
     *
     * @readonly
     * @static
     * @type {CdsExplorer}
     * @memberof CdsExplorerView
     */
    static get Instance(): CdsExplorer {
        if (!CdsExplorer.instance) {
            CdsExplorer.instance = new CdsExplorer();
        }

        return CdsExplorer.instance;
    }

    private static readonly addCommands = new Dictionary<CdsExplorerEntryType, (item?: CdsTreeEntry) => Promise<void>>([
        { key: "Applications", value: async (item) => Utilities.Browser.openWindow(CdsUrlResolver.getManageAppUri(item.config, undefined, item.solution || item.parent.context.ActiveSolution)) },
        { key: "Solutions", value: async (item) => Utilities.Browser.openWindow(CdsUrlResolver.getManageSolutionUri(item.config)) },
        { key: "Entities", value: async (item) => Utilities.Browser.openWindow(CdsUrlResolver.getManageEntityUri(item.config, undefined, item.solution)) },
        { key: "Attributes", value: async (item) => Utilities.Browser.openWindow(CdsUrlResolver.getManageAttributeUri(item.config, item.context.MetadataId, undefined, item.solutionId)) },
        { key: "OptionSets", value: async (item) => Utilities.Browser.openWindow(CdsUrlResolver.getManageOptionSetUri(item.config, item.parent && item.parent.context ? item.parent.context.MetadataId : undefined, item.parent && item.parent.context ? item.parent.context.ObjectTypeCode : undefined, undefined, item.solutionId)) },
        { key: "Processes", value: async (item) => {
            const process: any = await vscode.commands.executeCommand(cs.cds.deployment.createProcess, item.config, item.solutionId);
            
            if (process) {
                CdsExplorer.Instance.refresh(item);
                Utilities.Browser.openWindow(CdsUrlResolver.getManageBusinessProcessUri(item.config, process.processType, process.workflowid, process.solutionid || undefined));
            }            
        }},
        { key: "Keys", value: async (item) => Utilities.Browser.openWindow(CdsUrlResolver.getManageEntityKeyUrl(item.config, item.context.MetadataId, undefined, item.solutionId)) },
        { key: "Relationships", value: async (item) => Utilities.Browser.openWindow(CdsUrlResolver.getManageEntityRelationshipUrl(item.config, item.context.MetadataId, undefined, item.solutionId)) },
        { key: "Forms", value: async (item) => {
            const formType = await Quickly.pickEnum<CdsSolutions.DynamicsForm>(CdsSolutions.DynamicsForm);

            if (formType) {
                Utilities.Browser.openWindow(CdsUrlResolver.getManageEntityFormUri(item.config, item.context.ObjectTypeCode, formType, undefined, item.solutionId));
            }
        }},
        { key: "Dashboards", value: async (item) => {
            const layoutType = await Quickly.pickEnum<CdsSolutions.InteractiveDashboardLayout>(CdsSolutions.InteractiveDashboardLayout);

            if (layoutType) {
                Utilities.Browser.openWindow(CdsUrlResolver.getManageEntityDashboardUri(item.config, item.context.ObjectTypeCode, layoutType, "1030", undefined, item.solutionId));
            }
        }},
        { key: "Views", value: async (item) => Utilities.Browser.openWindow(CdsUrlResolver.getManageEntityViewUri(item.config, item.context.MetadataId, item.context.ObjectTypeCode, undefined, item.solutionId)) },
        { key: "Charts", value: async (item) => Utilities.Browser.openWindow(CdsUrlResolver.getManageEntityChartUrl(item.config, item.context.ObjectTypeCode, undefined, item.solutionId)) },
        { key: "WebResources", value: async (item) => {
            const hasWorkspace = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0;
        
            if (hasWorkspace) {
                await vscode.commands.executeCommand(cs.cds.deployment.createWebResource, item.config, item.solutionId, undefined, undefined, item.folder);
            } else {
                Utilities.Browser.openWindow(CdsUrlResolver.getManageWebResourceUri(item.config, undefined, item.solutionId));
            }
        }},
        { key: "PluginType", value: async (item) => await vscode.commands.executeCommand(cs.cds.controls.pluginStep.open, item.context._pluginassemblyid_value, undefined, item.config, item) },
        { key: "PluginStep", value: async (item) => await vscode.commands.executeCommand(cs.cds.controls.pluginStepImage.open, item.context.sdkmessageprocessingstepid, undefined, item.config, item) }
    ]);

    private static readonly deleteCommands = new Dictionary<CdsExplorerEntryType, (item?: CdsTreeEntry) => Promise<void>>([
        { key: "Connection", value: async (item) => CdsExplorer.Instance.removeConnection(item.config) },
        { key: "PluginStep", value: async (item) => CdsExplorer.Instance.removePluginStep(item.config, item.context).then(() => CdsExplorer.Instance.refresh(item.parent)) },
        { key: "PluginStepImage", value: async (item) => CdsExplorer.Instance.removePluginStepImage(item.config, item.context).then(() => CdsExplorer.Instance.refresh(item.parent)) }
    ]);

    private static readonly editCommands = new Dictionary<CdsExplorerEntryType, (item?: CdsTreeEntry) => Promise<void>>([
        { key: "Connection", value: async (item) => await vscode.commands.executeCommand(cs.cds.controls.cdsExplorer.editConnection, item.config) },
        { key: "Application", value: async (item) => Utilities.Browser.openWindow(CdsUrlResolver.getManageAppUri(item.config, item.context, item.solution || item.parent.context.ActiveSolution)) },
        { key: "Solution", value: async (item) => Utilities.Browser.openWindow(CdsUrlResolver.getManageSolutionUri(item.config, item.context)) },
        { key: "Entity", value: async (item) => Utilities.Browser.openWindow(CdsUrlResolver.getManageEntityUri(item.config, item.context, item.solution)) },
        { key: "Attribute", value: async (item) => Utilities.Browser.openWindow(CdsUrlResolver.getManageAttributeUri(item.config, item.parent.context.MetadataId, item.context.MetadataId, item.solutionId)) },
        { key: "OptionSet", value: async (item) => Utilities.Browser.openWindow(CdsUrlResolver.getManageOptionSetUri(item.config, item.parent && item.parent.context ? item.parent.context.MetadataId : undefined, item.parent && item.parent.context ? item.parent.context.ObjectTypeCode : undefined, item.context.MetadataId, item.solutionId)) },
        { key: "Process", value: async (item) => Utilities.Browser.openWindow(CdsUrlResolver.getManageBusinessProcessUri(item.config, CdsUrlResolver.parseProcessType(item.context.category), item.context.workflowid, item.solutionId || undefined)) },
        { key: "Key", value: async (item) => Utilities.Browser.openWindow(CdsUrlResolver.getManageEntityKeyUrl(item.config, item.parent.context.MetadataId, item.context.MetadataId, item.solutionId)) },
        { key: "OneToManyRelationship", value: async (item) => Utilities.Browser.openWindow(CdsUrlResolver.getManageEntityRelationshipUrl(item.config, item.parent.context.MetadataId, item.context.MetadataId, item.solutionId)) },
        { key: "ManyToOneRelationship", value: async (item) => Utilities.Browser.openWindow(CdsUrlResolver.getManageEntityRelationshipUrl(item.config, item.parent.context.MetadataId, item.context.MetadataId, item.solutionId)) },
        { key: "ManyToManyRelationship", value: async (item) => Utilities.Browser.openWindow(CdsUrlResolver.getManageEntityRelationshipUrl(item.config, item.parent.context.MetadataId, item.context.MetadataId, item.solutionId)) },
        { key: "Form", value: async (item) => Utilities.Browser.openWindow(CdsUrlResolver.getManageEntityFormUri(item.config, item.parent.context.ObjectTypeCode, CdsUrlResolver.parseFormType(item.context.type), item.context.formid, item.solutionId)) },
        { key: "Dashboard", value: async (item) => Utilities.Browser.openWindow(CdsUrlResolver.getManageEntityDashboardUri(item.config, undefined, undefined, "1032", item.context.formid, item.solutionId)) },
        { key: "View", value: async (item) => Utilities.Browser.openWindow(CdsUrlResolver.getManageEntityViewUri(item.config, item.parent.context.MetadataId, item.parent.context.ObjectTypeCode, item.context.savedqueryid, item.solutionId)) },
        { key: "Chart", value: async (item) => Utilities.Browser.openWindow(CdsUrlResolver.getManageEntityChartUrl(item.config, item.parent.context.ObjectTypeCode, item.context.savedqueryvisualizationid, item.solutionId)) },
        { key: "WebResource", value: async (item) => {
            const hasWorkspace = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0;
        
            if (hasWorkspace) {
                await vscode.commands.executeCommand(cs.cds.deployment.unpackWebResource, item.config, item.context, undefined, true);
            } else {
                Utilities.Browser.openWindow(CdsUrlResolver.getManageWebResourceUri(item.config, item.context.webresourceid, item.solutionId));
            }
        }},
        { key: "PluginStep", value: async (item) => await vscode.commands.executeCommand(cs.cds.controls.pluginStep.open, item.context.eventhandler_plugintype._pluginassemblyid_value, item.context, item.config, item) },
        { key: "PluginStepImage", value: async (item) => await vscode.commands.executeCommand(cs.cds.controls.pluginStepImage.open, item.context._sdkmessageprocessingstepid_value, item.context, item.config, item) }
    ]);

    private static readonly folderParsers = new Dictionary<CdsExplorerEntryType, (item: any, element?: CdsTreeEntry, ...rest: any[]) => CdsTreeEntry>([
        { key: "WebResource", value: (container, element) => element.createChildItem("Folder", container, container, '', vscode.TreeItemCollapsibleState.Collapsed, { innerType: "WebResources", innerContext: (element.context && element.context.innerContext ? element.context.innerContext : element.context) }) }
    ]);

    private readonly getChildrenCommands = new Dictionary<CdsExplorerEntryType, (element?: CdsTreeEntry) => Promise<CdsTreeEntry[]>>([
        { key: "Connection", value: async (element?) => await this.getConnectionDetails(element) },
        { key: "Organization", value: async (element?) => await this.getSolutionLevelDetails(element) },
        { key: "Applications", value: async (element?) => await this.getApplicationDetails(element, element.context) },
        { key: "Solutions", value: async (element?) => await this.getSolutionDetails(element) },
        { key: "Solution", value: async (element?) => await this.getSolutionLevelDetails(element) },
        { key: "Processes", value: async (element?) => await this.getProcessDetails(element, element.context) },
        { key: "Plugins", value: async (element?) => await this.getPluginDetails(element, element.context) },
        { key: "Entities", value: async (element?) => await this.getEntityDetails(element, element.context) },
        { key: "OptionSets", value: async (element?) => await this.getOptionSetDetails(element, element.context) },
        { key: "OptionSet", value: async (element?) => await this.getOptionDetails(element) },
        { key: "WebResources", value: async (element?) => {
            const results = Promise.all([ 
                CdsExplorer.Instance.getWebResourcesFolderDetails(element, (element.context && element.context.innerContext ? element.context.innerContext : element.context), element.folder), 
                CdsExplorer.Instance.getWebResourcesDetails(element, (element.context && element.context.innerContext ? element.context.innerContext : element.context), element.folder)
            ]);

            let [ folders, items ] = await results;
            if (items && folders) { items.forEach(i => folders.push(i)); }

            return folders && folders.length > 0 ? folders : items;
        }},
        { key: "Folder", value: async (element?) => await this.getChildrenCommands[element.context.innerType](element) },
        { key: "Plugin", value: async (element?) => await this.getPluginTypeDetails(element, element.context) },
        { key: "PluginType", value: async (element?) => await this.getPluginStepDetails(element, element.context) },
        { key: "PluginStep", value: async (element?) => await this.getPluginStepImageDetails(element, element.context) },
        { key: "Entity", value: async (element?) => await this.createContainers(element, element.itemType, [ "Keys", "Attributes", "Relationships", "Views", "Charts", "Forms", "Dashboards", "Processes"]) },
        { key: "Keys", value: async (element?) => await this.getEntityKeyDetails(element, element.context) },
        { key: "Attributes", value: async (element?) => await this.getEntityAttributeDetails(element, element.context) },
        { key: "Views", value: async (element?) => await this.getEntityViewDetails(element, element.solutionId, element.context) },
        { key: "Charts", value: async (element?) => await this.getEntityChartDetails(element, element.solutionId, element.context) },
        { key: "Forms", value: async (element?) => await this.getEntityFormDetails(element, element.solutionId, element.context) },
        { key: "Dashboards", value: async (element?) => await this.getEntityDashboardDetails(element, element.solutionId, element.context) },
        { key: "Relationships", value: async (element?) => await this.getEntityRelationshipDetails(element, element.context) },
    ]);

    private static readonly openInAppCommands = new Dictionary<CdsExplorerEntryType, (item?: CdsTreeEntry) => Promise<void>>([
        { key: "Entity", value: async (item) => Utilities.Browser.openWindow(CdsUrlResolver.getOpenEntityUsingAppUrl(item.context.LogicalName)) },
        { key: "Dashboard", value: async (item) => Utilities.Browser.openWindow(CdsUrlResolver.getOpenEntityDashboardUsingAppUrl(item.context.formid)) },
        { key: "View", value: async (item) => Utilities.Browser.openWindow(CdsUrlResolver.getOpenEntityViewUsingAppUrl(item.parent.context.LogicalName, item.context.savedqueryid)) },
    ]);

    private static readonly openInBrowserCommands = new Dictionary<CdsExplorerEntryType, (item?: CdsTreeEntry) => Promise<void>>([
        { key: "Application", value: async (item) => Utilities.Browser.openWindow(CdsUrlResolver.getOpenAppUsingBrowserUri(item.config, item.context)) },
        { key: "Entity", value: async (item) => Utilities.Browser.openWindow(CdsUrlResolver.getOpenEntityFormUri(item.config, item.context.LogicalName)) },
        { key: "Form", value: async (item) => Utilities.Browser.openWindow(CdsUrlResolver.getOpenEntityFormUri(item.config, item.parent.context.LogicalName, item.context.formid)) },
        { key: "Dashboard", value: async (item) => Utilities.Browser.openWindow(CdsUrlResolver.getOpenEntityFormUri(item.config, item.parent.context.LogicalName, item.context.formid)) },
        { key: "View", value: async (item) => Utilities.Browser.openWindow(CdsUrlResolver.getOpenEntityViewUri(item.config, item.parent.context.LogicalName, item.context.savedqueryid)) },
    ]);

    private static readonly openInEditorCommands = new Dictionary<CdsExplorerEntryType, (item?: CdsTreeEntry) => Promise<void>>([
        { key: "Form", value: async (item) => await vscode.workspace.openTextDocument({ language:"xml", content:item.context.formxml }).then(d => vscode.window.showTextDocument(d)).then(e => logger.log(`Form loaded in editor`)) },
        { key: "Dashboard", value: async (item) => await vscode.workspace.openTextDocument({ language:"xml", content:item.context.formxml }).then(d => vscode.window.showTextDocument(d)).then(e => logger.log(`Dashboard loaded in editor`)) },
        { key: "View", value: async (item) => await vscode.workspace.openTextDocument({ language:"xml", content:item.context.layoutxml }).then(d => vscode.window.showTextDocument(d)).then(e => logger.log(`View loaded in editor`)) },
        { key: "Chart", value: async (item) => await vscode.workspace.openTextDocument({ language:"xml", content:item.context.presentationdescription }).then(d => vscode.window.showTextDocument(d)).then(e => logger.log(`Chart loaded in editor`)) }
    ]);

    private static readonly parsers = new Dictionary<CdsExplorerEntryType, (item: any, element?: CdsTreeEntry, ...rest: any[]) => CdsTreeEntry>([
        { key: "Connection", value: connection => {
            const displayName = (connection.name) ? connection.name : connection.webApiUrl.replace("http://", "").replace("https://", "");

            return new CdsTreeEntry(undefined, "Connection", connection.webApiUrl, displayName, connection.webApiUrl, vscode.TreeItemCollapsibleState.Collapsed, connection);
        }}, 
        { key: "Organization", value: (org, element) => element.createChildItem("Organization", org.Id, org.FriendlyName, `v${org.Version}`, vscode.TreeItemCollapsibleState.Collapsed, org) },
        { key: "Application", value: (application, element) => element.createChildItem("Application", application.appmoduleid, application.name, `${application.appmoduleversion ? 'v' + application.appmoduleversion + ' ' : ''}(${application.ismanaged ? "Managed" :  "Unmanaged"})`, vscode.TreeItemCollapsibleState.None, application) },
        { key: "Solution", value: (solution, element) => element.createChildItem("Solution", solution.solutionid, solution.friendlyname, `v${solution.version} (${solution.ismanaged ? "Managed" :  "Unmanaged"})`, vscode.TreeItemCollapsibleState.Collapsed, solution) },
        { key: "Plugin", value: (plugin, element) => element.createChildItem("Plugin", plugin.pluginassemblyid, plugin.name, `v${plugin.version} (${plugin.publickeytoken})`, vscode.TreeItemCollapsibleState.Collapsed, plugin) },
        { key: "PluginType", value: (pluginType, element, plugin?: any) => element.createChildItem("PluginType", pluginType.name, pluginType.friendlyname, pluginType.name.replace(plugin.name + ".", ''), vscode.TreeItemCollapsibleState.Collapsed, pluginType) },
        { key: "PluginStep", value: (pluginStep, element, pluginType?: any) => element.createChildItem("PluginStep", pluginStep.name, pluginStep.name.replace(pluginType.name + ": ", ''), pluginStep.description, vscode.TreeItemCollapsibleState.Collapsed, pluginStep) },
        { key: "PluginStepImage", value: (pluginImage, element) => element.createChildItem("PluginStepImage", pluginImage.name, pluginImage.name, pluginImage.description, vscode.TreeItemCollapsibleState.None, pluginImage) },
        { key: "WebResource", value: (webresource, element) => element.createChildItem("WebResource", webresource.webresourceid, webresource.name, webresource.displayname, vscode.TreeItemCollapsibleState.None, webresource) }, 
        { key: "Process", value: (process, element) => element.createChildItem("Process", process.workflowid, process.name, <string | undefined>CdsUrlResolver.parseProcessType(process.category), vscode.TreeItemCollapsibleState.None, process) }, 
        { key: "OptionSet", value: (optionSet, element) => element.createChildItem("OptionSet", optionSet.Name, optionSet.Name, optionSet['@odata.type'].substr(1), vscode.TreeItemCollapsibleState.Collapsed, optionSet) }, 
        { key: "Option", value: (option, element) => element.createChildItem("Option", option.Value, CdsUtilities.getLocalizedName(option.Label), option.Value.toString(), vscode.TreeItemCollapsibleState.None, option) }, 
        { key: "Entity", value: (entity, element) => element.createChildItem("Entity", entity.LogicalName, CdsUtilities.getLocalizedName(entity.DisplayName), entity.LogicalName, vscode.TreeItemCollapsibleState.Collapsed, entity) }, 
        { key: "Attribute", value: (attribute, element) => element.createChildItem("Attribute", attribute.LogicalName, CdsUtilities.getLocalizedName(attribute.DisplayName), attribute.LogicalName, vscode.TreeItemCollapsibleState.None, attribute) }, 
        { key: "View", value: (query, element) => element.createChildItem("View", query.savedqueryid, query.name, query.description, vscode.TreeItemCollapsibleState.None, query) }, 
        { key: "Chart", value: (queryvisualization, element) => element.createChildItem("Chart", queryvisualization.savedqueryvisualizationid, queryvisualization.name, queryvisualization.description, vscode.TreeItemCollapsibleState.None, queryvisualization) }, 
        { key: "Form", value: (form, element) => element.createChildItem("Form", form.formid, form.name, form.description, vscode.TreeItemCollapsibleState.None, form) }, 
        { key: "Dashboard", value: (dashboard, element) => element.createChildItem("Dashboard", dashboard.formid, dashboard.name, dashboard.description, vscode.TreeItemCollapsibleState.None, dashboard) }, 
        { key: "Key", value: (key, element) => element.createChildItem("Key", key.LogicalName, CdsUtilities.getLocalizedName(key), key.LogicalName, vscode.TreeItemCollapsibleState.None, key) }, 
        { key: "OneToManyRelationship", value: (relationship, element) => element.createChildItem('OneToManyRelationship', relationship.SchemaName, relationship.SchemaName, relationship.RelationshipType, vscode.TreeItemCollapsibleState.None, relationship)}, 
        { key: "ManyToOneRelationship", value: (relationship, element) => element.createChildItem('ManyToOneRelationship', relationship.SchemaName, relationship.SchemaName, relationship.RelationshipType, vscode.TreeItemCollapsibleState.None, relationship)}, 
        { key: "ManyToManyRelationship", value: (relationship, element) => element.createChildItem('ManyToManyRelationship', relationship.SchemaName, relationship.SchemaName, relationship.RelationshipType, vscode.TreeItemCollapsibleState.None, relationship)}, 
    ]);

    private static readonly solutionComponentMappings = new Dictionary<CdsExplorerEntryType, { componentId: (item?: CdsTreeEntry) => Promise<void>, componentType: CdsSolutions.SolutionComponent }>([
        { key: "Plugin", value: { componentId: (item) => item.context.pluginassemblyid, componentType: CdsSolutions.SolutionComponent.PluginAssembly }},
        { key: "WebResource", value: { componentId: (item) => item.context.webresourceid, componentType: CdsSolutions.SolutionComponent.WebResource }},
        { key: "Process", value: { componentId: (item) => item.context.workflowid, componentType: CdsSolutions.SolutionComponent.Workflow }},
        { key: "Entity", value: { componentId: (item) => item.context.MetadataId, componentType: CdsSolutions.SolutionComponent.Entity }},
        { key: "OptionSet", value: { componentId: (item) => item.context.MetadataId, componentType: CdsSolutions.SolutionComponent.OptionSet }}
    ]);

    /**
     * Gets an array of connections registered in the CDS explorer instance.
     *
     * @readonly
     * @type {CdsWebApi.Config[]}
     * @memberof CdsExplorerView
     */
    get connections(): CdsWebApi.Config[] {
        return this._connections;
    }

    /**
     * Gets an array of connections for individual organizations registered in the CDS explorer instance.
     *
     * @readonly
     * @type {CdsWebApi.Config[]}
     * @memberof CdsExplorer
     */
    get orgConnections(): CdsWebApi.Config[] { 
        return this._orgConnections;        
    }

    /**
     * Runs when the extension is loaded and registers the TreeView data provider.
     *
     * @param {vscode.ExtensionContext} context
     * @memberof CdsExplorerView
     */
    @extensionActivate(cs.cds.extension.productId)
    async activate(context: vscode.ExtensionContext) {
        TreeEntryCache.Instance.solutionMap = await SolutionMap.loadFromWorkspace(undefined, false);

        ExtensionContext.subscribe(vscode.window.registerTreeDataProvider(cs.cds.viewContainers.cdsExplorer, CdsExplorer.Instance));
    }

    @command(cs.cds.controls.cdsExplorer.addEntry, "Add")
    async add(item?: CdsTreeEntry): Promise<void> {
        if (!item) {
            await vscode.commands.executeCommand(cs.cds.controls.cdsExplorer.editConnection);
        } else {
            return this.runCommand(CdsExplorer.addCommands, item);
        }
    }

    @command(cs.cds.controls.cdsExplorer.addConnection, "Add Connection")
    addConnection(...options: CdsWebApi.Config[]): void {
        const connections = CdsExplorer.Instance.connections || [];

        if (options && options.length > 0) {
            options.forEach(o => {
                // Make sure the connection has an id
                if (!o.id) {
                    // give this an id
                    o.id = Utilities.Guid.newGuid();
                    // add it to the list
                    connections.push(o); 
                } else {
                    const updateIndex = CdsExplorer.Instance._connections.findIndex(c => c.id === o.id);
                    connections[updateIndex] = o;
                }
            });
        }

        // save to state and assign to our local connections variable.
        CdsExplorer.Instance._connections = DiscoveryRepository.saveConnections(ExtensionContext.Instance, connections);

        // refresh the treeview
        this.refresh();
    }

    @command(cs.cds.controls.cdsExplorer.addEntryToSolution, "Add to Solution")
    async addToSolution(item?: CdsTreeEntry) {
        if (item.solutionId) {
            await vscode.window.showInformationMessage(`The component ${item.label} is already a part of a solution.`);

            return;
        }

        if (CdsExplorer.solutionComponentMappings.containsKey(item.itemType)) {
            const componentId = CdsExplorer.solutionComponentMappings[item.itemType].componentId(item);
            const componentType = CdsExplorer.solutionComponentMappings[item.itemType].componentType;

            return await vscode.commands.executeCommand(cs.cds.deployment.addSolutionComponent, item.config, undefined, componentId, componentType)
                .then(response => {
                    const solutionPath = item.id.split("/").slice(0, 4);
                    solutionPath.push("Solutions");
                    solutionPath.push((<any>response).solutionid);

                    CdsExplorer.Instance.refreshSolution(solutionPath.join("/")); 
                });
        }
    }

    @command(cs.cds.controls.cdsExplorer.clickEntry, "Click")
    async click(item?: CdsTreeEntry) {
        if (item.collapsibleState === vscode.TreeItemCollapsibleState.Collapsed) {
            await this.refresh(item);
            item.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
        }            
    }

    @command(cs.cds.controls.cdsExplorer.deleteEntry, "Delete")
    async delete(item?: CdsTreeEntry) {
        return this.runCommand(CdsExplorer.deleteCommands, item);
    }

    @command(cs.cds.controls.cdsExplorer.editEntry, "Edit")
    async edit(item?: CdsTreeEntry): Promise<void> {
        return this.runCommand(CdsExplorer.editCommands, item);
    }

    @command(cs.cds.controls.cdsExplorer.exportSolution, "Export solution")
    async exportSolution(item?: CdsTreeEntry) {
        if (!item.solutionId) {
            await vscode.window.showInformationMessage(`The item ${item.label} is not part of a solution.`);

            return;
        }

        return await vscode.commands.executeCommand(cs.cds.deployment.exportSolution, item.config, item.context);
    }

    getTreeItem(element: CdsTreeEntry): vscode.TreeItem {
		return element;
	}

	async getChildren(element?: CdsTreeEntry): Promise<CdsTreeEntry[]> {
        if (element) {
            if (this.getChildrenCommands.containsKey(element.itemType)) {
                return await this.getChildrenCommands[element.itemType](element);
            } else {
                logger.warn(`View: ${cs.cds.viewContainers.cdsExplorer}.getChildren: No command configured for ${element.itemType}`);
            }
        } else {
            return await Promise.resolve(this.getConnectionEntries());
        }
    }

    @command(cs.cds.controls.cdsExplorer.inspectEntry, "Inspect")
    async inspect(item?: CdsTreeEntry) {
        return await vscode.commands.executeCommand(cs.cds.controls.jsonInspector.open, item.context);
    }

    @command(cs.cds.controls.cdsExplorer.moveSolution, "Move or re-map solution")
    async moveSolution(item?: CdsTreeEntry) {
        return await vscode.commands.executeCommand(cs.cds.deployment.updateSolutionMapping, item.solutionMapping, item.config)
            .then(result => TreeEntryCache.Instance.clearMap());
    }

    @command(cs.cds.controls.cdsExplorer.openInApp, "Open in App")
    async openInApp(item?: CdsTreeEntry): Promise<void> {
        return this.runCommand(CdsExplorer.openInAppCommands, item);
    }

    @command(cs.cds.controls.cdsExplorer.openInBrowser, "Open in Browser")
    async openInBrowser(item?: CdsTreeEntry): Promise<void> {
        return this.runCommand(CdsExplorer.openInBrowserCommands, item);
    }

    @command(cs.cds.controls.cdsExplorer.openInEditor, "Open in Editor")
    async openInEditor(item?: CdsTreeEntry): Promise<void> {
        return this.runCommand(CdsExplorer.openInEditorCommands, item);
    }

    @command(cs.cds.controls.cdsExplorer.refreshEntry, "Refresh")
    refresh(item?: CdsTreeEntry): void {
        if (TreeEntryCache.Instance) {
            TreeEntryCache.Instance.remove(item ? item.id : undefined);
        }

        // do not check for .Instance here as it will create a circular reference.        
        if (CdsExplorer.instance) {
            CdsExplorer.instance._onDidChangeTreeData.fire(item);
        }
    }

    refreshSolution(solutionPath?: string): void {
        if (solutionPath) {
            TreeEntryCache.Instance.items
                .where(i => i.id === solutionPath)
                .forEach(i => this.refresh(i));
        }
    }

    async removeConnection(connection: CdsWebApi.Config): Promise<void> { 
        const removeIndex = this._connections.findIndex(c => c.webApiUrl === connection.webApiUrl);
        
        if (removeIndex >= 0 && (await Quickly.pickBoolean(`Are you sure you want to remove the connection named '${this._connections[removeIndex].name}'?`, 'Yes', 'No'))) {
            this._connections.splice(removeIndex, 1);
            DiscoveryRepository.saveConnections(ExtensionContext.Instance, this._connections);
            this.refresh();
        }
    }

    @command(cs.cds.controls.cdsExplorer.removeEntryFromSolution, "Remove from Solution")
    async removeFromSolution(item?: CdsTreeEntry) {
        if (!item.solutionId) {
            await vscode.window.showInformationMessage(`The component ${item.label} is not part of a solution.`);

            return;
        }

        if (CdsExplorer.solutionComponentMappings.containsKey(item.itemType)) {
            const componentId = CdsExplorer.solutionComponentMappings[item.itemType].componentId(item);
            const componentType = CdsExplorer.solutionComponentMappings[item.itemType].componentType;

            if (!Utilities.$Object.isNullOrEmpty(item.solutionIdPath)) {
                const solutions = TreeEntryCache.Instance.items.where(i => i.id === item.solutionIdPath).toArray();
                
                if (solutions && solutions.length > 0 && componentId && componentType) {
                    return await vscode.commands.executeCommand(cs.cds.deployment.removeSolutionComponent, item.config, solutions[0].context, componentId, componentType)
                        .then(response => CdsExplorer.Instance.refreshSolution(item.solutionIdPath));
                }
            }
        }
    }

    private createContainers(element: CdsTreeEntry, parentType: CdsExplorerEntryType, types: CdsExplorerEntryType[]) : CdsTreeEntry[] {
        let returnObject = [];

        types.forEach(type => {
            returnObject.push(element.createChildItem(type, type, type.replace(/([a-z](?=[A-Z]))/g, '$1 '), '', vscode.TreeItemCollapsibleState.Collapsed, element.itemType === parentType ? element.context : undefined));
        });

        return returnObject;
    }

    @telemetry({ 
        key: `${cs.cds.viewContainers.cdsExplorer}.createEntries`,
        event: cs.cds.telemetryEvents.performanceCritical,
        measures: Dictionary.parse([
            { key: 'count.retrieve', value: (key, context) => context.inputs[key] || 0 },
            { key: 'count.parse', value: (key, context) => context.inputs[key] || 0 },
            { key: 'duration.invocation', value: (key, context) => context.inputs["invocation.end"] - context.inputs["invocation.start"] },
            { key: 'duration.parse', value: (key, context) => context.inputs["invocation.end"] - context.inputs["parse.start"] },
            { key: 'percent.parse', value: (key, context) => Math.round((context.inputs["invocation.end"] - context.inputs["parse.start"]) / (context.inputs["invocation.end"] - context.inputs["invocation.start"]) * 1000) / 10 },
            { key: 'duration.retrieve', value: (key, context) => context.inputs["parse.start"] - context.inputs["invocation.start"] },
            { key: 'percent.retrieve', value: (key, context) => Math.round((context.inputs["parse.start"] - context.inputs["invocation.start"]) / (context.inputs["invocation.end"] - context.inputs["invocation.start"]) * 1000) / 10 },
        ])
    }, {
        onStart: (logger, element: CdsTreeEntry) => logger.log(`View: ${cs.cds.viewContainers.cdsExplorer}.createEntries: Element '${element.label}' is loading child entries.`),
        onEnd: (logger, context, element: CdsTreeEntry) => logger.log(`View: ${cs.cds.viewContainers.cdsExplorer}.createEntries: Element '${element.label}' loaded child entries.  Parsed ${context.measurements["count.parse"]}/${context.measurements["count.retrieve"]} entries (total: ${context.measurements["duration.invocation"]}ms, retreive: ${context.measurements["duration.retrieve"]}ms;${context.measurements["percent.retrieve"]}%, parse: ${context.measurements["duration.parse"]}ms;${context.measurements["percent.parse"]}%)`)
    })
    private createEntries(element: CdsTreeEntry, onRetreive: () => Promise<any[]>, onParse: (item: any) => CdsTreeEntry, onErrorMessage?: (message: string) => string, onRetry?: Function): Promise<CdsTreeEntry[]> {
        const context = Telemetry.Instance.context(`${cs.cds.viewContainers.cdsExplorer}.createEntries`);
        context.property('parentType', element.itemType);

        return onRetreive()
            .then(items => {
                context.input("count.retrieve", items && items.length ? items.length : 0).mark("parse.start");

                const result : CdsTreeEntry[] = new Array();
                let parsed: number = 0;

                if (!items) {
                    logger.log(`View: ${cs.cds.viewContainers.cdsExplorer}.createEntries: No children found for ${element.label}`);

                    return;
                }

                let identifiedItemType: boolean = false;

                // Run these in paralell per #534 (Improve parse performance in TreeView for large batches)
                async.each(items, async item => {
                    let treeItem;

                    try {
                        treeItem = onParse(item);
                    } catch (error) {
                        const message = error.message || error.toString();

                        logger.error(`View: ${cs.cds.viewContainers.cdsExplorer}.createEntries: Error parsing ${element.itemType} - ${message}`);
                        Quickly.error(`There was an error parsing one of the ${element.itemType} items: ${message}`);
                    }

                    if (treeItem) {
                        if (!identifiedItemType) {
                            context.property('childType', item.itemType);
                            identifiedItemType = true;
                        }
        
                        parsed++;
                        result.push(treeItem);
                    }
                });

                context.input("count.parse", parsed);

                return result;
            })
            .catch(err => {
                if (onErrorMessage && onRetry) {
                    const message = onErrorMessage((err.message || err).toString());

                    logger.error(`View: ${cs.cds.viewContainers.cdsExplorer}.createEntries: ${message} {ui-retry}`);
                    Quickly.askToRetry(message, onRetry);
                }

                return null;
            });
    }

	private getConnectionEntries(): CdsTreeEntry[] {
        const result: CdsTreeEntry[] = [];
        
        if (this._connections) {
            this._connections.forEach(connection => result.push(CdsExplorer.parsers["Connection"](connection)));
        }

        return result;
    }
    
    private getConnectionDetails(element: CdsTreeEntry): Promise<CdsTreeEntry[]> {
        const connection = element.config;
        const api = new DiscoveryRepository(connection);
        
        let filter;

        if (connection.type === CdsWebApi.ConfigType.Online && connection.appUrl) {
            filter = `Url eq '${Utilities.String.noTrailingSlash(connection.appUrl)}'`;
        } else if (connection.type === CdsWebApi.ConfigType.Online && connection.webApiUrl) {
            filter = `ApiUrl eq '${Utilities.String.noTrailingSlash(connection.webApiUrl)}'`;
        }

        const returnValue = this.createEntries(
            element,
            () => api.retrieveOrganizations(filter), 
            org => CdsExplorer.parsers["Organization"](org, element),
            error => `An error occurred while accessing organizations from ${connection.webApiUrl}: ${error}`, 
            () => this.getConnectionDetails(element));

        return returnValue;
    }

    private async getSolutionLevelDetails(element: CdsTreeEntry) : Promise<CdsTreeEntry[]> {
        const showDefaultSolution = <boolean>ExtensionConfiguration.getConfigurationValueOrDefault(cs.cds.configuration.explorer.showDefaultSolution, false);
        const returnValue: CdsTreeEntry[] = [];
        const api = new ApiRepository(element.config);

        if (element.itemType === "Solution" || showDefaultSolution) {
            this.createContainers(element, element.itemType, [ "Entities", "OptionSets", "Processes", "WebResources", "Plugins" ]).forEach(e => returnValue.push(e));
        } 
        
        if (element.itemType === "Organization") {
            this.createContainers(element, element.itemType, [ "Solutions"]).forEach(e => returnValue.push(e));
        }

        const applications = this.createContainers(element, element.itemType, [ "Applications" ]);

        if (applications.length > 0) {
            if (element.itemType === "Organization") {
                applications[0].context.ActiveSolution = await api.retrieveBuiltInSolution("Active");
            }

            returnValue.push(applications[0]);
        }

        return returnValue;
    }

    private getApplicationDetails(element: CdsTreeEntry, solution?: any): Promise<CdsTreeEntry[]> {
        const api = new ApiRepository(element.config);
        const returnValue = this.createEntries(
            element,
            () => api.retrieveApplications(solution ? solution.solutionid : undefined), 
            application => CdsExplorer.parsers["Application"](application, element),
            error => `An error occurred while retrieving applications from ${element.config.webApiUrl}: ${error}`, 
            () => this.getApplicationDetails(element));

        return returnValue;
    }

    private getSolutionDetails(element: CdsTreeEntry): Promise<CdsTreeEntry[]> {
        const api = new ApiRepository(element.config);
        const returnValue = this.createEntries(
            element,
            () => api.retrieveSolutions(), 
            solution => CdsExplorer.parsers["Solution"](solution, element),
            error => `An error occurred while retrieving solutions from ${element.config.webApiUrl}: ${error}`, 
            () => this.getSolutionDetails(element));

        return returnValue;
    }

    private getPluginDetails(element: CdsTreeEntry, solution?: any): Thenable<CdsTreeEntry[]> {
		const api = new ApiRepository(element.config);
        const returnValue = this.createEntries(
            element,
            () => api.retrievePluginAssemblies(solution ? solution.solutionid : undefined), 
            plugin => CdsExplorer.parsers["Plugin"](plugin, element),
            error => `An error occurred while retrieving plug-in assemblies from ${element.config.webApiUrl}: ${error}`,
            () => this.getPluginDetails(element, solution));

        return returnValue;
    }

    private getPluginTypeDetails(element: CdsTreeEntry, plugin?: any): Thenable<CdsTreeEntry[]> {
		const api = new ApiRepository(element.config);
        const returnValue = this.createEntries(
            element,
            () => api.retrievePluginTypes(plugin.pluginassemblyid), 
            pluginType => CdsExplorer.parsers["PluginType"](pluginType, element, plugin),
            error => `An error occurred while retrieving plug-in types from ${element.config.webApiUrl}: ${error}`,
            () => this.getPluginTypeDetails(element, plugin));

        return returnValue;
    }

    private getPluginStepDetails(element: CdsTreeEntry, pluginType?: any): Thenable<CdsTreeEntry[]> {
		const api = new ApiRepository(element.config);
        const returnValue = this.createEntries(
            element,
            () => api.retrievePluginSteps(pluginType.plugintypeid), 
            pluginStep => CdsExplorer.parsers["PluginStep"](pluginStep, element, pluginType),
            error => `An error occurred while retrieving plug-in steps from ${element.config.webApiUrl}: ${error}`,
            () => this.getPluginStepDetails(element, pluginType));

        return returnValue;
    }

    private getPluginStepImageDetails(element: CdsTreeEntry, pluginStep?: any): Thenable<CdsTreeEntry[]> {
		const api = new ApiRepository(element.config);
        const returnValue = this.createEntries(
            element,
            () => api.retrievePluginStepImages(pluginStep.sdkmessageprocessingstepid), 
            pluginImage => CdsExplorer.parsers["PluginStepImage"](pluginImage, element, pluginStep),
            error => `An error occurred while retrieving plug-in step images from ${element.config.webApiUrl}: ${error}`,
            () => this.getPluginStepImageDetails(element, pluginStep));

        return returnValue;
    }

    private getWebResourcesFolderDetails(element: CdsTreeEntry, solution?: any, folder?: string): Thenable<CdsTreeEntry[]> {
        const api = new ApiRepository(element.config);
        const returnValue = this.createEntries(
            element,
            () => api.retrieveWebResourceFolders(solution ? solution.solutionid : undefined, folder),
            container => CdsExplorer.folderParsers["WebResource"](container, element),
            error => `An error occurred while retrieving web resources from ${element.config.webApiUrl}: ${error}`, 
            () => this.getWebResourcesFolderDetails(element, solution, folder));

        return returnValue;
    }

    private getWebResourcesDetails(element: CdsTreeEntry, solution?: any, folder?: string): Thenable<CdsTreeEntry[]> {
        const api = new ApiRepository(element.config);
        const returnValue = this.createEntries(
            element,
            () => api.retrieveWebResources(solution ? solution.solutionid : undefined, folder), 
            webresource => CdsExplorer.parsers["WebResource"](webresource, element),
            error => `An error occurred while retrieving web resources from ${element.config.webApiUrl}: ${error}`, 
            () => this.getWebResourcesDetails(element, solution, folder))
            .then(results => { 
                if (folder && results && results.length > 0) {
                    results.forEach(r => r.label = r.label.replace(Utilities.String.withTrailingSlash(r.folder), '')); 
                }
            
                return results; 
            });

        return returnValue;
    }

    private getProcessDetails(element: CdsTreeEntry, context?: any): Thenable<CdsTreeEntry[]> {
		const api = new ApiRepository(element.config);
        const returnValue = this.createEntries(
            element,
            () => api.retrieveProcesses(context && context.LogicalName ? context.LogicalName : undefined, element.solutionId), 
            process => CdsExplorer.parsers["Process"](process, element),
            error => `An error occurred while retrieving business processes from ${element.config.webApiUrl}: ${error}`,
            () => this.getProcessDetails(element, context));

        return returnValue;
    }

    private getOptionSetDetails(element: CdsTreeEntry, solution?: any): Thenable<CdsTreeEntry[]> {
		const api = new MetadataRepository(element.config);
        const returnValue = this.createEntries(
            element,
            () => api.retrieveOptionSets(solution ? solution.solutionid : undefined), 
            optionSet => CdsExplorer.parsers["OptionSet"](optionSet, element),
            error => `An error occurred while retrieving option sets from ${element.config.webApiUrl}: ${error}`,
            () => this.getOptionSetDetails(element, solution));
    
        return returnValue;
    }

    private getOptionDetails(element: CdsTreeEntry): Thenable<CdsTreeEntry[]> {
        const parseOptions = (optionSet) => {
            switch (optionSet['@odata.type'].substr(1)) {
                case "Microsoft.Dynamics.CRM.BooleanOptionSetMetadata":
                    return [ optionSet.TrueOption, optionSet.FalseOption ];
                case "Microsoft.Dynamics.CRM.OptionSetMetadata":
                    return optionSet.Options;
            }
        };

        const returnValue = this.createEntries(
            element,
            () => Promise.resolve(parseOptions(element.context)),
            option => CdsExplorer.parsers["Option"](option, element),
            error => `An error occurred while retrieving options from ${element.config.webApiUrl}: ${error}`,
            () => this.getOptionDetails(element));

        return returnValue;
    }

    private getEntityDetails(element: CdsTreeEntry, solution?: any): Thenable<CdsTreeEntry[]> {
		const api = new MetadataRepository(element.config);
        const returnValue = this.createEntries(
            element,
            () => api.retrieveEntities(solution ? solution.solutionid : undefined), 
            entity => CdsExplorer.parsers["Entity"](entity, element),
            error => `An error occurred while retrieving entities from ${element.config.webApiUrl}: ${error}`,
            () => this.getEntityDetails(element, solution));
    
        return returnValue;
    }

    private getEntityAttributeDetails(element: CdsTreeEntry, entity?: any): Thenable<CdsTreeEntry[]> {
        const api = new MetadataRepository(element.config);
        const returnValue = this.createEntries(
            element,
            () => api.retrieveAttributes(entity.MetadataId), 
            attribute => CdsExplorer.parsers["Attribute"](attribute, element),
            error => `An error occurred while retrieving attributes from ${element.config.webApiUrl}: ${error}`,
            () => this.getEntityAttributeDetails(element, entity));

        return returnValue;
    }

    private getEntityViewDetails(element: CdsTreeEntry, solutionId?: string, entity?: any): Thenable<CdsTreeEntry[]> {
        const api = new MetadataRepository(element.config);
        const returnValue = this.createEntries(
            element,
            () => api.retrieveViews(entity.LogicalName, solutionId), 
            query => CdsExplorer.parsers["View"](query, element),
            error => `An error occurred while retrieving views from ${element.config.webApiUrl}: ${error}`,
            () => this.getEntityViewDetails(element, entity));
            
        return returnValue;
    }

    private getEntityChartDetails(element: CdsTreeEntry, solutionId?: string, entity?: any): Thenable<CdsTreeEntry[]> {
        const api = new MetadataRepository(element.config);
        const returnValue = this.createEntries(
            element,
            () => api.retrieveCharts(entity.LogicalName, solutionId), 
            queryvisualization => CdsExplorer.parsers["Chart"](queryvisualization, element),
            error => `An error occurred while retrieving charts from ${element.config.webApiUrl}: ${error}`,
            () => this.getEntityChartDetails(element, entity));
            
        return returnValue;
    }

    private getEntityFormDetails(element: CdsTreeEntry, solutionId?: string, entity?: any): Thenable<CdsTreeEntry[]> {
        const api = new MetadataRepository(element.config);
        const returnValue = this.createEntries(
            element,
            () => api.retrieveForms(entity.LogicalName, solutionId), 
            form => CdsExplorer.parsers["Form"](form, element),
            error => `An error occurred while retrieving forms from ${element.config.webApiUrl}: ${error}`,
            () => this.getEntityFormDetails(element, entity));

        return returnValue;
    }

    private getEntityDashboardDetails(element: CdsTreeEntry, solutionId?: string, entity?: any): Thenable<CdsTreeEntry[]> {
        const api = new MetadataRepository(element.config);
        const returnValue = this.createEntries(
            element,
            () => api.retrieveDashboards(entity.LogicalName, solutionId), 
            dashboard => CdsExplorer.parsers["Dashboard"](dashboard, element),
            error => `An error occurred while retrieving dashboards from ${element.config.webApiUrl}: ${error}`,
            () => this.getEntityDashboardDetails(element, entity));

        return returnValue;
    }

    private getEntityKeyDetails(element: CdsTreeEntry, entity?: any): Thenable<CdsTreeEntry[]> {
        const api = new MetadataRepository(element.config);
        const returnValue = this.createEntries(
            element,
            () => api.retrieveKeys(entity.MetadataId), 
            key => CdsExplorer.parsers["Key"](key, element),
            error => `An error occurred while retrieving key definitions from ${element.config.webApiUrl}: ${error}`,
            () => this.getEntityKeyDetails(element, entity));
            
        return returnValue;
    }

    @telemetry({ 
        key: `${cs.cds.viewContainers.cdsExplorer}.getEntityRelationshipDetails`,
        event: cs.cds.telemetryEvents.performanceCritical,
        measures: Dictionary.parse([
            { key: 'count.retrieve', value: (key, context) => context.inputs[key] || 0 },
            { key: 'count.parse', value: (key, context) => context.inputs[key] || 0 },
            { key: 'duration.invocation', value: (key, context) => context.inputs["invocation.end"] - context.inputs["invocation.start"] },
            { key: 'duration.parse', value: (key, context) => context.inputs["invocation.end"] - context.inputs["parse.start"] },
            { key: 'percent.parse', value: (key, context) => Math.round((context.inputs["invocation.end"] - context.inputs["parse.start"]) / (context.inputs["invocation.end"] - context.inputs["invocation.start"]) * 1000) / 10 },
            { key: 'duration.retrieve', value: (key, context) => context.inputs["parse.start"] - context.inputs["invocation.start"] },
            { key: 'percent.retrieve', value: (key, context) => Math.round((context.inputs["parse.start"] - context.inputs["invocation.start"]) / (context.inputs["invocation.end"] - context.inputs["invocation.start"]) * 1000) / 10 },
        ])
    }, {
        onStart: (logger, element: CdsTreeEntry) => logger.log(`View: ${cs.cds.viewContainers.cdsExplorer}.getEntityRelationshipDetails: Element '${element.label}' is loading child entries.`),
        onEnd: (logger, context, element: CdsTreeEntry) => logger.log(`View: ${cs.cds.viewContainers.cdsExplorer}.getEntityRelationshipDetails: Element '${element.label}' loaded child entries.  Parsed ${context.measurements["count.parse"]}/${context.measurements["count.retrieve"]} entries (total: ${context.measurements["duration.invocation"]}ms, retreive: ${context.measurements["duration.retrieve"]}ms;${context.measurements["percent.retrieve"]}%, parse: ${context.measurements["duration.parse"]}ms;${context.measurements["percent.parse"]}%)`)
    })
    private getEntityRelationshipDetails(element: CdsTreeEntry, entity?: any): Thenable<CdsTreeEntry[]> {
        const context = Telemetry.Instance.context(`${cs.cds.viewContainers.cdsExplorer}.getEntityRelationshipDetails`);
        const api = new MetadataRepository(element.config);

        context.property('parentType', element.itemType);

        return api.retrieveRelationships(entity.MetadataId)
            .then(items => {
                const count = (items && items.oneToMany ? items.oneToMany.length : 0)
                    + (items && items.manyToOne ? items.manyToOne.length : 0)
                    + (items && items.manyToMany ? items.manyToMany.length : 0);
                let parsed: number = 0;

                context.input("count.retrieve", count).mark("parse.start");

                const result : CdsTreeEntry[] = new Array();
                let hasOneToMany: boolean, hasManyToOne: boolean, hasManyToMany: boolean;

                async.race([
                    async () => {
                        if (items && items.oneToMany && items.oneToMany.length > 0) {
                            hasOneToMany = true;

                            items.oneToMany.forEach(r => {
                                result.push(CdsExplorer.parsers["OneToManyRelationship"](r, element));
                                parsed++;
                            });
                        }
                    },
                    async () => {
                        if (items && items.manyToOne && items.manyToOne.length > 0) {
                            hasManyToOne = true;

                            items.manyToOne.forEach(r => {
                                result.push(CdsExplorer.parsers["ManyToOneRelationship"](r, element));
                                parsed++;
                            });
                        }
                    },
                    async () => {
                        if (items && items.manyToMany && items.manyToMany.length > 0) {
                            hasManyToMany = true;

                            items.manyToMany.forEach(r => {
                                result.push(CdsExplorer.parsers["ManyToManyRelationship"](r, element));
                                parsed++;
                            });
                        }
                    }
                ], (err, result) => {
                    if (err) {
                        const message = (err.message || err).toString();

                        logger.error(`View: ${cs.cds.viewContainers.cdsExplorer}.getEntityRelationshipDetails: ${message} {ui-retry}`);
                        Quickly.askToRetry(`An error occurred while retrieving relationships from ${element.config.webApiUrl}: ${message}`, () => this.getEntityRelationshipDetails(element, entity));
                    }
                });

                const childTypes = [];

                if (hasOneToMany) { childTypes.push('OneToManyRelationship'); }
                if (hasManyToOne) { childTypes.push('ManyToOneRelationship'); }
                if (hasManyToMany) { childTypes.push('ManyToManyRelationship'); }

                context.property("childTypes", childTypes.join(", "));
                context.input("count.parse", parsed);

                return new TS.Linq.Enumerator(result).orderBy(r => r.label).toArray();
            }).catch(error => {
                const message = (error.message || error).toString();

                logger.error(`View: ${cs.cds.viewContainers.cdsExplorer}.getEntityRelationshipDetails: ${message} {ui-retry}`);
                Quickly.askToRetry(`An error occurred while retrieving relationships from ${element.config.webApiUrl}: ${message}`, () => this.getEntityRelationshipDetails(element, entity));

                return null;
            });
    }

    private async removePluginStep(config: CdsWebApi.Config, step: any) {
        if (step?.sdkmessageprocessingstepid && (await Quickly.pickBoolean(`Are you sure you want to delete the plugin step named '${step.name}'?`, 'Yes', 'No'))) {
            const api = new ApiRepository(config);
            await api.removePluginStep(step);
        }
    }

    private async removePluginStepImage (config: CdsWebApi.Config, stepImage: any) {
        if (stepImage?.sdkmessageprocessingstepimageid && (await Quickly.pickBoolean(`Are you sure you want to delete the plugin step image named '${stepImage.name}'?`, 'Yes', 'No'))) {
            const api = new ApiRepository(config);
            await api.removePluginStepImage(stepImage);
        }
    }

    private async runCommand(definitions: Dictionary<CdsExplorerEntryType, (item?: CdsTreeEntry) => Promise<void>>, item?: CdsTreeEntry) {
        if (definitions.containsKey(item.itemType)) {
            return await definitions[item.itemType](item);
        }
    }
}

class TreeEntryCache {
    private static _instance:TreeEntryCache;

    private _items:CdsTreeEntry[] = [];

    private constructor() { 
        this.solutionMap = new SolutionMap();

        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            SolutionMap.loadFromWorkspace().then(map => this.solutionMap = map || this.solutionMap);
        }
    }

    static get Instance(): TreeEntryCache {
        if (!this._instance) {
            this._instance = new TreeEntryCache();
        }

        return this._instance;
    }

    add(entry: CdsTreeEntry): void {
        this._items.push(entry);
    }

    clear(): void {
        this._items = [];
    }

    clearMap(): void { 
        this.solutionMap = null;
    }

    get items(): TS.Linq.Enumerator<CdsTreeEntry> {
        return new TS.Linq.Enumerator(this._items);
    }

    solutionMap: SolutionMap;

    remove(path?: string) {
        if (!path || path === "") {
            this.clear();
        } else {
            this.under(path).forEach(i => {
                this._items.slice(this._items.indexOf(i), 1);
            });
        }
    }

    under(path:string): TS.Linq.Enumerator<CdsTreeEntry> {
        return this.items.where(item => item.id.startsWith(path));
    }
}

/**
 * Represents an entry that is dispalbed in the CdsexplorerView
 *
 * @class CdsTreeEntry
 * @extends {vscode.TreeItem}
 */
export class CdsTreeEntry extends vscode.TreeItem {
    private static readonly canRefreshEntryTypes: CdsExplorerEntryType[] = [ "Solutions", "Solution", "Plugins", "Entities", "Entity", "OptionSets", "OptionSet", "WebResources", "Folder", "Processes", "Attributes", "Forms", "Views", "Charts", "Dashboards", "Keys", "Relationships", "Entries" ];
    private static readonly canAddEntryTypes: CdsExplorerEntryType[] = [ "Applications", "Solutions", "Plugins", "Entities", "OptionSets", "WebResources", "Processes", "Attributes", "Forms", "Views", "Charts", "Dashboards", "Keys", "Relationships", "Entries", "PluginType", "PluginStep" ];
    private static readonly canCreateCrmSvcUtilConfigTypes: CdsExplorerEntryType[] = [ "Entities" ];
    private static readonly canEditEntryTypes: CdsExplorerEntryType[] = [ "Connection", "Application", "Solution", "Entity", "OptionSet", "WebResource", "Process", "Attribute", "Form", "View", "Chart", "Dashboard", "Key", "OneToManyRelationship", "ManyToOneRelationship", "ManyToManyRelationship", "Entry", "PluginStep", "PluginStepImage" ];
    private static readonly canDeleteEntryTypes: CdsExplorerEntryType[] = [ "Connection", "PluginStep", "PluginStepImage" ];
    private static readonly canExportSolutionTypes: CdsExplorerEntryType[] = [ "Solution" ];
    private static readonly canInspectEntryTypes: CdsExplorerEntryType[] = [ "Connection", "Solution", "Entity", "OptionSet", "WebResource", "Process", "Attribute", "Form", "View", "Chart", "Dashboard", "Key", "OneToManyRelationship", "ManyToOneRelationship", "ManyToManyRelationship", "Entry", "PluginStep" ];
    private static readonly canUnpackSolutionEntryTypes: CdsExplorerEntryType[] = [ "Solution" ];
    private static readonly canMoveSolutionEntryTypes: CdsExplorerEntryType[] = [ "Solution" ];
    private static readonly canOpenInAppEntryTypes: CdsExplorerEntryType[] = [ "View", "Entity", "Dashboard" ];
    private static readonly canOpenInBrowserEntryTypes: CdsExplorerEntryType[] = [ "Application", "Form", "View", "Entity", "Dashboard" ];
    private static readonly canOpenInEditorEntryTypes: CdsExplorerEntryType[] = [ "Form", "View", "Chart", "Dashboard" ];
    private static readonly canAddToSolutionEntryTypes: CdsExplorerEntryType[] = [ "Plugin", "Entity", "OptionSet", "WebResource", "Process", "Form", "View", "Chart", "Dashboard" ];
    private static readonly canRemoveFromSolutionEntryTypes: CdsExplorerEntryType[] = [ "Plugin", "Entity", "OptionSet", "WebResource", "Process", "Form", "View", "Chart", "Dashboard" ];

    /**
     * Creates an instance of CdsTreeEntry.
     * @param {CdsTreeEntry} parentItem The parent item (if any) the contains the tree view entry.  Only is null on root entries.
     * @param {CdsExplorerEntryType} itemType The item type
     * @param {string} id The identifier of the item (can be segmented by "/")
     * @param {string} label A descriptive label that shows next to the icon for the item
     * @param {string} [subtext] Subtext (description text) that shows next to the label
     * @param {vscode.TreeItemCollapsibleState} [collapsibleState=vscode.TreeItemCollapsibleState.None] The default state for the new item.
     * @param {*} [context] A context item that can be retrieved and used later
     * @memberof CdsTreeEntry
     */
    constructor(
        parentItem: CdsTreeEntry,
        public readonly itemType: CdsExplorerEntryType,
        readonly id: string,
        label: string,
        public readonly subtext?: string,
        collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None,
        public context?: any
	) {
        super(label, collapsibleState);
        
        const resolver = ExtensionIconThemes.selected.resolve("~/Resources/icons/", itemType);

        if (resolver) {
            this.iconPath = resolver.iconPath;
        }

        if (id) {
            if (parentItem) {
                id = `${Utilities.String.noTrailingSlash(parentItem.id)}/${id}`;
            } 

            // We can't have duplicate ids in the treeview.
            const count = TreeEntryCache.Instance.items.count(t => t.id === id || t.id && t.id.startsWith(id + "_"));
            
            if (count > 0) {
                id += `_${count}`;
            }

            this.command = { command: cs.cds.controls.cdsExplorer.clickEntry, title: this.subtext || this.label, arguments: [ this ] };
            this.id = id;
        }

        if (parentItem && parentItem.configId) {
            this.configId = parentItem.configId;
        } else if (context && context.webApiUrl && context.id) {
            this.configId = context.id;
            this.context = undefined;
        }

        this.contextValue = this.capabilities.join(",");

        TreeEntryCache.Instance.add(this);
    }

    /**
     * Represents the identifier for the connection that created the tree entry.  This can be used
     * to lookup the configuration for the connection from the CdsExplorerView.connections property.
     *
     * @type {string} identifier of the connection used
     * @memberof CdsTreeEntry
     */
    configId: string; 

	/**
     * Gets the tooltip text on the tree entry.
     *
     * @readonly
     * @type {string}
     * @memberof CdsTreeEntry
     */
    get tooltip(): string {
		return `${this.label}`;
	}

	/**
     * Gets the description (subtext) on the tree entry.
     *
     * @readonly
     * @type {string}
     * @memberof CdsTreeEntry
     */
    get description(): string {
		return this.subtext || this.itemType.toString(); 
    }

    /**
     * Gets a reference to the configuration used to create the tree entry.  This is the object
     * returned when using the configId.
     *
     * @readonly
     * @type {CdsWebApi.Config}
     * @memberof CdsTreeEntry
     */
    get config(): CdsWebApi.Config {
        if (this.configId) {
            const orgConnection = CdsExplorer.Instance.orgConnections.find(c => c.id === this.configId);

            if (!orgConnection) {
                const connection = CdsExplorer.Instance.connections.find(c => c.id === this.configId);
                const split = this.id.split("/");            
                
                if (split.length >= 4 && connection) {
                    const orgEntry = TreeEntryCache.Instance.items.first(i => i.id === split.slice(0, 4).join("/"));
    
                    if (orgEntry && orgEntry.context) {
                        const returnValue = DiscoveryRepository.createOrganizationConnection(orgEntry.context, connection);

                        CdsExplorer.Instance.orgConnections.push(returnValue);

                        return returnValue;
                    }
                }
    
                return connection;
            } else {
                return orgConnection;
            }
        }
    }

    /**
     * Gets the parent tree item (if any).
     *
     * @readonly
     * @type {CdsTreeEntry}
     * @memberof CdsTreeEntry
     */
    get parent(): CdsTreeEntry | undefined {
        if (this.id) {
            const split = this.id.split("/");            
            split.pop();

            if (split.length > 0) {
                const parentId = split.join("/");

                return TreeEntryCache.Instance.items.first(i => i.id === parentId);
            }
        }

        return undefined;
    }

    /**
     * Gets the folder associated with the tree item, if applicable.  Used when nesting
     * resources by folder.
     *
     * @readonly
     * @type {string}
     * @memberof CdsTreeEntry
     */
    get folder(): string {
        if (this.itemType === "Folder" && this.id && this.context && this.context.innerType) {
            const index = this.id.lastIndexOf(`${this.context.innerType.toString()}/`);

            return this.id.substring(index + this.context.innerType.toString().length + 1);
        } else if (this.parent && this.parent.itemType === "Folder" && this.parent.id) {
            return this.parent.folder;
        }

        return '';
    }

    /**
     * Gets the solution ID associated with the tree item, if applicable.
     *
     * @readonly
     * @type {string}
     * @memberof CdsTreeEntry
     */
    get solutionId(): string {
        if (this.id) {
            const split = this.id.split("/");
            const index = split.indexOf("Solutions");
            
            if (index >= 0) {
                return split[index + 1];
            }        
        }
       
        return null;
    }

    /**
     * Gets the solution associated with the tree item, if applicable.
     *
     * @readonly
     * @type {*}
     * @memberof CdsTreeEntry
     */
    get solution(): any {
        let solution: any;

        if (this.id) {
            const split = this.id.split("/");
            const index = split.indexOf("Solutions");
            
            if (index >= 0) {
                const solutionTreeId = split.slice(0, index + 2).join('/');
                const solutionTreeEntry = TreeEntryCache.Instance.items.where(i => i.id === solutionTreeId).toArray();

                if (solutionTreeEntry && solutionTreeEntry.length > 0) {
                    solution = solutionTreeEntry[0].context;
                }
            }        
        }

        return solution;
    }

    /**
     * Gets the solution path segment of the tree item's identifier.
     *
     * @readonly
     * @type {string}
     * @memberof CdsTreeEntry
     */
    get solutionIdPath(): string { 
        if (this.id)
        {
            const split = this.id.split("/");
            const index = split.indexOf("Solutions");
            
            if (index >= 0) {
                return split.slice(0, index + 2).join("/");
            }        
        }
       
        return null;
    }

    /**
     * Gets the mapping of the current solution for the currently loaded workspace, if applicable.
     *
     * @readonly
     * @type {SolutionWorkspaceMapping}
     * @memberof CdsTreeEntry
     */
    get solutionMapping(): SolutionWorkspaceMapping {
        if (this.id && this.itemType === "Solution") {
            if (TreeEntryCache.Instance && TreeEntryCache.Instance.solutionMap) {
                const maps = TreeEntryCache.Instance.solutionMap.getBySolutionId(this.context.solutionid, this.config.orgId);

                if (maps && maps.length > 0) {
                    return maps[0];
                }            
            }
        }

        return null;
    }

    /**
     * Gets an array of the capabilities of this tree item.  Used in conjunction with the "when" clause from package.json 
     * to indicate which icons/commands are available for a given tree item.
     *
     * @readonly
     * @type {string[]}
     * @memberof CdsTreeEntry
     */
    get capabilities(): string[] {
        const returnValue = [];
        
        this.addCapability(returnValue, "canRefreshItem", CdsTreeEntry.canRefreshEntryTypes);
        this.addCapability(returnValue, "canAddItem", CdsTreeEntry.canAddEntryTypes);
        this.addCapability(returnValue, "canCreateCrmSvcUtilConfig", CdsTreeEntry.canCreateCrmSvcUtilConfigTypes);
        this.addCapability(returnValue, "canEditItem", CdsTreeEntry.canEditEntryTypes);
        this.addCapability(returnValue, "canDeleteItem", CdsTreeEntry.canDeleteEntryTypes);
        this.addCapability(returnValue, "canExportSolution", CdsTreeEntry.canExportSolutionTypes, () => this.context && !this.context.ismanaged);
        this.addCapability(returnValue, "canInspectItem", CdsTreeEntry.canInspectEntryTypes);
        this.addCapability(returnValue, "canUnpackSolution", CdsTreeEntry.canUnpackSolutionEntryTypes, () => this.context && !this.context.ismanaged);
        this.addCapability(returnValue, "canAddToSolution", CdsTreeEntry.canAddToSolutionEntryTypes, () => !this.solutionId);
        this.addCapability(returnValue, "canRemoveFromSolution", CdsTreeEntry.canRemoveFromSolutionEntryTypes, () => !Utilities.$Object.isNullOrEmpty(this.solutionId));
        this.addCapability(returnValue, "canMoveSolution", CdsTreeEntry.canMoveSolutionEntryTypes, () => this.solutionMapping && !Utilities.$Object.isNullOrEmpty(this.solutionMapping.path));
        this.addCapability(returnValue, "canOpenInApp", CdsTreeEntry.canOpenInAppEntryTypes);
        this.addCapability(returnValue, "canOpenInBrowser", CdsTreeEntry.canOpenInBrowserEntryTypes);
        this.addCapability(returnValue, "canOpenInEditor", CdsTreeEntry.canOpenInEditorEntryTypes);

        return returnValue;
    }

    /**
     * Creates a child item underneath the current tree entry with the specified properties.
     *
     * @param {CdsExplorerEntryType} itemType The type of node to create
     * @param {string} id The sub-identifier of the node, the parent identifier will automatically be prefixed.
     * @param {string} label The label to display on the new tree item.
     * @param {string} [subtext] The subtext (description) to display on the new tree item.
     * @param {vscode.TreeItemCollapsibleState} [collapsibleState=vscode.TreeItemCollapsibleState.None] The current collapsible state of the child item, defaults to none.
     * @param {*} [context] A context object (if any) to associate with the new tree item.
     * @returns {CdsTreeEntry}
     * @memberof CdsTreeEntry
     */
    createChildItem(itemType: CdsExplorerEntryType, id: string, label: string, subtext?: string, collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None, context?: any): CdsTreeEntry {
        return new CdsTreeEntry(this, itemType, id, label, subtext, collapsibleState, context);
    }

    private addCapability(returnList:string[], capabilityName:string, constrain:CdsExplorerEntryType[], additionalCheck?:() => boolean): void {
        if (constrain.indexOf(this.itemType) !== -1 && (!additionalCheck || additionalCheck())) {
            returnList.push(capabilityName);
        }
    }
}

/*
 * Represents a type of CDS tree view entry 
*/
export type CdsExplorerEntryType = 
    "Connection" | 
    "Organization" |
    "Entities" |
    "OptionSets" |
    "WebResources" |
    "Plugins" |
    "Processes" |
    "Solutions" |
    "Applications" |
    "Entity" |
    "OptionSet" |
    "Option" |
    "WebResource" |
    "Plugin" |
    "PluginType" |
    "PluginStep" |
    "PluginStepImage" |
    "Process" |
    "Solution" |
    "Application" |
    "Attributes" |
    "Views" |
    "Charts" |
    "Dashboards" |
    "Keys" |
    "Relationships" |
    "Forms" |
    "Attribute" |
    "View" |
    "Chart" |
    "Dashboard" |
    "Key" |
    "OneToManyRelationship" |
    "ManyToOneRelationship" |
    "ManyToManyRelationship" |
    "Form" |
    "Entry" |
    "Entries" |
    "Folder";