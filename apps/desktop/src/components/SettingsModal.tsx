import type { ChangeEvent, FormEvent } from 'react';

import {
  describeAgentDefaultsStatus,
  describeCliInstallStatus,
  type BridgeStatusPresentation,
} from '../lib/state';
import type {
  AgentInstallAction,
  AgentTargetStatus,
  BridgeDoctorReport,
  CliInstallStatus,
} from '../lib/types';

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
  bridgeLastError: string | null;
  onRestartBridge: () => void;
  onRegenerateBridgeToken: () => void;
  onCopyBridgeSnippet: (kind: string) => void;
  onCopyCodexTokenExport: () => void;
  bridgeDoctor: BridgeDoctorReport | null;
  bridgeDoctorPending: boolean;
  onRunBridgeDoctor: () => void;
  agentDefaultsOpen: boolean;
  onToggleAgentDefaults: () => void;
  agentStatuses: AgentTargetStatus[] | null;
  agentPendingKind: string | null;
  onApplyAgentDefaults: (kind: string, action: AgentInstallAction) => void;
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
  bridgeLastError,
  onRestartBridge,
  onRegenerateBridgeToken,
  onCopyBridgeSnippet,
  onCopyCodexTokenExport,
  bridgeDoctor,
  bridgeDoctorPending,
  onRunBridgeDoctor,
  agentDefaultsOpen,
  onToggleAgentDefaults,
  agentStatuses,
  agentPendingKind,
  onApplyAgentDefaults,
  cliStatus,
  cliPending,
  onInstallCli,
  onCopyCliSetup,
}: SettingsModalProps) {
  if (!settingsOpen) {
    return null;
  }

  const cliPresentation = describeCliInstallStatus(cliStatus);
  const bridgeDoctorSteps = bridgeDoctor
    ? bridgeDoctor.nextSteps.length > 0
      ? bridgeDoctor.nextSteps
      : bridgeDoctor.status === 'ready'
        ? ['Ready for agent use.']
        : bridgeDoctor.status === 'error'
          ? ['Resolve the blocked Doctor check.']
          : ['Complete the action-needed Doctor checks.']
    : ['Run Doctor to check setup.'];

  function getPrimaryAgentAction(kind: AgentTargetStatus['kind']) {
    const status = agentStatuses?.find((entry) => entry.kind === kind);
    if (!status) {
      return null;
    }
    const presentation = describeAgentDefaultsStatus(status);
    if (presentation.canUpdate) {
      return { kind: 'update' as const, label: agentPendingKind === kind ? 'Updating…' : 'Update' };
    }
    if (presentation.canInstall) {
      return { kind: 'install' as const, label: agentPendingKind === kind ? 'Installing…' : 'Install' };
    }
    return null;
  }

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
            <p className="muted settings-copy">
              Roots, bridge, and local agent access in one calm sheet.
            </p>
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
        <div className="settings-scroll">
        <CollapsibleSection
          label="Watch Roots"
          open={rootsOpen}
          onToggle={onToggleRoots}
          className="settings-section"
          count={watchedRoots.length}
        >
          <div className="settings-quiet-list">
            <div className="settings-quiet-row settings-quiet-row-form">
              <div className="settings-quiet-kicker">Add root</div>
              <div className="settings-quiet-body">
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
              </div>
              <div className="settings-quiet-spacer" aria-hidden="true" />
            </div>
            <div className="root-list settings-root-list">
              {watchedRoots.map((root) => (
                <div className="root-row" key={root}>
                  <div className="settings-quiet-kicker">Watching</div>
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
          </div>
        </CollapsibleSection>
        <CollapsibleSection
          label="Bridge"
          open={bridgeOpen}
          onToggle={onToggleBridge}
          className="settings-section"
        >
          <section className="settings-quiet-list">
            <div className="settings-quiet-row">
              <div className="settings-quiet-kicker">Status</div>
              <div className="settings-quiet-body">
                <div className="settings-quiet-title">
                  <strong>{bridgeStatus.label}</strong>
                </div>
                <p className="settings-quiet-note">{bridgeStatus.detail}</p>
                {bridgeLastError ? <div className="inline-error">{bridgeLastError}</div> : null}
                <div className="settings-row-footer">
                  <div className="settings-row-meta" aria-hidden="true" />
                  <div className="settings-quiet-actions">
                    <label className="settings-toggle-control">
                      <input
                        type="checkbox"
                        checked={bridgeEnabled}
                        onChange={handleBridgeToggle}
                        aria-label="Enable local bridge"
                      />
                      <span>Enabled</span>
                    </label>
                    <button type="button" onClick={onRestartBridge} disabled={!bridgeEnabled}>
                      Restart
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div className="settings-quiet-row">
              <div className="settings-quiet-kicker">Access</div>
              <div className="settings-quiet-body">
                <p className="settings-quiet-note">
                  Managed snippets keep Codex and Claude pointed at the same local bridge.
                </p>
                <div className="settings-row-footer settings-row-footer-owned">
                  <details className="settings-inline-details settings-row-meta">
                    <summary>Connection details</summary>
                    <div className="settings-inline-stack">
                      <div className="settings-inline-field">
                        <span>URL</span>
                        <code>{bridgeUrl}</code>
                      </div>
                      <div className="settings-inline-field">
                        <span>Token</span>
                        <code>{maskedToken}</code>
                      </div>
                    </div>
                  </details>
                  <div className="settings-quiet-actions">
                    <details className="settings-action-details">
                      <summary>
                        <span>Utilities</span>
                        <span aria-hidden="true" className="settings-action-caret">
                          ▾
                        </span>
                      </summary>
                      <div className="settings-utility-list">
                        <button type="button" onClick={() => onCopyBridgeSnippet('codex')}>
                          Copy Codex setup
                        </button>
                        <button type="button" onClick={() => onCopyBridgeSnippet('claudeCode')}>
                          Copy Claude Code setup
                        </button>
                        <button type="button" onClick={() => onCopyBridgeSnippet('claudeDesktop')}>
                          Copy Claude Desktop setup
                        </button>
                        <button type="button" onClick={onRegenerateBridgeToken}>
                          Regenerate token
                        </button>
                      </div>
                    </details>
                  </div>
                </div>
              </div>
            </div>

            <div className="settings-quiet-row">
              <div className="settings-quiet-kicker">Bridge Doctor</div>
              <div className="settings-quiet-body">
                <div className="settings-quiet-title">
                  <strong>{bridgeDoctor?.label ?? 'Not checked'}</strong>
                </div>
                <p className="settings-quiet-note">
                  {bridgeDoctor?.summary ?? 'Run Doctor before relying on agent updates.'}
                </p>
                <div className="settings-doctor-grid">
                  <div>
                    <div className="settings-quiet-kicker">Setup checklist</div>
                    <ul className="settings-doctor-list">
                      {bridgeDoctorSteps.map((step) => (
                        <li key={step}>{step}</li>
                      ))}
                    </ul>
                  </div>
                  {bridgeDoctor?.checks.length ? (
                    <div>
                      <div className="settings-quiet-kicker">Checks</div>
                      <ul className="settings-doctor-list">
                        {bridgeDoctor.checks.map((check) => (
                          <li key={check.id}>
                            <span className={`settings-doctor-status is-${check.status}`}>
                              {check.status}
                            </span>
                            <span>
                              <strong>{check.label}</strong>
                              <span>{check.detail}</span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
                <div className="settings-row-footer">
                  <div className="settings-row-meta" aria-hidden="true" />
                  <div className="settings-quiet-actions">
                    <button type="button" onClick={onRunBridgeDoctor} disabled={bridgeDoctorPending}>
                      {bridgeDoctorPending ? 'Checking…' : 'Run Doctor'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </section>
        </CollapsibleSection>
        <CollapsibleSection
          label="Agent Defaults"
          open={agentDefaultsOpen}
          onToggle={onToggleAgentDefaults}
          className="settings-section"
          count={agentStatuses?.length ?? 0}
        >
          <section className="settings-quiet-list">
            <div className="settings-quiet-row">
              <div className="settings-quiet-kicker">projectctl CLI</div>
              <div className="settings-quiet-body">
                <div className="settings-quiet-title">
                  <strong>{cliPresentation.label}</strong>
                </div>
                <p className="settings-quiet-note">
                  {cliPresentation.detail ??
                    'Claude Desktop needs projectctl on a stable path. The install path stays tucked until you need it.'}
                </p>
                <div className="settings-row-footer">
                  <details className="settings-inline-details settings-row-meta">
                    <summary>Reveal paths</summary>
                    <div className="settings-inline-stack">
                      <div className="settings-inline-field">
                        <span>Install path</span>
                        <code>{cliStatus?.installPath ?? 'Checking…'}</code>
                      </div>
                      <div className="settings-inline-field">
                        <span>Bundled binary</span>
                        <code>{cliStatus?.bundledPath ?? 'Checking…'}</code>
                      </div>
                      {cliStatus && cliPresentation.needsShellSetup ? (
                        <div className="settings-inline-field">
                          <span>Shell command</span>
                          <code>{cliStatus.persistCommand}</code>
                        </div>
                      ) : null}
                    </div>
                  </details>
                  <div className="settings-quiet-actions">
                    <button type="button" onClick={onInstallCli} disabled={cliPending}>
                      {cliPending ? 'Installing…' : cliStatus?.installed ? 'Reinstall CLI' : 'Install CLI'}
                    </button>
                    {cliPresentation.needsShellSetup ? (
                      <button type="button" onClick={onCopyCliSetup} disabled={!cliStatus}>
                        Copy shell setup
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>

            {(agentStatuses ?? []).map((status) => {
              const presentation = describeAgentDefaultsStatus(status);
              const pending = agentPendingKind === status.kind;
              const isCodex = status.kind === 'codex';
              const primaryAction = getPrimaryAgentAction(status.kind);

              return (
                <div className="settings-quiet-row" key={status.kind}>
                <div className="settings-quiet-kicker">{status.label}</div>
                <div className="settings-quiet-body">
                  <div className="settings-quiet-title">
                    <strong>{presentation.label}</strong>
                  </div>
                    {presentation.detail ? (
                      <p className="settings-quiet-note">{presentation.detail}</p>
                    ) : (
                      <p className="settings-quiet-note">
                        Managed defaults keep this agent aligned without a louder setup block.
                      </p>
                    )}
                    {isCodex ? (
                      <p className="settings-quiet-note">
                        Codex also needs <code>PARALLEL_MCP_TOKEN</code> in the environment that
                        launches it.
                      </p>
                    ) : null}
                    <div className="settings-row-footer">
                      <div className="settings-row-meta" aria-hidden="true" />
                      <div className="settings-quiet-actions">
                        {primaryAction ? (
                          <button
                            type="button"
                            onClick={() =>
                              onApplyAgentDefaults(status.kind, primaryAction.kind as AgentInstallAction)
                            }
                            disabled={pending}
                          >
                            {primaryAction.label}
                          </button>
                        ) : null}
                        <details className="settings-action-details">
                          <summary>
                            <span>Utilities</span>
                            <span aria-hidden="true" className="settings-action-caret">
                              ▾
                            </span>
                          </summary>
                          <div className="settings-utility-list">
                            {presentation.canInstall && primaryAction?.kind !== 'install' ? (
                              <button
                                type="button"
                                onClick={() => onApplyAgentDefaults(status.kind, 'install')}
                                disabled={pending}
                              >
                                {pending ? 'Installing…' : 'Install'}
                              </button>
                            ) : null}
                            {presentation.canUpdate && primaryAction?.kind !== 'update' ? (
                              <button
                                type="button"
                                onClick={() => onApplyAgentDefaults(status.kind, 'update')}
                                disabled={pending}
                              >
                                {pending ? 'Updating…' : 'Update'}
                              </button>
                            ) : null}
                            {presentation.canReinstall ? (
                              <button
                                type="button"
                                onClick={() => onApplyAgentDefaults(status.kind, 'reinstall')}
                                disabled={pending}
                              >
                                {pending ? 'Reinstalling…' : 'Reinstall'}
                              </button>
                            ) : null}
                            <button type="button" onClick={() => onCopyBridgeSnippet(status.kind)}>
                              Copy setup
                            </button>
                            {isCodex ? (
                              <button type="button" onClick={onCopyCodexTokenExport}>
                                Copy token export
                              </button>
                            ) : null}
                          </div>
                        </details>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </section>
        </CollapsibleSection>
        </div>
      </section>
    </div>
  );
}
