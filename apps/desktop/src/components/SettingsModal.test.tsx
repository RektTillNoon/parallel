import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import SettingsModal from './SettingsModal';

describe('SettingsModal', () => {
  it('renders agent access as a quiet zen list with tucked technical detail', () => {
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

    expect(html).toContain('Bridge');
    expect(html).toContain('Agent Defaults');
    expect(html).toContain('projectctl CLI');
    expect(html).toContain('Reveal paths');
    expect(html).toContain('Utilities');
    expect(html).toContain('Connection details');
    expect(html).toContain('PARALLEL_MCP_TOKEN');
    expect(html).toContain('Copy token export');
    expect(html).toContain('Codex');
    expect(html).toContain('Not installed');
    expect(html).toContain('settings-scroll');
    expect(html).toContain('settings-toggle-control');
    expect(html).toContain('settings-action-details');
    expect(html).toContain('settings-utility-list');
    expect(html).toContain('settings-row-footer-owned');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('calm sheet');
    expect(html.indexOf('Utilities')).toBeLessThan(html.indexOf('Copy Codex setup'));
    expect(html).not.toContain('settings-status-chip');
    expect(html).not.toContain('settings-toggle-chip');
    expect(html).not.toContain('Setup steps');
    expect(html).not.toContain('>CLI<');
    expect(html).not.toContain('Re-copy setup for: Codex');
  });
});
