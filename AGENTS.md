# Repository instructions

- Read `docs/implementation-plan.md` before changing architecture.
- Check `docs/feasibility.md` and ADRs before starting a new phase.
- Keep the media gate open until Windows and Android Tauri playback has evidence.
- Do not add product features ahead of the gate. Do not claim untested features.
- Use PowerShell on the primary Windows development host. Use pnpm for frontend work.
- Use clear, simplified technical English for specifications and instructions.
- Prefer Mermaid for complex flows.
- Run the applicable checks in `docs/development.md`. Update validation results.
- Keep media, SDP, credentials, and local capability reports out of Git.
- Do not add a temporary unauthenticated signaling listener.
