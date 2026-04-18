import type { ChangeEvent, FormEvent } from 'react';

import { describeCliInstallStatus, type BridgeStatusPresentation } from '../lib/state';
import type { CliInstallStatus } from '../lib/types';

import CollapsibleSection from './CollapsibleSection';

type SettingsModalProps = {
  settingsOpen: boolean;
  onClose: () => void;
  watchedRoots: string[];
  rootsOpen: boolean;
  onToggleRoots: () => void;
  watchRootInput: string;
  watchRootError: string | null;
  watchRootPending: boolean;
  onWatchRootInputChange: (value: string) => void;
  onAddWatchRoot: () => void;
  onRemoveWatchRoot: (root: string) => void;
  bridgeOpen: boolean;
  onToggleBridge: () => void;
  bridgeEnabled: boolean;
  onBridgeToggle: (enabled: boolean) => void;
  bridgeStatus: BridgeStatusPresentation;
  bridgeUrl: string;
  maskedToken: string;
  setupStale: boolean;
  staleClientNames: string;
  bridgeLastError: string | null;
  onRestartBridge: () => void;
  onRegenerateBridgeToken: () => void;
  onCopyBridgeSnippet: (kind: string) => void;
  cliOpen: boolean;
  onToggleCli: () => void;
  cliStatus: CliInstallStatus | null;
  cliPending: boolean;
  onInstallCli: () => void;
  onCopyCliSetup: () => void;
};

export default function SettingsModal({
  settingsOpen,
  onClose,
  watchedRoots,
  rootsOpen,
  onToggleRoots,
  watchRootInput,
  watchRootError,
  watchRootPending,
  onWatchRootInputChange,
  onAddWatchRoot,
  onRemoveWatchRoot,
  bridgeOpen,
  onToggleBridge,
  bridgeEnabled,
  onBridgeToggle,
  bridgeStatus,
  bridgeUrl,
  maskedToken,
  setupStale,
  staleClientNames,
  bridgeLastError,
  onRestartBridge,
  onRegenerateBridgeToken,
  onCopyBridgeSnippet,
  cliOpen,
  onToggleCli,
  cliStatus,
  cliPending,
  onInstallCli,
  onCopyCliSetup,
}: SettingsModalProps) {
  if (!settingsOpen) {
    return null;
  }

  const cliPresentation = describeCliInstallStatus(cliStatus);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onAddWatchRoot();
  }

  function handleBridgeToggle(event: ChangeEvent<HTMLInputElement>) {
    onBridgeToggle(event.target.checked);
  }

  function handleInputChange(event: ChangeEvent<HTMLInputElement>) {
    onWatchRootInputChange(event.target.value);
  }

  return (
    <div className="settings-modal-layer is-animated" onClick={onClose}>
      <section
        id="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className="panel settings-panel settings-modal is-animated"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="settings-head">
          <div>
            <h3>Settings</h3>
            <p className="muted settings-copy">Roots, bridge, and local agent access.</p>
          </div>
          <button
            type="button"
            className="ghost-button settings-close"
            aria-label="Close settings"
            onClick={onClose}
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>
        <CollapsibleSection
          label="Watch Roots"
          open={rootsOpen}
          onToggle={onToggleRoots}
          className="settings-section"
          count={watchedRoots.length}
        >
          <form className="stack compact-form watch-root-form" onSubmit={handleSubmit}>
            <div className="watch-root-controls">
              <input
                value={watchRootInput}
                onChange={handleInputChange}
                placeholder="/Users/light/Projects"
              />
              <button className="add-root-button" type="submit" disabled={watchRootPending}>
                <span aria-hidden="true">+</span>
                <span>{watchRootPending ? 'Adding…' : 'Add'}</span>
              </button>
            </div>
            {watchRootError ? <div className="inline-error">{watchRootError}</div> : null}
          </form>
          <div className="root-list">
            {watchedRoots.map((root) => (
              <div className="root-row" key={root}>
                <code>{root}</code>
                <button
                  className="ghost-button root-row-action"
                  onClick={() => onRemoveWatchRoot(root)}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        </CollapsibleSection>
        <CollapsibleSection
          label="Agent Bridge"
          open={bridgeOpen}
          onToggle={onToggleBridge}
          className="settings-section"
        >
          <section className="bridge-panel">
            <div className="panel-header">
              <div>
                <h3>Agent Bridge</h3>
                <p className="muted settings-copy">Streamable HTTP for Codex and Claude.</p>
              </div>
              <label className="toggle-row">
                <span>{bridgeEnabled ? 'On' : 'Off'}</span>
                <input type="checkbox" checked={bridgeEnabled} onChange={handleBridgeToggle} />
              </label>
            </div>
            <div className="bridge-meta">
              <div>
                <label>Status</label>
                <strong className={`status status-${bridgeStatus.tone}`}>{bridgeStatus.label}</strong>
                <p className="bridge-status-copy">{bridgeStatus.detail}</p>
              </div>
              <div>
                <label>URL</label>
                <code className="bridge-url">{bridgeUrl}</code>
              </div>
              <div>
                <label>Token</label>
                <code className="bridge-url">{maskedToken}</code>
              </div>
            </div>
            {setupStale ? <div className="bridge-warning">Re-copy setup for: {staleClientNames}</div> : null}
            {bridgeLastError ? <div className="inline-error">{bridgeLastError}</div> : null}
            <div className="bridge-actions">
              <button type="button" onClick={onRestartBridge} disabled={!bridgeEnabled}>
                Restart
              </button>
              <button type="button" onClick={onRegenerateBridgeToken}>
                Regenerate token
              </button>
            </div>
            <div className="bridge-copy-list">
              <button type="button" onClick={() => onCopyBridgeSnippet('codex')}>
                Copy Codex setup
              </button>
              <button type="button" onClick={() => onCopyBridgeSnippet('claudeCode')}>
                Copy Claude Code setup
              </button>
              <button type="button" onClick={() => onCopyBridgeSnippet('claudeDesktop')}>
                Copy Claude Desktop setup
              </button>
            </div>
          </section>
        </CollapsibleSection>
        <CollapsibleSection
          label="CLI"
          open={cliOpen}
          onToggle={onToggleCli}
          className="settings-section"
        >
          <section className="bridge-panel">
            <div className="panel-header">
              <div>
                <h3>projectctl CLI</h3>
                <p className="muted settings-copy">Install a Terminal command that points at the bundled CLI.</p>
              </div>
            </div>
            <div className="bridge-meta">
              <div>
                <label>Status</label>
                <strong className={`status status-${cliPresentation.tone}`}>{cliPresentation.label}</strong>
              </div>
              <div>
                <label>Install path</label>
                <code className="bridge-url">{cliStatus?.installPath ?? 'Checking…'}</code>
              </div>
              <div>
                <label>Bundled binary</label>
                <code className="bridge-url">{cliStatus?.bundledPath ?? 'Checking…'}</code>
              </div>
            </div>
            {cliPresentation.detail ? (
              <div className="bridge-warning">{cliPresentation.detail}</div>
            ) : null}
            {cliStatus && cliPresentation.needsShellSetup ? (
              <div className="root-list cli-setup-list">
                <div className="root-row">
                  <code>{cliStatus.persistCommand}</code>
                </div>
              </div>
            ) : null}
            <div className="bridge-actions">
              <button type="button" onClick={onInstallCli} disabled={cliPending}>
                {cliPending ? 'Installing…' : cliStatus?.installed ? 'Reinstall CLI' : 'Install CLI'}
              </button>
              <button
                type="button"
                onClick={onCopyCliSetup}
                disabled={!cliStatus || !cliPresentation.needsShellSetup}
              >
                Copy shell setup
              </button>
            </div>
          </section>
        </CollapsibleSection>
      </section>
    </div>
  );
}
