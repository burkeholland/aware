/**
 * Document Service - Fetches related documents from Work IQ MCP server
 * 
 * ## Query Strategy
 * Uses structured JSON prompt matching meetingService pattern:
 * "What documents are related to {repoName}? Return as JSON array with fields: title, url, type"
 * 
 * ## Response Format (from Work IQ)
 * Work IQ returns JSON in markdown code fences with footnotes containing real URLs:
 * ```json
 * [{"title": "Doc Name", "url": "[1]", "type": "Word"}]
 * ```
 * [1](https://actual-sharepoint-url.com/...)
 * 
 * ## Parsing
 * 1. Extract JSON from code fences
 * 2. Extract real URLs from footnotes [N](url)
 * 3. Map footnote references to actual URLs
 */

import * as vscode from 'vscode';
import { RelatedDocument } from './types';

const WORKIQ_TOOL_NAME = 'mcp_workiq_ask_work_iq';

export class DocumentService {
    private documents: RelatedDocument[] = [];
    private lastRefresh: Date | null = null;
    private lastError: string | null = null;
    private currentRepoName: string | null = null;
    private outputChannel: vscode.OutputChannel;
    private _onDocumentsUpdated = new vscode.EventEmitter<RelatedDocument[]>();
    readonly onDocumentsUpdated = this._onDocumentsUpdated.event;
    private _onLoadingStarted = new vscode.EventEmitter<void>();
    readonly onLoadingStarted = this._onLoadingStarted.event;

    constructor(outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
    }

    async fetchRelatedDocuments(): Promise<RelatedDocument[]> {
        const repoName = this.getCurrentRepoName();
        this.currentRepoName = repoName;
        
        if (!repoName) {
            this.log('No repository detected in workspace');
            this.documents = [];
            this._onDocumentsUpdated.fire(this.documents);
            return this.documents;
        }

        this.log(`Fetching related documents for: ${repoName}`);
        this._onLoadingStarted.fire();

        try {
            const response = await this.queryWorkIQ(repoName);
            const parsed = this.parseDocumentResponse(response);
            this.log(`Parsed ${parsed.length} documents from response`);
            this.documents = parsed;
            this.lastRefresh = new Date();
            this.lastError = null; // Clear error on success
            this._onDocumentsUpdated.fire(this.documents);
            return this.documents;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.log(`Failed to fetch documents: ${errorMessage}`);
            this.lastError = this.formatErrorMessage(errorMessage);
            this._onDocumentsUpdated.fire(this.documents);
            return this.documents;
        }
    }

    private formatErrorMessage(error: string): string {
        if (error.includes('not available') || error.includes('not found')) {
            return 'Work IQ MCP server is not running. Start it from the MCP Servers panel.';
        }
        if (error.includes('timeout') || error.includes('ETIMEDOUT')) {
            return 'Connection timed out. Check your network or VPN connection.';
        }
        if (error.includes('network') || error.includes('ENOTFOUND') || error.includes('ECONNREFUSED')) {
            return 'Network error. Check your internet or VPN connection.';
        }
        if (error.includes('unauthorized') || error.includes('401') || error.includes('403')) {
            return 'Authentication failed. You may need to sign in again.';
        }
        return 'Failed to connect to Work IQ. Check your network connection.';
    }

    private getCurrentRepoName(): string | null {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return null;
        }
        return workspaceFolders[0].name;
    }

    private async queryWorkIQ(repoName: string): Promise<string> {
        const workiqTool = vscode.lm.tools.find(t => t.name === WORKIQ_TOOL_NAME);
        
        if (!workiqTool) {
            throw new Error('Work IQ MCP server not available. Please start the workiq server from MCP Servers panel.');
        }

        // Structured prompt matching meetingService pattern
        const question = `What documents are related to "${repoName}"? Return as JSON array with fields: title, url, type (e.g., "Word", "Excel", "PowerPoint", "PDF", "SharePoint", "Email", "Teams"). Limit to 15 most relevant.`;
        
        this.log(`Query: ${question}`);
        
        const result = await vscode.lm.invokeTool(
            WORKIQ_TOOL_NAME,
            { 
                input: { question },
                toolInvocationToken: undefined
            },
            new vscode.CancellationTokenSource().token
        );
        
        let fullResponse = '';
        if (result && result.content) {
            for (const part of result.content) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    fullResponse += part.value;
                }
            }
        }
        
        const responseText = this.extractToolResponseText(fullResponse);
        this.log(`Response (${responseText.length} chars):\n${responseText}`);
        return responseText;
    }

    private parseDocumentResponse(response: string): RelatedDocument[] {
        const documents: RelatedDocument[] = [];
        
        // Extract real URLs from footnotes: [1](https://...)
        const realUrls: string[] = [];
        const footnoteMatches = response.matchAll(/\[(\d+)\]\((https?:\/\/[^)]+)\)/g);
        for (const match of footnoteMatches) {
            realUrls[parseInt(match[1], 10) - 1] = match[2];
        }
        this.log(`Found ${realUrls.filter(Boolean).length} URLs in footnotes`);
        
        // Parse JSON from response
        try {
            const parsed = this.extractJsonArray(response);
            
            if (parsed) {
                const documentsFromResponse = parsed as Array<{
                    title: string;
                    url?: string;
                    type?: string;
                }>;
                
                for (let i = 0; i < documentsFromResponse.length; i++) {
                    const item = documentsFromResponse[i];
                    
                    // Use real URL from footnotes, falling back to JSON field
                    const url = this.resolveDocumentUrl(item.url, realUrls, i);
                    
                    documents.push({
                        id: `doc-${i}-${Date.now()}`,
                        title: item.title,
                        url,
                        type: item.type || this.inferDocumentType(url)
                    });
                    
                    if (url) {
                        this.log(`  [${i + 1}] "${item.title}" (${item.type || 'inferred'}) - ${url.substring(0, 60)}...`);
                    } else {
                        this.log(`  [${i + 1}] "${item.title}" (${item.type || 'inferred'}) - no URL available`);
                    }
                }
            } else {
                this.log('No JSON array found in response');
            }
        } catch (e) {
            this.log(`JSON parse error: ${e}`);
        }
        
        return documents;
    }

    private extractJsonArray(response: string): unknown[] | null {
        const codeFenceMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/i);
        const jsonContent = codeFenceMatch ? codeFenceMatch[1].trim() : response;
        let start = jsonContent.indexOf('[');

        while (start !== -1) {
            const candidate = this.extractBalancedArray(jsonContent, start);
            if (candidate) {
                try {
                    const parsed = JSON.parse(candidate);
                    if (Array.isArray(parsed)) {
                        return parsed;
                    }
                } catch {
                    // Try the next array candidate.
                }
            }

            start = jsonContent.indexOf('[', start + 1);
        }

        return null;
    }

    private extractBalancedArray(text: string, startIndex: number): string | null {
        let depth = 0;
        let inString = false;
        let escaped = false;

        for (let i = startIndex; i < text.length; i++) {
            const ch = text[i];

            if (escaped) {
                escaped = false;
                continue;
            }

            if (ch === '\\' && inString) {
                escaped = true;
                continue;
            }

            if (ch === '"') {
                inString = !inString;
                continue;
            }

            if (inString) {
                continue;
            }

            if (ch === '[') {
                depth++;
            } else if (ch === ']') {
                depth--;
                if (depth === 0) {
                    return text.slice(startIndex, i + 1);
                }
            }
        }

        return null;
    }

    private resolveDocumentUrl(rawUrl: string | undefined, realUrls: string[], index: number): string | undefined {
        if (typeof rawUrl === 'string') {
            const footnoteMatch = rawUrl.match(/^\[(\d+)\]$/);
            if (footnoteMatch) {
                const footnoteUrl = realUrls[parseInt(footnoteMatch[1], 10) - 1];
                if (footnoteUrl) {
                    return footnoteUrl;
                }
            }

            if (rawUrl.startsWith('http')) {
                return rawUrl;
            }
        }

        return realUrls[index] || undefined;
    }

    private extractToolResponseText(fullResponse: string): string {
        try {
            const parsed = JSON.parse(fullResponse) as { response?: string | null; error?: string };
            if (typeof parsed.response === 'string') {
                return parsed.response;
            }
            if (parsed.error) {
                return String(parsed.error);
            }
        } catch {
            // The tool may already be returning plain text.
        }

        return fullResponse;
    }

    private inferDocumentType(url?: string): string {
        if (!url) return 'Document';
        const urlLower = url.toLowerCase();
        if (urlLower.includes('.docx') || urlLower.includes('/word/')) return 'Word';
        if (urlLower.includes('.xlsx') || urlLower.includes('/excel/')) return 'Excel';
        if (urlLower.includes('.pptx') || urlLower.includes('/powerpoint/')) return 'PowerPoint';
        if (urlLower.includes('.pdf')) return 'PDF';
        if (urlLower.includes('onenote')) return 'OneNote';
        if (urlLower.includes('teams.microsoft.com')) return 'Teams';
        if (urlLower.includes('sharepoint.com')) return 'SharePoint';
        if (urlLower.includes('onedrive')) return 'OneDrive';
        if (urlLower.includes('github.com')) return 'GitHub';
        return 'Document';
    }

    getCachedDocuments(): RelatedDocument[] {
        return this.documents;
    }

    getCurrentRepoNameCached(): string | null {
        return this.currentRepoName;
    }

    getLastRefresh(): Date | null {
        return this.lastRefresh;
    }

    getLastError(): string | null {
        return this.lastError;
    }

    private log(message: string): void {
        this.outputChannel.appendLine(`[${new Date().toISOString()}] [DocumentService] ${message}`);
    }

    dispose(): void {
        this._onDocumentsUpdated.dispose();
        this._onLoadingStarted.dispose();
    }
}
