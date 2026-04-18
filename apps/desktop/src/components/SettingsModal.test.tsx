import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import SettingsModal from './SettingsModal';

describe('SettingsModal', () => {
  it('renders the agent defaults section instead of the old recopy warning', () => {
    const html = renderToStaticMarkup(
      <SettingsModal
        settingsOpen
        onClose={() => {}}
        watchedRoots={['/Users/light/Projects']}
        rootsOpen
        onToggleRoots={() => {}}
        watchRootInput=""
        watchRootError={null}
        watchRootPending={false}
        onWatchRootInputChange={() => {}}
        onAddWatchRoot={() => {}}
        onRemoveWatchRoot={() => {}}
        bridgeOpen
        onToggleBridge={() => {}}
        bridgeEnabled
        onBridgeToggle={() => {}}
        bridgeStatus={{ tone: 'running', label: 'Ready', detail: 'Accepting local MCP requests on localhost.' }}
        bridgeUrl="http://127.0.0.1:4855/mcp"
        maskedToken="abc123••••xyz9"
        bridgeLastError={null}
        onRestartBridge={() => {}}
        onRegenerateBridgeToken={() => {}}
        onCopyBridgeSnippet={() => {}}
        agentDefaultsOpen
        onToggleAgentDefaults={() => {}}
        agentStatuses={[
          {
            kind: 'codex',
            label: 'Codex',
            status: 'missing',
            reasons: [],
            global: null,
            repo: null,
            changedPaths: [],
          },
        ]}
        agentPendingKind={null}
        onApplyAgentDefaults={() => {}}
        cliOpen
        onToggleCli={() => {}}
        cliStatus={null}
        cliPending={false}
        onInstallCli={() => {}}
        onCopyCliSetup={() => {}}
      />,
    );

    expect(html).toContain('Agent Defaults');
    expect(html).not.toContain('Re-copy setup for: Codex');
  });
});
