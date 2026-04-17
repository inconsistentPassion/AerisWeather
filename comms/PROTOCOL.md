# Agent Communication Protocol (ACP v1)

## Overview
File-based real-time IPC between AI agents working on the same repo.
Messages are JSON files in `comms/` — simple, git-traceable, conflict-free.

## Directory Structure
```
comms/
├── PROTOCOL.md       ← This file
├── state.json        ← Shared state (who's working on what)
├── inbox/
│   └── {timestamp}-{sender}-{type}.json  ← Messages
├── locks/
│   └── {resource}.lock                    ← File-based mutex
└── archive/
    └── Processed messages move here
```

## Message Format
```json
{
  "id": "msg-1713400000-agent1",
  "from": "agent1",
  "to": "agent2",
  "type": "task_claim|task_done|question|answer|coordination|heartbeat",
  "timestamp": 1713400000,
  "subject": "Short description",
  "body": "Details, questions, answers",
  "refs": ["file1.ts", "file2.ts"],
  "priority": "low|normal|high|urgent"
}
```

## Message Types

| Type | Purpose |
|------|---------|
| `task_claim` | "I'm starting work on X" — prevents conflicts |
| `task_done` | "I finished X, here's what changed" |
| `question` | "I need info about X" |
| `answer` | "Here's the answer to your question" |
| `coordination` | Strategic discussion, planning |
| `heartbeat` | "I'm alive, here's my status" |

## State File (state.json)
```json
{
  "agents": {
    "agent1": {
      "status": "working|idle|blocked",
      "currentTask": "noise-generation",
      "lastHeartbeat": 1713400000,
      "completedTasks": ["scaffold", "atmosphere"]
    },
    "agent2": {
      "status": "idle",
      "currentTask": null,
      "lastHeartbeat": 0,
      "completedTasks": []
    }
  },
  "locks": {
    "src/clouds/CloudRenderer.ts": { "holder": "agent1", "since": 1713400000 }
  }
}
```

## Lock Protocol
Before editing a file another agent might touch:
1. Create `comms/locks/{filename}.lock` with your agent ID + timestamp
2. Check if lock exists and is held by other agent → wait or negotiate
3. Delete lock when done

## Heartbeat Interval
Every 2 minutes, write a heartbeat message. If no heartbeat for 5 minutes, the agent is considered gone.

## Rules
1. Always read inbox before starting new work
2. Claim tasks before starting them
3. Announce when done, list changed files
4. Don't edit files locked by the other agent
5. If conflict detected, pause and communicate
