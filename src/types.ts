/**
 * Core type definitions for Aware extension
 */

export interface Meeting {
    id: string;
    title: string;
    startTime: Date;
    endTime: Date;
    duration: number; // in minutes
    organizer?: string;
    location?: string;
    isOnline: boolean;
    joinUrl?: string;
    attendees?: string[];
    status: 'upcoming' | 'inProgress' | 'ended';
}

export interface AwareConfig {
    meetingReminderMinutes: number;
    refreshIntervalMinutes: number;
    showStatusBar: boolean;
    enableNotifications: boolean;
    workingHoursStart: string;
    workingHoursEnd: string;
    preferredModel: string;
}

export interface MeetingNotification {
    meetingId: string;
    type: 'reminder' | 'starting' | 'ended';
    sentAt: Date;
}

export interface WorkIQResponse {
    meetings?: Meeting[];
    error?: string;
    rawResponse?: string;
}

/**
 * Connection state for Work IQ integration
 */
export type WorkIQConnectionState = 
    | 'connected'           // Work IQ is available and working
    | 'not_configured'      // MCP server not in settings
    | 'not_started'         // MCP server configured but not running
    | 'license_required'    // M365 Copilot license issue
    | 'admin_consent'       // Organization admin consent needed
    | 'auth_required'       // User needs to authenticate
    | 'eula_required'       // Work IQ EULA not accepted
    | 'unknown_error';      // Other error

export interface WorkIQConnectionStatus {
    state: WorkIQConnectionState;
    message: string;
    actionLabel?: string;
    actionCommand?: string;
    actionArgs?: unknown[];
}

export interface RelatedDocument {
    id: string;
    title: string;
    url?: string;
    lastModified?: Date;
    type: string; // Word, Excel, PowerPoint, PDF, OneNote, Web Page, etc.
}

export type TimeRange = 'today' | 'tomorrow' | 'week';

export interface GetMeetingsInput {
    timeRange?: TimeRange;
}
