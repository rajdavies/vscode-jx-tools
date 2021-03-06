import { EventEmitter, TreeItem, Event, TreeItemCollapsibleState, Uri, TextDocumentContentProvider, CancellationToken, ProviderResult, TreeView } from 'vscode';
import * as vscode from 'vscode';
import { TreeDataProvider } from 'vscode';
const k8s = require('@kubernetes/client-node');


interface ModelNode {
    readonly resource: vscode.Uri;
    readonly isDirectory: boolean;
    readonly label: string;
    readonly title: string;

    getChildren(): ModelNode[];

    parent(): ModelNode;
}

export class BuildNode implements ModelNode {
    pipeline: any = null;

    constructor(public resource: vscode.Uri, public repo: RepoNode, public buildNumber: string) {
    }

    getChildren(): ModelNode[] {
        return [];
    }

    parent(): ModelNode {
        return this.repo;
    }

    get isDirectory(): boolean {
        return false;
    }

    get title(): string {
        return "Build";
    }

    get label(): string {
        return this.buildNumber;
    }
}


export class RepoNode implements ModelNode {
    private nodes: Map<string, BuildNode> = new Map<string, BuildNode>();

    constructor(public resource: vscode.Uri, public owner: OwnerNode, public repoName: string) {
    }

    isEmpty(): boolean {
        return this.nodes.size === 0;
    }

    get isDirectory(): boolean {
        return true;
    }

    get title(): string {
        return "Repository";
    }

    get label(): string {
        return this.repoName;
    }

    parent(): ModelNode {
        return this.owner;
    }

    getChildren(): ModelNode[] {
        // TODO sorting
        let answer: ModelNode[] = [];
        this.nodes.forEach((value: BuildNode, key: string) => {
            answer.push(value);
        });
        return answer;
        /*         return this.nodes.values().sort((n1, n2) => {
            if (n1.buildNumber && !n2.buildNumber) {
                return 1;
            }

            if (!n1.buildNumber && n2.buildNumber) {
                return -1;
            }

            return n2.buildNumber.localeCompare(n1.buildNumber);
        });
 */    }


    upsertPipeline(buildNumber: string, pipeline: any) {
        if (buildNumber) {
            var build = this.nodes.get(buildNumber);
            if (!build) {
                build = new BuildNode(addChildUrl(this.resource, buildNumber), this, buildNumber);
                this.nodes.set(buildNumber, build);
            }
            build.pipeline = pipeline;
        }
    }

    deletePipeline(buildNumber: string, pipeline: any) {
        if (buildNumber) {
            this.nodes.delete(buildNumber);
        }
    }

}

/** Returns a relative URI */
function addChildUrl(uri: vscode.Uri, path: string): vscode.Uri {
    return uri.with({ path: uri.path + "/" + path });
}

export class OwnerNode implements ModelNode {
    private nodes: Map<string, RepoNode> = new Map<string, RepoNode>();

    constructor(public resource: vscode.Uri, public model: PipelineModel, public folder: string) {
    }

    isEmpty(): boolean {
        return this.nodes.size === 0;
    }

    get isDirectory(): boolean {
        return true;
    }

    get title(): string {
        return "Organisation";
    }

    get label(): string {
        return this.folder;
    }

    parent(): ModelNode {
        return this.model;
    }

    getChildren(): ModelNode[] {
        // TODO sorting
        let answer: ModelNode[] = [];
        this.nodes.forEach((value: RepoNode, key: string) => {
            answer.push(value);
        });
        return answer;
    }

    upsertPipeline(repoName: string, buildNumber: string, pipeline: any) {
        if (repoName) {
            var repo = this.nodes.get(repoName);
            if (!repo) {
                repo = new RepoNode(addChildUrl(this.resource, repoName), this, repoName);
                this.nodes.set(repoName, repo);
            }
            repo.upsertPipeline(buildNumber, pipeline);
        }
    }

    deletePipeline(repoName: string, buildNumber: string, pipeline: any) {
        if (repoName) {
            var repo = this.nodes.get(repoName);
            if (repo) {
                repo.deletePipeline(buildNumber, pipeline);
            }
        }
    }
}

export class PipelineModel implements ModelNode {

    private nodes: Map<string, OwnerNode> = new Map<string, OwnerNode>();
    private _onDidChangeTreeData: EventEmitter<any> = new EventEmitter<any>();

    readonly onDidChangeTreeData: Event<any> = this._onDidChangeTreeData.event;
    resource: vscode.Uri = Uri.parse("pipeline:localhost");

    getChildren(): ModelNode[] {
        // TODO sorting
        let answer: ModelNode[] = [];
        this.nodes.forEach((value: OwnerNode, key: string) => {
            answer.push(value);
        });
        return answer;
    }

    parent(): ModelNode {
        return this;
    }

    get isDirectory(): boolean {
        return true;
    }


    get title(): string {
        return "Pipelines";
    }

    get label(): string {
        return "Pipelines";
    }

    getNodeChildren(element?: ModelNode): ModelNode[] {
        return element ? element.getChildren() : this.getChildren();
    }

    upsertPipeline(folder: string, repoName: string, buildNumber: string, pipeline: any) {
        if (folder) {
            var owner = this.nodes.get(folder);
            if (!owner) {
                owner = new OwnerNode(addChildUrl(this.resource, folder), this, folder);
                this.nodes.set(folder, owner);
            }
            owner.upsertPipeline(repoName, buildNumber, pipeline);
        }
    }

    deletePipeline(folder: string, repoName: string, buildNumber: string, pipeline: any) {
        if (folder) {
            var owner = this.nodes.get(folder);
            if (owner) {
                owner.deletePipeline(repoName, buildNumber, pipeline);
                if (owner.isEmpty()) {
                    this.nodes.delete(folder);
                }
            }
        }
    }

    public connect() {
        let kc = new k8s.KubeConfig();
        let configFile = process.env['HOME'] + '/.kube/config';
        try {
            kc.loadFromFile(configFile);
        } catch (e) {
            console.log('error reading ' + configFile + ': ' + e.message);
            throw e;
        }

        let watch = new k8s.Watch(kc);
        watch.watch('/apis/jenkins.io/v1/namespaces/jx/pipelineactivities',
            // optional query parameters can go here.
            // TODO filter on labels once we add them to Activities
            {},
            // callback is called for each received object.
            (type: any, obj: any) => {
                let name = obj.metadata.name;
                let spec = obj.spec;

                if (!name || !spec) {
                    return;
                }

                let buildNumber = spec.build;
                if (!buildNumber) {
                    console.log("missing build number: " + buildNumber + " for name: " + name);
                    return;
                }
                let folder = spec.gitOwner;
                let repoName = spec.gitRepository;
                if (!folder || !repoName) {
                    let pipeline = spec.pipeline;
                    if (pipeline) {
                        let values = pipeline.split("/");
                        if (values && values.length > 2) {
                            folder = values[0];
                            repoName = values[1];
                        }
                    }
                }
                if (!folder || !repoName) {
                    console.log("missing data for pipeline folder: " + folder + " repo: " + repoName + " build: " + buildNumber);
                    return;
                }

                if (type === 'ADDED' || type === 'MODIFIED') {
                    this.upsertPipeline(folder, repoName, buildNumber, obj);
                    this.fireChangeEvent();
                } else if (type === 'DELETED') {
                    this.deletePipeline(folder, repoName, buildNumber, obj);
                    this.fireChangeEvent();
                }
            },
            // done callback is called if the watch terminates normally
            (err: any) => {
                if (err) {
                    console.log(err);
                }
            });
    }

    fireChangeEvent() {
        this._onDidChangeTreeData.fire();
    }


    public getContent(resource: Uri): Thenable<string> {
        return new Promise((c, e) => {
            return c("This is some generated pipeline text");
        });
    }
}

export class PipelineTreeDataProvider implements TreeDataProvider<ModelNode>, TextDocumentContentProvider {

    constructor(private readonly model: PipelineModel) { }

    public refresh(): any {
        this.model.fireChangeEvent();
    }

    get onDidChangeTreeData(): Event<any> {
        return this.model.onDidChangeTreeData;
    }

    public getTreeItem(element: ModelNode): TreeItem {
        return {
            label: element.label,
            resourceUri: element.resource,
            collapsibleState: element.isDirectory ? TreeItemCollapsibleState.Collapsed : void 0,
            command: element.isDirectory ? void 0 : {
                command: 'PipelineExplorer.openFtpResource',
                arguments: [element.resource],
                title: element.title,
            }
        };
    }

    public getChildren(element?: ModelNode): ModelNode[] | Thenable<ModelNode[]> {
        return this.model.getNodeChildren(element);
    }

    public getParent(element: ModelNode): ModelNode {
        return element.parent();
    }

    public provideTextDocumentContent(uri: Uri, token: CancellationToken): ProviderResult<string> {
        return this.model.getContent(uri).then(content => content);
    }
}

export class PipelineExplorer {
    private pipelineViewer: TreeView<ModelNode>;
    private pipelineModel = new PipelineModel();
    private treeProvider = new PipelineTreeDataProvider(this.pipelineModel);

    constructor() {
        this.pipelineViewer = vscode.window.createTreeView('extension.vsJenkinsXExplorer', { treeDataProvider: this.treeProvider });
    }

    subscribe(context: vscode.ExtensionContext) {
        this.pipelineModel.connect();


        return [
            vscode.workspace.registerTextDocumentContentProvider('pipeline', this.treeProvider),
            vscode.window.registerTreeDataProvider('extension.vsJenkinsXExplorer', this.treeProvider),

            vscode.commands.registerCommand('PipelineExplorer.refresh', () => this.treeProvider.refresh()),
            vscode.commands.registerCommand('PipelineExplorer.openPipelineResource', resource => this.openResource(resource)),
            vscode.commands.registerCommand('PipelineExplorer.revealResource', () => this.reveal()),
        ];
    }
//    private openResource(resource?: vscode.Uri): void {

    private openResource(resource: any): void {
        if (!resource) {
            console.log("No resource selected!");
        } else {
            console.log("About to open resource " + resource);
        }
    }

    private reveal(): void {
        const node = this.getNode();
        if (node) {
            this.pipelineViewer.reveal(node);
        }
    }

    private getNode(): ModelNode | null {
        if (vscode.window.activeTextEditor) {
            const uri = vscode.window.activeTextEditor.document.uri;
            if (uri.scheme === 'pipeline') {
                return nodeForUri(uri, this.pipelineModel);
            }
        }
        return null;
    }

}

/*
 * Returns the node for the given URI
 */
function nodeForUri(uri: vscode.Uri, node: ModelNode): ModelNode | null {
    if (!node) {
        return null;
    }
    if (node.resource === uri) {
        return node;
    }
    for (let child of node.getChildren()) {
        let answer = nodeForUri(uri, child);
        if (answer) {
            return answer;
        }
    }
    return null;
}