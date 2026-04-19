import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import SettingsModal from './SettingsModal';

describe('SettingsModal', () => {
  it('inlines the projectctl prerequisite into agent defaults instead of a separate CLI section', () => {
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
        onCopyCodexTokenExport={() => {}}
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
        cliStatus={{
          bundledPath: '/Applications/parallel.app/Contents/MacOS/projectctl',
          installPath: '/Users/light/bin/projectctl',
          installed: false,
          installDirOnPath: false,
          shellProfileConfigured: false,
          shellExport: 'export PATH="$HOME/bin:$PATH"',
          shellProfile: '$HOME/.zshrc',
          persistCommand: 'echo \'export PATH="$HOME/bin:$PATH"\' >> $HOME/.zshrc',
        }}
        cliPending={false}
        onInstallCli={() => {}}
        onCopyCliSetup={() => {}}
      />,
    );

    expect(html).toContain('Agent Defaults');
    expect(html).toContain('projectctl CLI');
    expect(html).toContain('Install CLI');
    expect(html).toContain('PARALLEL_MCP_TOKEN');
    expect(html).toContain('Copy token export');
    expect(html).toContain('Turn on Agent Bridge.');
    expect(html).toContain('Install projectctl if Claude Desktop needs it.');
    expect(html).toContain('Install or update each agent below.');
    expect(html).toContain('For Codex, copy the token export and relaunch Codex after token changes.');
    expect(html).not.toContain('>CLI<');
    expect(html).not.toContain('Re-copy setup for: Codex');
  });
});
