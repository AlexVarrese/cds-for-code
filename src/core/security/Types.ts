import Encryption from "./Encryption";
import { Utilities } from "../Utilities";
import { AuthenticationResult } from "./Authentication";
import { access } from "fs";
import * as vscode from 'vscode';

/**
 * @type represents an item that can be secured.
 */
export type Securable = Buffer | string | undefined;

/**
 * Represents the type of output to use when decrypting a secure value.
 * @export SecureOutput
 * @enum {number} representing a Buffer or String
 */
export enum SecureOutput {
    Buffer,
    String
}

/**
 * Represents an type that can perform symetric encryption/decryption.
 * @export ICryptography
 * @interface ICryptography
 */
export interface ICryptography {
    encrypt(value: Securable): SecureItem | null;
    decrypt(value: SecureItem, preferredOutput?: SecureOutput): Securable | null;
}

/**
 * Represents an item that has been encrypted and can be decrypted by it's correspodnign 
 * private key (or private key store)
 *
 * @export
 * @interface ISecureItem
 */
export interface ISecureItem {
    readonly buffer: { iv: Buffer; data: Buffer; };
    readonly string: { iv: string; data: string; };
    
    decrypt(decryptStore: ICryptography, preferredOutput?: SecureOutput): Securable | null;
}

/**
 * Represents a set of credentials that can be encrypted and decrypted.
 *
 * @export
 * @interface ICredential
 */
export interface ICredential {
    /**
     * Represents a public key that can be used to refer to this credential when in the credential store.
     * @type {string}
     * @memberof ICredential
     */
    readonly storeKey?: string;

    username: Securable | ISecureItem;
    password: Securable | ISecureItem;

    readonly isSecure: boolean;

    decrypt<T extends ICredential>(store: ICredentialStore, key: string, preferredOutput?: SecureOutput, keepEncrypted?: string[]): T | null;
    store(store: ICredentialStore): string | null;
    toString(): string;
}

export interface ICredentialStore { 
    readonly cryptography: ICryptography;

    decrypt<T extends ICredential>(key: string, credential?: T | undefined, preferredOutput?: SecureOutput, keepEncrypted?: string[]): T | null;
    delete(key: string): void;
    retreive<T extends ICredential>(key: string, credential?: T | undefined): T | null;
    secure(securable: Securable): SecureItem | null;
    store<T extends ICredential>(credential: T, key?: string, keepDecrypted?: string[]): string | null;
}

/**
 * Represents a secure item (string or buffer) with the needed components
 * (minus key, of course) to decrypt them.
 *
 * @class SecureItem
 */
export class SecureItem implements ISecureItem {
    static from(iv: Securable, data: Securable, preferredOutput: SecureOutput = SecureOutput.Buffer): SecureItem {
        return new SecureItem(iv, data, preferredOutput);
    }

    static isSecure(item:any) {
        return item instanceof SecureItem || (typeof item !== "undefined" && item.data && item.iv);
    }

    static asSecureItem(item:any): SecureItem | undefined {
        if (item instanceof SecureItem) {
            return <SecureItem>item;
        }

        if (item.data && item.iv) {
            return Encryption.createSecureItem(item.iv, item.data);
        }
    }

    private constructor(readonly iv: Securable, readonly data: Securable, readonly preferredOutput: SecureOutput) {
        if (iv && !Buffer.isBuffer(iv)) {
            this.iv = Buffer.from(Utilities.Encoding.hexToBytes(iv));
        }
    
        if (data && !Buffer.isBuffer(data)) {
            this.data = Buffer.from(Utilities.Encoding.hexToBytes(data));
        }
    }

    decrypt(decryptStore:ICryptography, preferredOutput?: SecureOutput): Securable | null | undefined {
        return decryptStore.decrypt(this, preferredOutput || this.preferredOutput);
    }
    
    get buffer(): { iv: Buffer; data: Buffer; } {
        return { iv: <Buffer>this.iv, data: <Buffer>this.data };
    }
    
    get string(): { iv: string; data: string; } {
        return { iv: this.iv ? this.iv.toString('hex') : "", data: this.data ? this.data.toString('hex') : "" };
    }
}

export abstract class CredentialStore implements ICredentialStore {
    public abstract get cryptography(): ICryptography;
    protected abstract onStore(encrypted: any, key: string): void;
    protected abstract onRetreive(key: string): any;
    protected abstract onDelete(key: string): void;

    delete(key: string): void {
        const encrypteed = this.onRetreive(key);

        if (!encrypteed) { return; }

        this.onDelete(key);
    }

    decrypt<T extends ICredential>(key: string, credential?: T, preferredOutput?: SecureOutput, keepEncrypted?: string[]): T | null {
        let encrypted = this.onRetreive(key);

        // We don't really want byte arrays for creds (most of the time).
        preferredOutput = preferredOutput || SecureOutput.String;

        if (!encrypted && Credential.isCredential(credential) && (<Credential>credential).isSecure) {
             encrypted = credential;
        } else if (!encrypted) {
            return null;
        }

        if (!credential) { 
            credential = <T>{ storeKey: key };
        }

        const returnCredential = Credential.from(Utilities.$Object.clone(credential));

        if (returnCredential) { 
            if (encrypted) {
                Object.keys(encrypted).forEach(k => {
                    if (keepEncrypted && keepEncrypted.length > 0 && keepEncrypted.find(key => k.toLowerCase() === key.toLowerCase())) {
                        (<any>returnCredential)[k] = encrypted[k];
                    } else if (SecureItem.isSecure(encrypted[k])) {
                        (<any>returnCredential)[k] = this.cryptography.decrypt(<SecureItem>encrypted[k], preferredOutput);
                    } else {
                        (<any>returnCredential)[k] = encrypted[k];
                    }
                });
            }
        }

        return <T>returnCredential;
    }

    retreive<T extends ICredential>(key: string, credential?:T): T | null {
        const encrypted = this.onRetreive(key);

        if (!encrypted) { return null; }

        if (!credential) { 
            credential = <T>{ storeKey: key };
        }

        Object.keys(encrypted).forEach(k => {
            if (SecureItem.isSecure(encrypted[k])) {
                (<any>credential)[k] = SecureItem.asSecureItem(encrypted[k]);
            } else {
                (<any>credential)[k] = encrypted[k];
            }
        });

        return credential;
    }

    secure(securable:Securable): SecureItem | null {
        return this.cryptography.encrypt(securable);
    }

    store<T extends ICredential>(credential: T, key?: string, keepDecrypted?: string[]): string {        
        let storeObject:any = {};
        key = key || credential.storeKey || Utilities.Guid.newGuid();

        if (credential) {
            keepDecrypted = keepDecrypted || [];
            keepDecrypted.push("isSecure", "storeKey");

            Object.keys(credential).forEach(k => {
                if (Encryption.isSecurable((<any>credential)[k])) {
                    if (keepDecrypted && keepDecrypted.length > 0 && keepDecrypted.find(key => key.toLowerCase() === k.toLowerCase())) {
                        storeObject[k] = credential[k];
                    } else {
                        const secured: any | null = this.cryptography.encrypt((<any>credential)[k]);
    
                        if (secured !== null) {
                            storeObject[k] = secured.string;
                        }
                    }
                } else if (SecureItem.isSecure((<any>credential)[k])) {
                    storeObject[k] = (<ISecureItem>(<any>credential)[k]).string;
                }
            });
        }
    
        this.onStore(storeObject, key);

        return key;
    }
}

export abstract class Credential implements ICredential {
    protected constructor(
        public username: ISecureItem | Securable,
        public password: ISecureItem | Securable, 
        public storeKey?:string) { 
    }

    static get Empty(): Credential {
        return <Credential>{};
    }

    static from<T extends ICredential>(value:any, key?:string): T {
        if (value && 
            (value instanceof CdsOnlineCredential 
            || value instanceof AzureAdClientCredential 
            || value instanceof AzureAdUserCredential 
            || value instanceof WindowsCredential 
            || value instanceof OAuthCredential 
            || value instanceof Credential)) {
                if (key) {
                    value.storeKey = key;
                }
        
                return <T>value;
        }

        let cred:Credential = Credential.Empty;

        if (this.isCdsOnlineUserCredential(value)) {
            cred = new CdsOnlineCredential(value.username, value.password, value.authority, value.tenant, value.clientId, value.resource, value.refreshToken, value.accessToken);
        } else if (this.isAzureAdClientCredential(value)) {
            cred = new AzureAdClientCredential(value.clientId, value.clientSecret, value.authority, value.resource, value.refreshToken, value.accessToken);
        } else if (this.isAzureAdUserCredential(value)) {
            cred = new AzureAdUserCredential(value.username, value.password, value.clientId, value.clientSecret, value.authority, value.resource, value.refreshToken, value.accessToken);
        } else if (this.isWindowsCredential(value)) {
            cred = new WindowsCredential(value.domain, value.username, value.password);
        } else if (this.isOauthCredential(value)) {
            cred = new OAuthCredential(value.username, value.password, value.refreshToken, value.accessToken);
        } else if (this.isCredential(value)) {
            cred = <Credential>value;
        }

        if (cred && key) {
            cred.storeKey = key;
        }

        return <T>cred;
    }

    static isCredential(value:any): boolean {
        return value && value.hasOwnProperty("username") && value.hasOwnProperty("password");
    }

    static isWindowsCredential(value:ICredential): boolean {
        return value && this.isCredential(value) && value.hasOwnProperty("domain");
    }

    static isOauthCredential(value:ICredential): boolean {
        return value && this.isCredential(value) && value.hasOwnProperty("refreshToken") && value.hasOwnProperty("accessToken");
    }

    static isAzureAdClientCredential(value:ICredential): boolean {
        return value && value.hasOwnProperty("clientId") && value.hasOwnProperty("clientSecret") && value.hasOwnProperty("authority") && value.hasOwnProperty("resource");
    }

    static isAzureAdUserCredential(value:ICredential): boolean {
        return value && this.isOauthCredential(value) && value.hasOwnProperty("clientId") && value.hasOwnProperty("clientSecret") && value.hasOwnProperty("authority") && value.hasOwnProperty("resource");
    }

    static isCdsOnlineUserCredential(value:ICredential): boolean {
        return value && this.isCredential(value) && value.hasOwnProperty("resource");
    }

    static needsToken(value:ICredential): boolean { 
        return this.requireToken(value) && !Utilities.$Object.isNullOrEmpty((<OAuthCredential>value).refreshToken);
    }

    static requireToken(value:ICredential): boolean { 
        return value.hasOwnProperty("refreshToken");
    }

    static retreive<T extends ICredential>(store:ICredentialStore, key: string): T | null {
        if (!store) { return null; }

        return store.retreive<T>(key, undefined);
    }

    static setToken(value:ICredential, token:string) {
        if (this.isOauthCredential(value)) {            
            (<OAuthCredential>value).refreshToken = token;
        }
    }

    static isSecureCredential<T extends ICredential>(credential: T): boolean {
        return credential.isSecure;
    }

    get isSecure(): boolean {
        return SecureItem.isSecure(this.username) && SecureItem.isSecure(this.password);
    }

    decrypt<T extends ICredential>(store:ICredentialStore, key:string, preferredOutput?: SecureOutput, keepEncrypted?: string[]): T | null {
        if (!store) { return null; }

        const decrypted = store.decrypt<T>(key, undefined, preferredOutput, keepEncrypted);

        if (!Utilities.$Object.isNullOrEmpty(decrypted)) {
            Utilities.$Object.clone(decrypted, this);
        }

        return decrypted;
    }

    store(store:ICredentialStore): string | null {
        if (!store) { return null; }

        return store.store(<ICredential>this);
    }

    toString():string {
        return (SecureItem.isSecure(this.username) ? "" : this.username ? this.username.toString() : "");
    }
}

export class WindowsCredential extends Credential {
    constructor(public domain: Securable, username: SecureItem | Securable, password: SecureItem | Securable) {
        super(username, password);
    }

    toString():string {
        return (this.domain && this.domain !== "" ? `${this.domain.toString()}\\` : "") + SecureItem.isSecure(this.username) ? "" : this.username ? this.username.toString() : "";
    }
}

export class OAuthCredential extends Credential {
    constructor(username: SecureItem | Securable, password: SecureItem | Securable, public refreshToken?: SecureItem | Securable, public accessToken?: SecureItem | Securable) {
        super(username, password);
    }

    isMultiFactorAuthentication: boolean;

    private _onDidAuthenticate: vscode.EventEmitter<AuthenticationResult> = new vscode.EventEmitter();
    private _onInteractiveLoginRequired: vscode.EventEmitter<AuthenticationResult> = new vscode.EventEmitter();

    onInteractiveLoginRequired: vscode.Event<AuthenticationResult> = this._onInteractiveLoginRequired.event;
    onDidAuthenticate: vscode.Event<AuthenticationResult> = this._onDidAuthenticate.event;

    onInteractiveLogin(result: AuthenticationResult) {
        if (this._onInteractiveLoginRequired) {
            this._onInteractiveLoginRequired.fire(result);
        }
    }

    onAuthenticate(result: AuthenticationResult) {
        if (result.success) {
            this.accessToken = result.response.accessToken;
            this.refreshToken = result.response.refreshToken;
        }

        if (result.response.expiresIn) {
            const seconds = Number.parseInt(result.response.expiresIn);

            // Auto-expire this token, forcing us to get a new one with our refresh token.
            if (!Number.isNaN(seconds)) {
                global.setTimeout(() => this.accessToken = null, seconds * 1000);
            }
        }

        if (this._onDidAuthenticate) {
            this._onDidAuthenticate.fire(result);
        }
    }

}

export class AzureAdClientCredential extends OAuthCredential {
    constructor(
        public clientId: Securable | SecureItem, 
        public clientSecret: Securable | SecureItem, 
        public authority: string, 
        public resource: string, 
        refreshToken?: SecureItem | Securable,
        accessToken?: SecureItem | Securable) {
        super(clientId, clientSecret, refreshToken, accessToken);
    }
}

export class AzureAdUserCredential extends OAuthCredential {
    constructor(
        username: SecureItem | Securable, 
        password: SecureItem | Securable, 
        public clientId: Securable | SecureItem, 
        public clientSecret: Securable | SecureItem, 
        public authority: string,
        public resource: string, 
        refreshToken?: SecureItem | Securable,
        accessToken?: SecureItem | Securable) {
        super(username, password, refreshToken, accessToken);
    }
}

export class CdsOnlineCredential extends OAuthCredential {
    // These are public CRMOL auth values, we're using CloudSmith values here.
    static readonly publicClientId:string = "51f81489-12ee-4a9e-aaae-a2591f45987d";
    static readonly publicTenant:string = "common";

    static readonly defaultClientId:string = "38496a28-9c28-4ff8-8dac-ef2fe85f6275";
    static readonly defaultAuthority:string = "https://login.microsoftonline.com";
    // Do not use the AD tenant for CloudSmith consulting here, use Common tenant instead so that we can auth against any AD tenant.
    static readonly defaultTenant:string = "common";
    static readonly defaultResource:string = "https://disco.crm.dynamics.com/";

    constructor(
        username: SecureItem | Securable,
        password: SecureItem | Securable, 
        public authority: string = CdsOnlineCredential.defaultAuthority, 
        public tenant: string = CdsOnlineCredential.publicTenant,
        public clientId: SecureItem | Securable = CdsOnlineCredential.publicClientId,
        public resource: string = CdsOnlineCredential.defaultResource,
        refreshToken?: SecureItem | Securable,
        accessToken?: SecureItem | Securable) {
        super(username, password, refreshToken, accessToken);

        // We use the public endpoint by default, but it cannot complete MFA because it redirects to https://callbackurl and 
        // we don't spoof that or play dirty tricks :)
        this.onInteractiveLoginRequired((result) => {
            if (this.clientId === CdsOnlineCredential.publicClientId) {
                this.clientId = CdsOnlineCredential.defaultClientId;
            }

            if (this.tenant === CdsOnlineCredential.publicTenant) {
                this.tenant = CdsOnlineCredential.defaultTenant;
            }
        });
    }
}

export const sensitiveKeys: string[] = [ "credentials", "password", "refreshToken", "accessToken" ];