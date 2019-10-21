import * as vscode from 'vscode';
import { DynamicsWebApiClient } from "./DynamicsWebApi/DynamicsWebApi";
import { TS } from 'typescript-linq/TS';

export default class ApiRepository
{
    private config:DynamicsWebApi.Config;

    public constructor (config:DynamicsWebApi.Config)
    {
        this.config = config;
        this.webapi = new DynamicsWebApiClient(this.config);
    }

    private webapi: DynamicsWebApiClient;

    public async whoAmI() : Promise<any>
    {
        return await this.webapi.executeUnboundFunction('WhoAmI');
    }

    public retrieveSolutions<T>() : Promise<T[] | unknown[]> {
        let request:DynamicsWebApi.RetrieveMultipleRequest = {
            collection: "solutions",
            filter: "isvisible eq true",
            orderBy: ["uniquename"]
        };

        return this.webapi.retrieveAllRequest(request)
            .then(response => response.value);
    }

    public retrievePluginAssemblies(solutionId?:string) : Promise<any[]> {
        let request:DynamicsWebApi.RetrieveMultipleRequest = {
            collection: "pluginassemblies",
            orderBy: ["name"]
        };

        return this.webapi.retrieveAllRequest(request)
            .then(response => {
                if (solutionId) {
                    let solutionQuery:DynamicsWebApi.RetrieveRequest = {
                        collection: "solutions",
                        id: solutionId,
                        expand: [ { property: "solution_solutioncomponent", filter: "componenttype eq 91" } ]
                    };    
                    
                    return this.webapi.retrieveRequest(solutionQuery).then(solution => {
                        if (!solution || !solution.solution_solutioncomponent || solution.solution_solutioncomponent.length === 0)
                        {
                            return null;
                        }
            
                        let components = new TS.Linq.Enumerator(solution.solution_solutioncomponent);
                        let filteredList = components
                            .join(new TS.Linq.Enumerator(response.value), c => c["objectid"], p => p["pluginassemblyid"], (c, p) => p)
                            .where(p => p["ishidden"].Value === false)
                            .toArray();
            
                        return filteredList;
                    });           
                } else {
                    return new TS.Linq.Enumerator(response.value).where(plugin => plugin["ishidden"].Value === false).toArray();
                }
            });
    }
}