/**
 * Language model tools for Aware extension
 * These tools can be used by Copilot to help users manage their meetings
 */

import * as vscode from 'vscode';
import { MeetingService } from './meetingService';
import { GetMeetingsInput, TimeRange } from './types';

export function registerTools(
    context: vscode.ExtensionContext,
    meetingService: MeetingService
): void {
    // Register getMeetings tool
    context.subscriptions.push(
        vscode.lm.registerTool(
            'aware_getMeetings',
            new GetMeetingsTool(meetingService)
        )
    );

    // Register getNextMeeting tool
    context.subscriptions.push(
        vscode.lm.registerTool(
            'aware_getNextMeeting',
            new GetNextMeetingTool(meetingService)
        )
    );
}

class GetMeetingsTool implements vscode.LanguageModelTool<GetMeetingsInput> {
    constructor(private meetingService: MeetingService) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetMeetingsInput>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const timeRange: TimeRange = options.input.timeRange || 'today';
        
        // Use cached data based on time range (no additional API calls)
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

        const meetingsList = meetings.map(m => ({
            title: m.title,
            startTime: m.startTime.toISOString(),
            endTime: m.endTime.toISOString(),
            duration: m.duration,
            status: m.status,
            isOnline: m.isOnline,
            hasJoinUrl: !!m.joinUrl
        }));

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify({
                timeRange,
                count: meetings.length,
                meetings: meetingsList
            }, null, 2))
        ]);
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<GetMeetingsInput>,
        token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        return {
            invocationMessage: `Fetching meetings for ${options.input.timeRange || 'today'}...`
        };
    }
}

class GetNextMeetingTool implements vscode.LanguageModelTool<Record<string, never>> {
    constructor(private meetingService: MeetingService) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const currentMeeting = this.meetingService.getCurrentMeeting();
        const nextMeeting = this.meetingService.getNextMeeting();
        const minutesUntil = this.meetingService.getMinutesUntilNextMeeting();

        // Build result with both current and next meeting info
        const result: {
            currentMeeting?: {
                title: string;
                startTime: string;
                endTime: string;
                duration: number;
                isOnline: boolean;
                hasJoinUrl: boolean;
            };
            hasNextMeeting: boolean;
            meeting?: {
                title: string;
                startTime: string;
                endTime: string;
                duration: number;
                isOnline: boolean;
                hasJoinUrl: boolean;
            };
            minutesUntil?: number | null;
            message?: string;
        } = {
            hasNextMeeting: !!nextMeeting
        };

        // Include current meeting if one is in progress
        if (currentMeeting) {
            result.currentMeeting = {
                title: currentMeeting.title,
                startTime: currentMeeting.startTime.toISOString(),
                endTime: currentMeeting.endTime.toISOString(),
                duration: currentMeeting.duration,
                isOnline: currentMeeting.isOnline,
                hasJoinUrl: !!currentMeeting.joinUrl
            };
        }

        if (nextMeeting) {
            result.meeting = {
                title: nextMeeting.title,
                startTime: nextMeeting.startTime.toISOString(),
                endTime: nextMeeting.endTime.toISOString(),
                duration: nextMeeting.duration,
                isOnline: nextMeeting.isOnline,
                hasJoinUrl: !!nextMeeting.joinUrl
            };
            result.minutesUntil = minutesUntil;
        } else if (!currentMeeting) {
            result.message = 'No upcoming meetings';
        }

        return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2))
        ]);
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<Record<string, never>>,
        token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        return {
            invocationMessage: 'Finding your next meeting...'
        };
    }
}
