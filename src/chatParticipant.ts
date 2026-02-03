/**
 * Chat participant for Aware extension
 * Allows users to interact with the assistant via @aware in chat
 */

import * as vscode from 'vscode';
import { MeetingService } from './meetingService';
import { ModelSelector } from './modelSelector';
import { onConfigChange } from './config';

export class AwareChatParticipant {
    private participant: vscode.ChatParticipant;
    private meetingService: MeetingService;
    private modelSelector: ModelSelector;
    private model: vscode.LanguageModelChat | undefined;

    constructor(
        context: vscode.ExtensionContext,
        meetingService: MeetingService,
        modelSelector: ModelSelector
    ) {
        this.meetingService = meetingService;
        this.modelSelector = modelSelector;

        this.participant = vscode.chat.createChatParticipant(
            'aware.assistant',
            this.handleRequest.bind(this)
        );

        this.participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'icon.png');
        
        this.participant.followupProvider = {
            provideFollowups: this.provideFollowups.bind(this)
        };

        context.subscriptions.push(this.participant);

        // Initialize model selection
        this.selectModel();
        
        // Re-select model when available models change
        context.subscriptions.push(
            vscode.lm.onDidChangeChatModels(() => this.selectModel())
        );

        // Re-select model when configuration changes
        context.subscriptions.push(
            onConfigChange(() => this.selectModel())
        );
    }

    private async selectModel(): Promise<void> {
        try {
            const model = await this.modelSelector.getConfiguredModel();
            if (model) {
                this.model = model;
            }
        } catch (error) {
            console.error('[Aware] Error selecting model:', error);
        }
    }

    private getModel(request: vscode.ChatRequest): vscode.LanguageModelChat {
        // Use explicitly selected model, or fall back to request's model
        return this.model ?? request.model;
    }

    private async handleRequest(
        request: vscode.ChatRequest,
        context: vscode.ChatContext,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken
    ): Promise<vscode.ChatResult> {
        const command = request.command;

        try {
            switch (command) {
                case 'meetings':
                    return await this.handleMeetingsCommand(request, stream, token);
                case 'next':
                    return await this.handleNextCommand(stream);
                default:
                    return await this.handleGeneralQuery(request, context, stream, token);
            }
        } catch (error) {
            stream.markdown(`⚠️ An error occurred: ${error}`);
            return { errorDetails: { message: String(error) } };
        }
    }

    private async handleMeetingsCommand(
        request: vscode.ChatRequest,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken
    ): Promise<vscode.ChatResult> {
        stream.progress('Fetching your meetings...');

        // Determine time range from prompt and use cached data (no additional API calls)
        let timeRange: 'today' | 'tomorrow' | 'week' = 'today';
        const prompt = request.prompt.toLowerCase();
        if (prompt.includes('tomorrow')) {
            timeRange = 'tomorrow';
        } else if (prompt.includes('week')) {
            timeRange = 'week';
        }

        // Use cached data based on time range
        let meetings;
        switch (timeRange) {
            case 'tomorrow':
                meetings = this.meetingService.getCachedTomorrowMeetings();
                break;
            case 'week':
                meetings = this.meetingService.getCachedWeekMeetings();
                break;
            default:
                meetings = this.meetingService.getCachedMeetings();
        }

        if (meetings.length === 0) {
            stream.markdown(`📅 You have no meetings ${timeRange}.`);
        } else {
            stream.markdown(`## Your Meetings for ${timeRange.charAt(0).toUpperCase() + timeRange.slice(1)}\n\n`);
            
            for (const meeting of meetings) {
                const startTime = this.formatTime(meeting.startTime);
                const endTime = this.formatTime(meeting.endTime);
                const statusIcon = meeting.status === 'inProgress' ? '🔴' : 
                                   meeting.status === 'upcoming' ? '📅' : '✅';
                
                stream.markdown(`${statusIcon} **${meeting.title}**\n`);
                stream.markdown(`   ${startTime} - ${endTime} (${meeting.duration} min)\n\n`);
            }

            const nextMeeting = this.meetingService.getNextMeeting();
            if (nextMeeting) {
                const minutesUntil = this.meetingService.getMinutesUntilNextMeeting();
                stream.markdown(`\n⏰ Next meeting "${nextMeeting.title}" in ${minutesUntil} minutes.\n`);
            }
        }

        return { metadata: { command: 'meetings' } };
    }

    private async handleNextCommand(
        stream: vscode.ChatResponseStream
    ): Promise<vscode.ChatResult> {
        const nextMeeting = this.meetingService.getNextMeeting();

        if (!nextMeeting) {
            stream.markdown(`✨ You have no upcoming meetings. Enjoy your free time!\n`);
        } else {
            const minutesUntil = this.meetingService.getMinutesUntilNextMeeting()!;
            const startTime = this.formatTime(nextMeeting.startTime);
            const endTime = this.formatTime(nextMeeting.endTime);

            stream.markdown(`## Your Next Meeting\n\n`);
            stream.markdown(`**${nextMeeting.title}**\n\n`);
            stream.markdown(`- Starts: ${startTime} (in ${this.formatDuration(minutesUntil)})\n`);
            stream.markdown(`- Ends: ${endTime}\n`);
            stream.markdown(`- Duration: ${nextMeeting.duration} minutes\n`);
            
            if (nextMeeting.organizer) {
                stream.markdown(`- Organizer: ${nextMeeting.organizer}\n`);
            }

            if (nextMeeting.joinUrl) {
                stream.markdown(`\n`);
                stream.button({
                    command: 'aware.joinMeeting',
                    arguments: [nextMeeting],
                    title: 'Join Meeting'
                });
            }
        }

        return { metadata: { command: 'next' } };
    }

    private async handleGeneralQuery(
        request: vscode.ChatRequest,
        context: vscode.ChatContext,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken
    ): Promise<vscode.ChatResult> {
        const model = this.getModel(request);
        const prompt = request.prompt.toLowerCase();

        // Use the LLM to classify the user's intent
        const classificationPrompt = `You are a meetings assistant. Classify the user's intent into one of these categories:
- "meetings" - user wants to see their meetings or calendar
- "next" - user wants to know about their next meeting
- "help" - user needs help or the intent is unclear

User message: "${request.prompt}"

Respond with ONLY the category name, nothing else.`;

        try {
            const messages = [vscode.LanguageModelChatMessage.User(classificationPrompt)];
            const response = await model.sendRequest(messages, {}, token);
            
            let intent = '';
            for await (const chunk of response.text) {
                intent += chunk;
            }
            intent = intent.trim().toLowerCase();

            // Route based on LLM classification
            if (intent === 'meetings') {
                return this.handleMeetingsCommand(request, stream, token);
            } else if (intent === 'next') {
                return this.handleNextCommand(stream);
            }
        } catch (error) {
            // Fallback to simple keyword matching
            if (prompt.includes('meeting') || prompt.includes('calendar')) {
                return this.handleMeetingsCommand(request, stream, token);
            } else if (prompt.includes('next') || prompt.includes('upcoming')) {
                return this.handleNextCommand(stream);
            }
        }

        // Default response with available commands
        stream.markdown(`## Aware Assistant\n\n`);
        stream.markdown(`I can help you stay aware of your meetings. Here's what I can do:\n\n`);
        stream.markdown(`- **/meetings** - Show your upcoming meetings\n`);
        stream.markdown(`- **/next** - See when your next meeting is\n\n`);
        stream.markdown(`You can also ask me questions like:\n`);
        stream.markdown(`- "What meetings do I have today?"\n`);
        stream.markdown(`- "When is my next meeting?"\n`);

        return { metadata: { command: 'help' } };
    }

    private provideFollowups(
        result: vscode.ChatResult,
        context: vscode.ChatContext,
        token: vscode.CancellationToken
    ): vscode.ChatFollowup[] {
        const command = (result.metadata as { command?: string })?.command;

        switch (command) {
            case 'meetings':
                return [
                    { prompt: 'When is my next meeting?', label: '⏰ Next Meeting' }
                ];
            case 'next':
                return [
                    { prompt: 'Show all my meetings', label: '📅 All Meetings' }
                ];
            default:
                return [
                    { prompt: 'Show my meetings for today', label: '📅 Today\'s Meetings' },
                    { prompt: 'When is my next meeting?', label: '⏰ Next Meeting' }
                ];
        }
    }

    private formatTime(date: Date): string {
        return date.toLocaleTimeString('en-US', {
            hour: 'numeric',
            minute: '2-digit',
            hour12: true
        });
    }

    private formatDuration(minutes: number): string {
        if (minutes < 60) {
            return `${minutes} minutes`;
        }
        const hours = Math.floor(minutes / 60);
        const mins = minutes % 60;
        return mins > 0 ? `${hours}h ${mins}m` : `${hours} hour${hours > 1 ? 's' : ''}`;
    }

    dispose(): void {
        this.participant.dispose();
    }
}
