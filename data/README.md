# Geny Data Directory

This directory is automatically created and used by Docker containers for bind mounts.

## Contents

| Path | Description |
|------|-------------|
| `sessions.json` | Session metadata (created/restored across restarts) |
| `geny_agent_sessions/` | Agent workspace directories (one per session) |
| `logs/` | Backend execution logs |

These files are **bind-mounted** into the Docker containers, so you can browse them directly from your host machine.

> **Note**: This directory is `.gitignore`d except for this README and the empty `sessions.json` seed.
