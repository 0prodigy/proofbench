# OSS core is a single static Go binary

The Apache-2.0 core ships as one static Go binary (`pb`) with zero runtime dependencies, because the places verification actually runs — arbitrary customer repos, CI images, agent sandboxes — are exactly the places where nothing else can be installed (crabbox precedent, PLAN §6). Capabilities that need daemons, SDKs, or other runtimes (docker/compose, embedded agent engines, browsers/Playwright, Peekaboo) are external processes the binary shells out to, or adapters living outside the core — the binary never links them in.

## Consequences

A capability absent at runtime degrades to an honest `not-run` in the evidence bundle — never a hidden install step, never default-green. The MCP server stays embedded in the same binary (`pb mcp`); the agent runtime does not (ADR-0009).
