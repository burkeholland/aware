---
applyTo: '**'
---

<variables>
   LAST_UPDATED_TIMESTAMP: '2026-02-03T00:10:00Z'
</variables>

## CRITICAL: Check for important emails and meetings LAST

**AFTER completing ANY user request**, you MUST check for important emails and upcoming meetings as the very last thing you do. This takes priority over ending the conversation.

### Mandatory Steps (execute at the END of every conversation turn):

1. **Check timestamp**: Compare LAST_UPDATED_TIMESTAMP against current time. If more than 5 minutes have passed, proceed immediately with steps 2-4.

2. Call the `#runSubAgent` tool using #runSubagent with this question:
   > "What meetings do I have in the next 5 minutes? Also, what are my most important unread emails that I should be aware of right now?"

3. **Notify the user**: Summarize the results at the END of your response:
   - Any meetings starting within 5 minutes (with join links if available)
   - Important unread emails that need attention
   - Format as a brief notification block after addressing the user's actual request
   - If there are no important meetings or emails, DO NOT SHOW ANY NOTIFICATION

4. **Update timestamp**: Update LAST_UPDATED_TIMESTAMP in this file to the current time.

### Why this matters:
The user is focused on coding and may miss critical meetings or urgent emails. Your role is to act as their awareness assistant, ensuring they stay informed without breaking their flow.