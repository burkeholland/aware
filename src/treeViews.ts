/**
 * Tree views for the Aware extension sidebar
 */

import * as vscode from 'vscode';
import { RelatedDocument } from './types';
import { DocumentService } from './documentService';

// Related Documents Tree View
type DocumentTreeElement = DocumentTreeItem | NoRepoItem | ErrorItem;

export class DocumentsTreeDataProvider implements vscode.TreeDataProvider<DocumentTreeElement> {
    private _onDidChangeTreeData = new vscode.EventEmitter<DocumentTreeElement | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    private isLoading = false;

    constructor(private documentService: DocumentService) {
        this.documentService.onDocumentsUpdated(() => {
            this.isLoading = false;
            this._onDidChangeTreeData.fire();
        });

        this.documentService.onLoadingStarted(() => {
            this.isLoading = true;
            this._onDidChangeTreeData.fire();
        });
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: DocumentTreeElement): vscode.TreeItem {
        return element;
    }

    getChildren(): Thenable<DocumentTreeElement[]> {
        if (this.isLoading) {
            return Promise.resolve([new DocumentTreeItem(null, 'loading')]);
        }

        // Check for error state first
        const lastError = this.documentService.getLastError();
        if (lastError) {
            return Promise.resolve([new ErrorItem(lastError)]);
        }

        const repoName = this.documentService.getCurrentRepoNameCached();
        if (!repoName) {
            return Promise.resolve([new NoRepoItem()]);
        }

        const documents = this.documentService.getCachedDocuments();
        if (documents.length === 0) {
            return Promise.resolve([new DocumentTreeItem(null, 'empty')]);
        }

        return Promise.resolve(
            documents.map(doc => new DocumentTreeItem(doc, 'document'))
        );
    }
}

export class ErrorItem extends vscode.TreeItem {
    constructor(errorMessage: string) {
        super('Connection Issue', vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('errorForeground'));
        this.description = 'Click to retry';
        this.tooltip = errorMessage;
        this.command = {
            command: 'aware.refreshDocuments',
            title: 'Retry'
        };
    }
}

export class NoRepoItem extends vscode.TreeItem {
    constructor() {
        super('No repository detected', vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon('folder');
        this.description = 'Open a workspace folder';
    }
}

export class DocumentTreeItem extends vscode.TreeItem {
    constructor(
        public readonly document: RelatedDocument | null,
        public readonly type: 'document' | 'empty' | 'loading'
    ) {
        super(
            document ? document.title : (type === 'loading' ? 'Loading documents...' : 'No related documents'),
            vscode.TreeItemCollapsibleState.None
        );

        if (type === 'loading') {
            this.iconPath = new vscode.ThemeIcon('loading~spin');
            this.description = 'Searching...';
            return;
        }

        if (!document) {
            this.iconPath = new vscode.ThemeIcon('file');
            this.description = 'No documents found for this repo';
            return;
        }

        this.iconPath = this.getIconForType(document.type);
        this.description = document.lastModified ? this.formatDate(document.lastModified) : document.type;

        if (document.url) {
            this.command = {
                command: 'vscode.open',
                title: 'Open Document',
                arguments: [vscode.Uri.parse(document.url)]
            };
        }

        this.tooltip = new vscode.MarkdownString(
            `**${document.title}**\n\n` +
            `Type: ${document.type}\n` +
            (document.lastModified ? `Last Modified: ${document.lastModified.toLocaleDateString()}\n` : '') +
            (document.url ? `\n[Click to open](${document.url})` : `\nLink unavailable in Work IQ results`)
        );
        this.tooltip.isTrusted = true;
        this.contextValue = document.url ? 'relatedDocument' : 'relatedDocumentNoUrl';
    }

    private getIconForType(type: string): vscode.ThemeIcon {
        const typeLower = type.toLowerCase();
        if (typeLower.includes('word') || typeLower.includes('doc')) {
            return new vscode.ThemeIcon('file-text', new vscode.ThemeColor('charts.blue'));
        }
        if (typeLower.includes('excel') || typeLower.includes('xls')) {
            return new vscode.ThemeIcon('table', new vscode.ThemeColor('charts.green'));
        }
        if (typeLower.includes('powerpoint') || typeLower.includes('ppt')) {
            return new vscode.ThemeIcon('preview', new vscode.ThemeColor('charts.orange'));
        }
        if (typeLower.includes('pdf')) {
            return new vscode.ThemeIcon('file-pdf', new vscode.ThemeColor('charts.red'));
        }
        if (typeLower.includes('onenote')) {
            return new vscode.ThemeIcon('notebook', new vscode.ThemeColor('charts.purple'));
        }
        return new vscode.ThemeIcon('file');
    }

    private formatDate(date: Date): string {
        const now = new Date();
        const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
        
        if (diffDays === 0) return 'Today';
        if (diffDays === 1) return 'Yesterday';
        if (diffDays < 7) return `${diffDays} days ago`;
        if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
        return date.toLocaleDateString();
    }
}
