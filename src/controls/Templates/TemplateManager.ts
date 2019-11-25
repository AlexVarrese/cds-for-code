import * as vscode from 'vscode';
import * as cs from '../../cs';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as FileSystem from '../../helpers/FileSystem';
import * as EnvironmentVariables from '../../helpers/EnvironmentVariables';
import * as _ from 'lodash';
import { TemplatePlaceholder, TemplateItem, TemplateType } from './Types';

import ExtensionConfiguration from '../../config/ExtensionConfiguration';
import IWireUpCommands from '../../wireUpCommand';
import QuickPicker from '../../helpers/QuickPicker';
import Dictionary from '../../helpers/Dictionary';
import Utilities from '../../helpers/Utilities';

import createFromItemTemplate from "../../commands/cs.dynamics.controls.explorer.createFromItemTemplate";
import createFromProjectTemplate from "../../commands/cs.dynamics.controls.explorer.createFromProjectTemplate";
import createTemplate from '../../commands/cs.dynamics.templates.createFromTemplate';
import deleteTemplate from '../../commands/cs.dynamics.templates.deleteTemplate';
import editTemplateCatalog from '../../commands/cs.dynamics.templates.editTemplateCatalog';
import exportTemplate from '../../commands/cs.dynamics.templates.exportTemplate';
import importTemplate from '../../commands/cs.dynamics.templates.importTemplate';
import openTemplateFolder from '../../commands/cs.dynamics.templates.openTemplateFolder';
import saveTemplate from '../../commands/cs.dynamics.templates.saveTemplate';
import saveTemplateFile from "../../commands/cs.dynamics.controls.explorer.saveTemplateFile";
import saveTemplateFolder from "../../commands/cs.dynamics.controls.explorer.saveTemplateFolder";
import { TemplateCatalog } from './TemplateCatalog';

/**
 * Main class to handle the logic of the Project Templates
 * @export
 * @class TemplateManager
 */
export default class TemplateManager implements IWireUpCommands {
    /**
     * local copy of workspace configuration to maintain consistency between calls
     */
    private static context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        TemplateManager.context = context;
        TemplateManager.createTemplatesDirIfNotExists();
    }

    wireUpCommands(context: vscode.ExtensionContext, config: vscode.WorkspaceConfiguration) {
        // now wire a command into the context
        context.subscriptions.push(
            vscode.commands.registerCommand(cs.dynamics.controls.explorer.createFromItemTemplate, createFromItemTemplate.bind(this)),
            vscode.commands.registerCommand(cs.dynamics.controls.explorer.createFromProjectTemplate, createFromProjectTemplate.bind(this)),
            vscode.commands.registerCommand(cs.dynamics.controls.explorer.saveTemplateFile, saveTemplateFile.bind(this)),
            vscode.commands.registerCommand(cs.dynamics.controls.explorer.saveTemplateFolder, saveTemplateFolder.bind(this)),
            vscode.commands.registerCommand(cs.dynamics.templates.createFromTemplate, createTemplate.bind(this)),
            vscode.commands.registerCommand(cs.dynamics.templates.deleteTemplate, deleteTemplate.bind(this)),
            vscode.commands.registerCommand(cs.dynamics.templates.editTemplateCatalog, editTemplateCatalog.bind(this)),
            vscode.commands.registerCommand(cs.dynamics.templates.exportTemplate, exportTemplate.bind(this)),
            vscode.commands.registerCommand(cs.dynamics.templates.importTemplate, importTemplate.bind(this)),
            vscode.commands.registerCommand(cs.dynamics.templates.openTemplateFolder, openTemplateFolder.bind(this)),
            vscode.commands.registerCommand(cs.dynamics.templates.saveTemplate, saveTemplate.bind(this)),
        );
    }

    getTemplates(): Promise<TemplateItem[]> {
        return TemplateManager.getTemplateCatalog().then(c => c.items);
    }

    static async applyTemplate(template:TemplateItem, data:string | Buffer, placeholders?:Dictionary<string, string>, object?:any): Promise<string | Buffer> {
        const usePlaceholders = ExtensionConfiguration.getConfigurationValueOrDefault(cs.dynamics.configuration.templates.usePlaceholders, false);
        const placeholderRegExp = ExtensionConfiguration.getConfigurationValueOrDefault(cs.dynamics.configuration.templates.placeholderRegExp, "#{([\\s\\S]+?)}");
        placeholders = placeholders || ExtensionConfiguration.getConfigurationValueOrDefault<Dictionary<string, string>>(cs.dynamics.configuration.templates.placeholders, new Dictionary<string, string>());

        const resolver = (data:string | Buffer, placeholderRegExp:RegExp) => {
            // use custom delimiter #{ }
            _.templateSettings.interpolate = placeholderRegExp;
            // compile the template
            const compiled = _.template(data.toString());

            return compiled(object);
        };

        if (usePlaceholders && placeholderRegExp) {
            const returnValue = await TemplateManager.resolvePlaceholders(data, placeholderRegExp, placeholders, template, object ? [ resolver ] : undefined);

            return returnValue;
        }
    }

    /**
     * Populates a workspace folder with the contents of a template
     * @param fsPath current workspace folder to populate
     */
    async createFromFilesystem(fsPath: string, type:TemplateType, template?:TemplateItem) {
        await TemplateManager.createTemplatesDirIfNotExists();

        // choose a template
        template = template || await QuickPicker.pickTemplate("Choose a template that you would like to create.", type);

        if (!template) {
            return;
        }

        if (fsPath && template.outputPath && !path.isAbsolute(template.outputPath)) {
            fsPath = path.join(fsPath, template.outputPath);
        } else if (template.outputPath && path.isAbsolute(template.outputPath)) {
            fsPath = template.outputPath;
        }

        // get template folder
        let templateDir = path.isAbsolute(template.location) ? template.location : path.join(await TemplateManager.getTemplatesFolder(), template.location);

        if (!fs.existsSync(templateDir)) {
            QuickPicker.error(`Cannot extract this template as ${templateDir} is not a valid path.`);

            return undefined;
        }

        // update placeholder configuration
        const usePlaceholders = ExtensionConfiguration.getConfigurationValueOrDefault(cs.dynamics.configuration.templates.usePlaceholders, false);
        const placeholderRegExp = ExtensionConfiguration.getConfigurationValueOrDefault(cs.dynamics.configuration.templates.placeholderRegExp, "#{([\\s\\S]+?)}");
        const placeholders = ExtensionConfiguration.getConfigurationValueOrDefault<Dictionary<string, string>>(cs.dynamics.configuration.templates.placeholders, new Dictionary<string, string>());

        let overwriteAll:boolean = false;
        let skipAll:boolean = false;
        let renameAll:boolean = false;

        // recursively copy files, replacing placeholders as necessary
		const copyInternal = async (source: string, destination: string) => {
            const directive = template && template.directives && template.directives.length > 0 ? template.directives.find(d => d.name === path.basename(source)) : undefined;
            // maybe replace placeholders in filename
            if (usePlaceholders && (!directive || directive.usePlaceholdersInFilename)) {
                destination = await TemplateManager.resolvePlaceholders(destination, placeholderRegExp, placeholders, template) as string;
            }

			if (fs.lstatSync(source).isDirectory()) {
                // create directory if doesn't exist
				if (!fs.existsSync(destination)) {
					fs.mkdirSync(destination);
				} else if (!fs.lstatSync(destination).isDirectory()) {
                    // fail if file exists
					throw new Error(`Failed to create directory "${destination}": A file with same name exists.`);
				}
            } else {
                // ask before overwriting existing file
                while (fs.existsSync(destination)) {
                    // if it is not a file, cannot overwrite
                    if (!fs.lstatSync(destination).isFile()) {
                        let reldest = path.relative(fsPath, destination);
       
                        // get user's input
                        destination = await QuickPicker.ask(`Cannot overwrite "${reldest}".  Please enter a new filename"`, undefined, reldest)
                            .then(value => value ? value : destination);

                        // if not absolute path, make workspace-relative
                        if (!path.isAbsolute(destination)) {
                            destination = path.join(fsPath, destination);
                        }
                    } else {
                        // ask if user wants to replace, otherwise prompt for new filename
                        let reldest = path.relative(fsPath, destination);
                        let action;

                        if (overwriteAll) { action = "Overwrite"; } else if (skipAll) { action = "Skip"; } else if (renameAll) { action = "Rename"; } else {
                            action = (await QuickPicker.pick(`Destination file "${reldest}" already exists.  What would you like to do?`, "Overwrite", "Overwrite All", "Rename", "Rename All", "Skip", "Skip All", "Abort")).label;
                        }

                        overwriteAll = overwriteAll || action === "Overwrite All";
                        skipAll = skipAll || action === "Skip All";
                        renameAll = renameAll || action === "Rename All";

                        switch(action) {
                            case "Overwrite":
                            case "Overwrite All":
                                // delete existing file
                                fs.unlinkSync(destination);

                                break;
                            case "Rename":
                            case "Rename All":
                                // get user's input
                                destination = await QuickPicker
                                    .ask("Please enter a new filename", undefined, reldest)
                                    .then(value => value ? value : destination);

                                // if not absolute path, make workspace-relative
                                if (!path.isAbsolute(destination)) {
                                    destination = path.join(fsPath, destination);
                                }

                                break;
                            case "Skip":
                            case "Skip All":
                                // skip
                                return true;
                            default:
                                // abort
                                return false;
                        }
                    }  // if file
                } // while file exists

                // get src file contents
                let fileContents : Buffer = fs.readFileSync(source);

                if (usePlaceholders && (!directive || directive.usePlaceholders)) {
                    fileContents = await TemplateManager.resolvePlaceholders(fileContents, placeholderRegExp, placeholders, template) as Buffer;
                }

                // ensure directories exist
                let parent = path.dirname(destination);
                FileSystem.makeFolderSync(parent);

                // write file contents to destination
                fs.writeFileSync(destination, fileContents);
            }

            return true;
        };  // copy function
        
        // actually copy the file recursively
        try {
            await FileSystem.recurse(templateDir, fsPath, copyInternal);
        } catch (error) {
            if (error.name && error.name === cs.dynamics.errors.userCancelledAction) {
                // User initiated cancel of this template, remove the files that have been copied.
                FileSystem.deleteFolder(fsPath);

                return null;
            }

            throw error;
        }
        
        return template;
    }

    /**
     * Deletes a template from the template root directory
     * @param template name of template
     * @returns success or failure
     */
    async deleteFromFilesystem(template: TemplateItem) {
        // no template, cancel
        if (!template || !template.location) {
            return false;
        }
            
        let templateRoot = await TemplateManager.getTemplatesFolder();
        let templateLocation:string = path.isAbsolute(template.location) ? template.location : path.join(templateRoot, template.location);

        if (FileSystem.exists(templateLocation)) {
            await QuickPicker.pickBoolean(`Are you sure you want to delete the project template '${template}'?`, "Yes", "No")
                .then(async (choice) => {
                    if (choice) {
                        if (FileSystem.stats(templateLocation).isDirectory()) {
                            await FileSystem.deleteFolder(templateLocation);
                        } else if (FileSystem.stats(templateLocation).isFile()) {
                            await FileSystem.deleteItem(templateLocation);
                        }
                    }

                    return choice;
                });

            const catalog = await TemplateManager.getTemplateCatalog();
            const index = catalog.items.findIndex(i => i.name === template.name);
            
            if (index > -1) {
                catalog.items.splice(index, 1);
                catalog.save();
            }

            return true;
        }

        return false;
    }

    static async openTemplateFolderInExplorer(template: TemplateItem, systemTemplate:boolean = false): Promise<void> {
        const templateRoot = await TemplateManager.getTemplatesFolder(systemTemplate);
        
        if (template && template.location) {
            let templateDir:string = path.isAbsolute(template.location) ? template.location : path.join(templateRoot, template.location);

            if (template.type === TemplateType.ItemTemplate) {
                templateDir = path.join(templateDir, "..");
            }

            FileSystem.openFolderInExplorer(templateDir);
        } else {
            FileSystem.openFolderInExplorer(templateRoot);
        }
    }

    /**
     * Saves a workspace as a new template
     * @param  fsPath absolute path of workspace folder/item
     * @param type the type of template to store.
     * @returns  name of template
     */
    async saveToFilesystem(fsPath: string, type: TemplateType): Promise<TemplateItem> {
        // ensure templates directory exists
        await TemplateManager.createTemplatesDirIfNotExists();

        type = type || TemplateType.ProjectTemplate;
        const fsBaseName = path.basename(fsPath, path.extname(fsPath));

        // prompt user
        return await QuickPicker.ask("Enter the desired template name", undefined, fsBaseName)
            .then(async templateName => {
                // empty filename exits
                if (!templateName) {
                    return undefined;
                }

                // determine template dir
                const templatesDir = await TemplateManager.getTemplatesFolder();
                const templateDir = path.join(templatesDir, templateName);
                
                // check if exists
                if (FileSystem.exists(templateDir)) {
                    await QuickPicker.pickBoolean(`Template '${templateName}' aleady exists.  Do you wish to overwrite?`, "Yes", "No")
                        .then(async choice => { 
                            if (choice) { 
                                await FileSystem.deleteFolder(templateDir); 
                            } else {
                                return;
                            }
                        });
                } else {
                    // Make the folder.
                    FileSystem.makeFolderSync(templateDir);
                }

                // Check to see if this template exists in the catalog.
                const templateCatalog = await TemplateManager.getTemplateCatalog();
                const categoryList = templateCatalog.queryCategoriesByType();

                let location:string;

                if (type === TemplateType.ProjectTemplate) {
                    location = templateDir;
                    // copy current workspace to new template folder
                    await FileSystem.copyFolder(fsPath, templateDir);
                } else {
                    location = path.join(templateDir, fsBaseName + path.extname(fsPath));
                    FileSystem.copyItemSync(fsPath, location);
                }

                location = path.relative(templatesDir, location);
                let templateItem;
                let isNew:boolean = false;

                if (templateCatalog && templateCatalog.query(c => c.where(i => i.name === templateName)).length === 0) {
                    templateItem = new TemplateItem();
                    isNew = true;
                } else {
                    templateItem = templateCatalog.query(c => c.where(i => i.name === templateName))[0];
                }

                templateItem.name = templateName;
                templateItem.location = location;
                templateItem.displayName = templateItem.displayName || await QuickPicker.ask(`What should we call the display name for '${templateName}'`, undefined, templateName);
                templateItem.publisher = templateItem.publisher || await QuickPicker.ask(`Who is the publisher name for '${templateItem.displayName}'`);
                templateItem.type = type;
                templateItem.categories = templateItem.categories || await QuickPicker.pickAnyOrNew("What categories apply to this template?", ...categoryList).then(i => i.map(c => c.label));

                if (isNew) {
                    templateCatalog.add(templateItem);
                }

                templateCatalog.save();

                return templateItem;
            }
        );
    }

    /**
     * Gets a copy of the template catalog
     *
     * @static
     * @param {string} [filename]
     * @returns {Promise<TemplateCatalog>}
     * @memberof TemplateManager
     */
    static async getTemplateCatalog(filename?:string, getSystemCatalog:boolean = false): Promise<TemplateCatalog> {
        const templatesDir = await TemplateManager.getDefaultTemplatesDir(getSystemCatalog);
        let returnCatalog:TemplateCatalog;
        let defaultCatalog:boolean = true;

        if (!filename) { filename = path.join(templatesDir, "catalog.json"); }

        if (filename && FileSystem.exists(filename)) {
            defaultCatalog = false;
            returnCatalog = await TemplateCatalog.read(filename);
        } else {
            returnCatalog = new TemplateCatalog();
        }

        // Load the catalog with all items by default.
        return await TemplateManager.getTemplates(templatesDir, returnCatalog.items, [ "catalog.json" ])
            .then(items => {
                returnCatalog.items = items;

                if (defaultCatalog) {
                    returnCatalog.save(filename);
                }

                return returnCatalog;
            });
    }

    private static _systemTemplates:TemplateItem[];

    static async getSystemTemplates(): Promise<TemplateItem[]> {
        if (!TemplateManager._systemTemplates || TemplateManager._systemTemplates.length === 0) { 
            TemplateManager._systemTemplates = await TemplateManager.getTemplatesFolder(true).then(folder => TemplateManager.getTemplates(folder));
        }

        return TemplateManager._systemTemplates;
    }

    static async getSystemTemplate(name:string): Promise<TemplateItem> {
        return await TemplateManager.getSystemTemplates()
            .then(templates => templates.find(t => t.name === name));
    }

    static async getTemplates(folder: string, mergeWith?:TemplateItem[], exclusions?:string[]):Promise<TemplateItem[]> {
        const templates: TemplateItem[] = [];
        const placeholderRegExp = ExtensionConfiguration.getConfigurationValueOrDefault(cs.dynamics.configuration.templates.placeholderRegExp, "#{([\\s\\S]+?)}");

        await this.getTemplateFolderItems(folder)
            .then(items => {
                items.forEach(async (i) => {
                    let templateItem:TemplateItem;
                    let type:TemplateType;
                    const isExclusion:boolean = exclusions && exclusions.length > 0 ? exclusions.findIndex(e => e === i.name) > -1 ? true : false : false;

                    if (!isExclusion) {
                        if (mergeWith && mergeWith.length > 0) {
                            const current = mergeWith.find(m => m.name === i.name);

                            if (current) {
                                templateItem = current;
                            }
                        }

                        templateItem = templateItem || new TemplateItem();
                        type = templateItem.type ? templateItem.type : i.type === vscode.FileType.Directory ? TemplateType.ProjectTemplate : TemplateType.ItemTemplate;

                        templateItem.name = templateItem.name || i.name;
                        templateItem.type = type;
                        templateItem.location = templateItem.location || i.name;
                        templateItem.placeholders = TemplateManager.mergePlaceholders(templateItem.placeholders, this.getPlaceholders(path.join(folder, i.name), placeholderRegExp, i.type === vscode.FileType.Directory).map(i => new TemplatePlaceholder(i)));

                        templates.push(templateItem);
                    }
                });
            });

        return templates;
    }

    /**
     * Returns the templates directory location.
     * If no user configuration is found, the extension will look for
     * templates in USER_DATA_DIR/Code/Templates.
     * Otherwise it will look for the path defined in the extension configuration.
     * @return the templates directory
     */
    static async getTemplatesFolder(systemTemplates:boolean = false): Promise<string> {
        let dir:string = ExtensionConfiguration.getConfigurationValue(cs.dynamics.configuration.templates.templatesDirectory);

        if (systemTemplates || !dir) {
            dir = path.normalize(TemplateManager.getDefaultTemplatesDir(systemTemplates));

            return Promise.resolve(dir);
        }

        // resolve path with variables
        await new EnvironmentVariables.default().resolve(dir)
            .then(p => dir = path.normalize(p));

        return Promise.resolve(dir);
    }

    /**
     * Returns the default templates location, which is based on the global storage-path directory.
     * @returns default template directory
     */
    static getDefaultTemplatesDir(systemTemplates:boolean = false): string {
        const templatesFolderName:string = systemTemplates ? "BuiltInTemplates" : "UserTemplates";
        
        if (!TemplateManager.context) {
            // no workspace, default to OS-specific hard-coded path
             switch (process.platform) {
                 case 'linux':
                     return path.join(os.homedir(), '.config', 'Code-Templates', templatesFolderName);
                 case 'darwin':
                     return path.join(os.homedir(), 'Library', 'Application Support', 'Code-Templates', templatesFolderName);
                 case 'win32':
                     return path.join(process.env.APPDATA!, "CloudSmith", "Code-Templates", templatesFolderName);
                 default:
                     throw Error("Unrecognized operating system: " + process.platform);
             }
        }

        // extract from workspace-specific storage path
        let userDataDir = TemplateManager.context.storagePath;

        if (!userDataDir) {
            // extract from log path
            userDataDir = TemplateManager.context.logPath;
            let gggparent = path.dirname(path.dirname(path.dirname(path.dirname(userDataDir))));
            userDataDir = path.join(gggparent, 'User', 'Templates', templatesFolderName);
        } else {
            // get parent of parent of parent to remove workspaceStorage/<UID>/<extension>
            // this is done this way to be filesystem agnostic (\ or /)
            let ggparent = path.dirname(path.dirname(path.dirname(userDataDir)));
            // add subfolder 'ProjectTemplates'
            userDataDir = path.join(ggparent, 'Templates', templatesFolderName);
        }

        return userDataDir;
    }

    /**
     * Returns a list of available project templates by reading the Templates Directory.
     * @returns list of templates found
     */
    private static async getTemplateFolderItems(folder?: string): Promise<TemplateFilesystemItem[]> {
        await this.createTemplatesDirIfNotExists();

        const templateDir: string = folder || await this.getTemplatesFolder();
        
        if (!FileSystem.exists(templateDir)) { return; }

        const templates: TemplateFilesystemItem[] = fs.readdirSync(templateDir)
            .map(item => {
                // ignore hidden folders
                if (!/^\./.exec(item)) {
                    const stat = fs.statSync(path.join(templateDir, item));
                    if (stat.isDirectory()) {
                        return new TemplateFilesystemItem(vscode.FileType.Directory, item);
                    } else if (stat.isFile()) {
                        return new TemplateFilesystemItem(vscode.FileType.File, item);
                    }
                }

                return null;
            }).filter(items => {
                return items !== null;
		    }) as TemplateFilesystemItem[];
		
        return templates;
    }

    /**
     * Creates the templates directory if it does not exists
	 * @throws Error
     */
    private static async createTemplatesDirIfNotExists() {
        const templatesDirs = [ await TemplateManager.getTemplatesFolder(true), await TemplateManager.getTemplatesFolder(false) ];
        
		templatesDirs.forEach(templatesDir => {
            if (templatesDir && !fs.existsSync(templatesDir)) {
                try {
                    FileSystem.makeFolderSync(templatesDir, 0o775);
                    fs.mkdirSync(templatesDir);
                } catch (err) {
                    if (err.code !== 'EEXIST') {
                        throw err;
                    }
                }
            }
        });
    }

    private static getPlaceholders(fsItem: string, placeholderRegExp: string, isFolder:boolean): string[] {
        const returnValue: string[] = [];
        const _getPlaceholders:(data: string | Buffer) => string[] = (data) => {
            // resolve each placeholder
            const regex = RegExp(placeholderRegExp, 'g');
            const returnValue: string[] = [];
    
            // collect set of expressions and their replacements
            let match;
            let str: string;
            let encoding: string = "utf8";
    
            if (Buffer.isBuffer(data)) {
                // get default encoding
                encoding = vscode.workspace.getConfiguration('files').get("files.encoding", "utf8");
    
                try {
                    str = data.toString(encoding);
                } catch(error) {
                    // cannot decipher text from encoding, assume raw data
                    return null;
                }
            } else {
                str = data;
            }
    
            while (match = regex.exec(str)) {
                const key = match[1];
                
                if (returnValue.indexOf(key) === -1) {
                    returnValue.push(key);
                }
            }
    
            return returnValue;
        };

        if (isFolder) {
            const paths = FileSystem.walkSync(fsItem);

            paths.forEach(p => {
                _getPlaceholders(p).forEach(i => { if (returnValue.indexOf(i) === -1) { returnValue.push(i); } });
                _getPlaceholders(FileSystem.readFileSync(p)).forEach(i => { if (returnValue.indexOf(i) === -1) { returnValue.push(i); } });
            });        
        } else {
            _getPlaceholders(fsItem).forEach(i => { if (returnValue.indexOf(i) === -1) { returnValue.push(i); } });
            _getPlaceholders(FileSystem.readFileSync(fsItem)).forEach(i => { if (returnValue.indexOf(i) === -1) { returnValue.push(i); } });
        }

        return returnValue;
    }

    private static mergePlaceholders(source:TemplatePlaceholder[], merge:TemplatePlaceholder[]) {
        let merged:TemplatePlaceholder[] = [];
        
        if (source) { 
            merged.push(...source);
        }

        merge.forEach(i => {
            const index = merged.findIndex(m => m.name === i.name);

            if (index === -1) {
                merged.push(i);
            }
        });

        return merged;
    }

    /**
     * Replaces any placeholders found within the input data.  Will use a 
     * dictionary of values from the user's workspace settings, or will prompt
     * if value is not known.
     * 
     * @param data input data
     * @param placeholderRegExp  regular expression to use for detecting 
     *                           placeholders.  The first capture group is used
     *                           as the key.
     * @param placeholders dictionary of placeholder key-value pairs
     * @returns the (potentially) modified data, with the same type as the input data 
     */
    private static async resolvePlaceholders(
        data: string | Buffer, 
        placeholderRegExp: string,
        placeholders: Dictionary<string, string>,
        templateInfo: TemplateItem,
        resolvers?:((data:string | Buffer, placeholderRegExp:RegExp, template?:TemplateItem, defaultPlaceholders?:Dictionary<string, string>) => string | Buffer)[]): Promise<string | Buffer> {

        // resolve each placeholder
        const regex = RegExp(placeholderRegExp, 'g');

        placeholders = placeholders || new Dictionary<string, string>();
        resolvers = resolvers || [];

        data = await this.defaultResolver(data, regex, templateInfo, placeholders);

        await resolvers.forEach(async resolver => {
            data = await resolver(data, regex, templateInfo, placeholders);
        });

        return data;
    }

    private static async defaultResolver(data:string | Buffer, placeholderRegExp:RegExp, template?:TemplateItem, defaultPlaceholders?:Dictionary<string, string>): Promise<string | Buffer> {
        let encoding: string = "utf8";
        let isBuffer: boolean = false;

        if (Buffer.isBuffer(data)) {
            // get default encoding
            encoding = vscode.workspace.getConfiguration('files').get("files.encoding", "utf8");
            isBuffer = true;

            try {
                data = data.toString(encoding);
            } catch(error) {
                // cannot decipher text from encoding, assume raw data
                return data;
            }
        } else {
            data = data;
        }

        let match;
        let nmatches = 0;
        let placeholders = defaultPlaceholders || new Dictionary<string, string>();

        while (match = placeholderRegExp.exec(<string>data)) {
            let key = match[1];
            let val : string | undefined = placeholders[key];
            let placeholderItem;

            if (template.placeholders && template.placeholders.length > 0) {
                placeholderItem = <TemplatePlaceholder>template.placeholders.find(p => p.name === key);
            }

            let attempts:number = 0;
            let cancel:boolean = false;

            // This parser can't compile object expressions.
            if (key && key.indexOf(".") > -1) {
                continue;
            }

            while ((!val && attempts === 0) || (!val && placeholderItem && placeholderItem.required) || !cancel) {
                if (attempts >= 1) {
                    await QuickPicker.inform(`The template requires a response for the placeholder '${match[0]}'.`, false, "Try Again", undefined, "Cancel", () => cancel = true);
                    
                    if (cancel) {
                        const error = new Error(`The user has requested to cancel template processing${template ? " for '" + template.name : "'"}`);
                        error.name = cs.dynamics.errors.userCancelledAction;

                        throw error;
                    }
                }

                val = val || await QuickPicker.ask(placeholderItem ? placeholderItem.displayName : `Please enter the desired value for "${match[0]}"`)
                    .then(value => { if (value) { placeholders[key] = value; } return value; });

                if (Utilities.IsNullOrEmpty(val)) { val = undefined; }
                if (val) { cancel = true; }

                attempts++;
            }

            ++nmatches;
        }

        // reset regex
        placeholderRegExp.lastIndex = 0;

        // compute output
        let out : string | Buffer = data;
        
        if (nmatches > 0) {
            // replace placeholders in string
            data = data.replace(placeholderRegExp, (match, key) => placeholders[key] || match);

            // if input was a buffer, re-encode to buffer
            if (isBuffer) {
                out = Buffer.from(data, encoding);
            } else {
                out = data;
            }
        }

        return out;
    }
} // templateManager

class TemplateFilesystemItem {
    constructor(
        public type: vscode.FileType,
        public name: string
    ) { }
}