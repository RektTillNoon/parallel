import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import SettingsModal from './SettingsModal';
import type { BridgeDoctorReport } from '../lib/types';

describe('SettingsModal', () => {
  function renderSettingsModal(bridgeDoctor: BridgeDoctorReport | null) {
    return renderToStaticMarkup(
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
        bridgeDoctor={bridgeDoctor}
        bridgeDoctorPending={false}
        onRunBridgeDoctor={() => {}}
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
  }

  it('renders agent access as a quiet zen list with tucked technical detail', () => {
    const html = renderSettingsModal({
      status: 'action_needed',
      label: 'Action needed',
      summary: 'Finish the setup checklist before relying on agent updates.',
      checks: [
        {
          id: 'watched-roots',
          label: 'Watched roots',
          status: 'ready',
          detail: '1 watched root configured.',
        },
        {
          id: 'mcp-tools',
          label: 'MCP tool call',
          status: 'action',
          detail: 'Run after the bridge is enabled and healthy.',
        },
      ],
      nextSteps: ['Enable the Agent Bridge.', 'Install projectctl.'],
    });

    expect(html).toContain('Bridge');
    expect(html).toContain('Agent Defaults');
    expect(html).toContain('Bridge Doctor');
    expect(html).toContain('Setup checklist');
    expect(html).toContain('Run Doctor');
    expect(html).toContain('Enable the Agent Bridge.');
    expect(html).toContain('MCP tool call');
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

  it('does not show ready setup copy before Doctor has passed', () => {
    const uncheckedHtml = renderSettingsModal(null);
    const blockedHtml = renderSettingsModal({
      status: 'error',
      label: 'Blocked',
      summary: 'Fix the failing bridge or agent setup check.',
      checks: [
        {
          id: 'mcp-tools',
          label: 'MCP tool call',
          status: 'error',
          detail: 'Bridge responded, but record_execution is missing.',
        },
      ],
      nextSteps: [],
    });

    expect(uncheckedHtml).toContain('Run Doctor to check setup.');
    expect(blockedHtml).toContain('Resolve the blocked Doctor check.');
    expect(uncheckedHtml).not.toContain('Ready for agent use.');
    expect(blockedHtml).not.toContain('Ready for agent use.');
  });
});
