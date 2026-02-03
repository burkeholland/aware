/**
 * Aware Extension
 * 
 * An AI-powered awareness manager that integrates with Microsoft 365
 * via the Work IQ MCP server. It tracks your meetings and sends reminders.
 */

import * as vscode from 'vscode';
import { MeetingService } from './meetingService';
import { NotificationManager } from './notificationManager';
import { StatusBarManager } from './statusBar';
import { DocumentsTreeDataProvider } from './treeViews';
import { MeetingsWebviewProvider } from './meetingsWebviewProvider';
import { DocumentService } from './documentService';
import { AwareChatParticipant } from './chatParticipant';
import { ModelSelector } from './modelSelector';
import { registerTools } from './tools';
import { getConfig, onConfigChange } from './config';
import { Meeting } from './types';

let outputChannel: vscode.OutputChannel;
let meetingService: MeetingService;
let documentService: DocumentService;
let notificationManager: NotificationManager;
let statusBarManager: StatusBarManager;
let modelSelector: ModelSelector;
let meetingsWebviewProvider: MeetingsWebviewProvider;
let refreshInterval: NodeJS.Timeout | null = null;

export function activate(context: vscode.ExtensionContext) {
    // Create output channel for logging
    outputChannel = vscode.window.createOutputChannel('Aware');
    context.subscriptions.push(outputChannel);
    log('Aware extension activating...');

    // Initialize services
    meetingService = new MeetingService(outputChannel);
    documentService = new DocumentService(outputChannel);
    notificationManager = new NotificationManager(outputChannel, meetingService);
    statusBarManager = new StatusBarManager(meetingService);
    modelSelector = new ModelSelector(outputChannel);

    // Register webview provider for meetings
    meetingsWebviewProvider = new MeetingsWebviewProvider(context.extensionUri, meetingService);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            MeetingsWebviewProvider.viewType,
            meetingsWebviewProvider
        )
    );

    // Register tree view for documents
    const documentsTreeProvider = new DocumentsTreeDataProvider(documentService);
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('aware.relatedDocuments', documentsTreeProvider)
    );

    // Register chat participant
    new AwareChatParticipant(context, meetingService, modelSelector);

    // Register language model tools
    registerTools(context, meetingService);

    // Check if Work IQ MCP server is available and offer to install if not
    checkAndOfferWorkIQInstall();

    // Register commands
    registerCommands(
        context, 
        documentsTreeProvider,
        modelSelector
    );

    // Start services
    statusBarManager.start();
    notificationManager.start();

    // Initial fetch of all data
    refreshMeetings();
    refreshDocuments();

    // Set up periodic refresh
    setupRefreshInterval();

    // Listen for configuration changes
    context.subscriptions.push(
        onConfigChange(() => {
            log('Configuration changed, updating services...');
            statusBarManager.stop();
            statusBarManager.start();
            setupRefreshInterval();
        })
    );

    // Add disposables
    context.subscriptions.push(
        meetingService,
        documentService,
        notificationManager,
        statusBarManager,
        new vscode.Disposable(() => {
            if (refreshInterval) {
                clearInterval(refreshInterval);
            }
        })
    );

    log('Aware extension activated successfully');
    // Activation message is now shown only if Work IQ connects successfully
    // The tree view will show status/instructions if there are issues
}

function registerCommands(
    context: vscode.ExtensionContext,
    documentsTreeProvider: DocumentsTreeDataProvider,
    modelSelector: ModelSelector
): void {
    // Show meetings command
    context.subscriptions.push(
        vscode.commands.registerCommand('aware.showMeetings', async () => {
            const meetings = meetingService.getCachedMeetings();
            
            if (meetings.length === 0) {
                vscode.window.showInformationMessage('No upcoming meetings.');
                return;
            }

            const items: vscode.QuickPickItem[] = meetings.map(m => ({
                label: m.title,
                description: `${formatTime(m.startTime)} - ${formatTime(m.endTime)}`,
                detail: m.status === 'inProgress' ? '🔴 In Progress' : 
                        m.status === 'upcoming' ? `⏰ In ${getMinutesUntil(m.startTime)} min` : '✅ Ended'
            }));

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Your upcoming meetings',
                title: 'Aware - Meetings'
            });

            if (selected) {
                const meeting = meetings.find(m => m.title === selected.label);
                if (meeting?.joinUrl) {
                    const action = await vscode.window.showInformationMessage(
                        `${meeting.title}`,
                        'Join Meeting',
                        'Dismiss'
                    );
                    if (action === 'Join Meeting') {
                        vscode.env.openExternal(vscode.Uri.parse(meeting.joinUrl));
                    }
                }
            }
        })
    );

    // Refresh meetings command
    context.subscriptions.push(
        vscode.commands.registerCommand('aware.refreshMeetings', async () => {
            await refreshMeetings();
            meetingsWebviewProvider.refresh();
        })
    );

    // Refresh documents command
    context.subscriptions.push(
        vscode.commands.registerCommand('aware.refreshDocuments', async () => {
            await refreshDocuments();
            documentsTreeProvider.refresh();
        })
    );

    // Join meeting command
    context.subscriptions.push(
        vscode.commands.registerCommand('aware.joinMeeting', async (arg?: Meeting | { meeting?: Meeting }) => {
            // Handle both Meeting objects and MeetingTreeItem objects
            let meeting: Meeting | undefined;
            if (arg && 'meeting' in arg && arg.meeting) {
                meeting = arg.meeting;
            } else if (arg && 'joinUrl' in arg) {
                meeting = arg as Meeting;
            }
            
            if (!meeting) {
                const next = meetingService.getNextMeeting();
                if (next?.joinUrl) {
                    meeting = next;
                }
            }

            if (meeting?.joinUrl) {
                vscode.env.openExternal(vscode.Uri.parse(meeting.joinUrl));
            } else {
                vscode.window.showWarningMessage('No meeting link available');
            }
        })
    );

    // Open settings command
    context.subscriptions.push(
        vscode.commands.registerCommand('aware.openSettings', () => {
            vscode.commands.executeCommand('workbench.action.openSettings', 'aware');
        })
    );

    // Select model command
    context.subscriptions.push(
        vscode.commands.registerCommand('aware.selectModel', async () => {
            await modelSelector.showModelPicker();
        })
    );

    // Configure Work IQ command
    context.subscriptions.push(
        vscode.commands.registerCommand('aware.configureWorkIQ', async () => {
            log('Configure Work IQ command triggered');
            await addWorkIQToSettings();
        })
    );

    // Start Work IQ server command - opens MCP panel for user to start server
    context.subscriptions.push(
        vscode.commands.registerCommand('aware.startWorkIQ', async () => {
            log('Opening MCP servers panel...');
            await vscode.commands.executeCommand('workbench.mcp.listServer');
        })
    );

    // Copy EULA command to clipboard
    context.subscriptions.push(
        vscode.commands.registerCommand('aware.copyEulaCommand', async () => {
            const command = 'npx @microsoft/workiq accept-eula';
            await vscode.env.clipboard.writeText(command);
            vscode.window.showInformationMessage(
                `Copied to clipboard: ${command}`,
                'Open Terminal'
            ).then(action => {
                if (action === 'Open Terminal') {
                    vscode.commands.executeCommand('workbench.action.terminal.new');
                }
            });
        })
    );

    // DEBUG: Test document query command
    context.subscriptions.push(
        vscode.commands.registerCommand('aware.testDocumentQuery', async () => {
            const repoName = 'copilot-sdk';
            const question = `What documents are related to "${repoName}"? Return as JSON array with fields: title, url, type (e.g., "Word", "Excel", "PowerPoint", "PDF", "SharePoint", "Email", "Teams"). Limit to 15 most relevant.`;
            
            outputChannel.appendLine(`\n=== TEST QUERY ===`);
            outputChannel.appendLine(`Query: ${question}`);
            outputChannel.show();
            
            try {
                const result = await vscode.lm.invokeTool(
                    'mcp_workiq_ask_work_iq',
                    { input: { question }, toolInvocationToken: undefined },
                    new vscode.CancellationTokenSource().token
                );
                
                let response = '';
                for (const part of result.content) {
                    if (part instanceof vscode.LanguageModelTextPart) {
                        response += part.value;
                    }
                }
                
                outputChannel.appendLine(`\n=== RESPONSE ===`);
                outputChannel.appendLine(response);
                outputChannel.appendLine(`\n=== END ===`);
            } catch (e) {
                outputChannel.appendLine(`Error: ${e}`);
            }
        })
    );
}

async function refreshMeetings(): Promise<void> {
    log('Refreshing meetings...');
    try {
        // Fetch all meetings in a single query and split into today/tomorrow/week
        const result = await meetingService.fetchAllMeetings();
        log(`Loaded meetings: ${result.today.length} today, ${result.tomorrow.length} tomorrow, ${result.week.length} this week`);
    } catch (error) {
        log(`Failed to refresh meetings: ${error}`);
    }
}

async function refreshDocuments(): Promise<void> {
    // Skip if no workspace folder is open
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        log('No workspace folder open, skipping document refresh');
        return;
    }
    
    log('Refreshing related documents...');
    try {
        await documentService.fetchRelatedDocuments();
        log(`Loaded ${documentService.getCachedDocuments().length} documents`);
    } catch (error) {
        log(`Failed to refresh documents: ${error}`);
    }
}

function setupRefreshInterval(): void {
    if (refreshInterval) {
        clearInterval(refreshInterval);
    }

    const config = getConfig();
    const intervalMs = config.refreshIntervalMinutes * 60 * 1000;

    refreshInterval = setInterval(() => {
        refreshMeetings();
    }, intervalMs);

    log(`Meeting refresh interval set to ${config.refreshIntervalMinutes} minutes`);
}

function formatTime(date: Date): string {
    return date.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
    });
}

function getMinutesUntil(date: Date): number {
    return Math.round((date.getTime() - Date.now()) / (1000 * 60));
}

/**
 * Checks if Work IQ MCP server is available and offers to install it if not.
 * Adds the server configuration to user settings when user accepts.
 */
async function checkAndOfferWorkIQInstall(): Promise<void> {
    // Check if Work IQ tool is already available
    const workIQAvailable = vscode.lm.tools.some(tool => {
        const name = tool.name.toLowerCase();
        return name.includes('workiq') || name.includes('work_iq');
    });
    
    if (workIQAvailable) {
        log('Work IQ MCP server is available');
        return;
    }
    
    log('Work IQ MCP server not found, checking user settings...');
    
    // Check if already configured in user settings
    const config = vscode.workspace.getConfiguration('mcp');
    const servers = config.get<Record<string, unknown>>('servers', {});
    
    if (servers['workiq']) {
        log('Work IQ already configured in user settings (may need to be started)');
        return;
    }
    
    // Prompt user to install
    const choice = await vscode.window.showInformationMessage(
        'Aware requires the Work IQ MCP server to access your Microsoft 365 calendar. Would you like to add it to your settings?',
        'Yes, add Work IQ',
        'No thanks'
    );
    
    if (choice === 'Yes, add Work IQ') {
        await addWorkIQToSettings();
    }
}

/**
 * Adds the Work IQ MCP server configuration to user settings.
 */
async function addWorkIQToSettings(): Promise<void> {
    log('addWorkIQToSettings called');
    try {
        const config = vscode.workspace.getConfiguration('mcp');
        const servers = config.get<Record<string, unknown>>('servers', {});
        log(`Current mcp.servers: ${JSON.stringify(servers)}`);
        
        // Add Work IQ server configuration
        const updatedServers = {
            ...servers,
            'workiq': {
                'command': 'npx',
                'args': ['-y', '@microsoft/workiq', 'mcp'],
                'env': {
                    'npm_config_registry': 'https://registry.npmjs.org'
                }
            }
        };
        
        log('Updating mcp.servers configuration...');
        await config.update('servers', updatedServers, vscode.ConfigurationTarget.Global);
        
        log('Work IQ MCP server added to user settings');
        
        // Server starts automatically after config update - wait a moment then refresh
        vscode.window.showInformationMessage('Work IQ MCP server added! Starting server...');
        
        // Give the server time to start, then refresh the UI
        setTimeout(async () => {
            log('Refreshing after WorkIQ setup...');
            await refreshMeetings();
        }, 3000);
    } catch (error) {
        log(`Failed to add Work IQ to settings: ${error}`);
        vscode.window.showErrorMessage(`Failed to configure Work IQ: ${error}`);
    }
}

function log(message: string): void {
    const timestamp = new Date().toISOString();
    outputChannel.appendLine(`[${timestamp}] ${message}`);
}

export function deactivate() {
    log('Aware extension deactivating...');
}
