import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('desktop tauri script', () => {
  it('pins Cargo artifacts to the workspace target directory', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.tauri).toContain(
      'CARGO_TARGET_DIR=../../target',
    );
  });

  it('starts the dashboard window hidden so the tray is the cold-start surface', () => {
    const tauriConfig = JSON.parse(
      readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
    ) as {
      app?: {
        windows?: Array<{ label?: string; visible?: boolean }>;
      };
    };

    const mainWindow = tauriConfig.app?.windows?.find(
      (window) => window.label === 'main',
    );

    expect(mainWindow?.visible).toBe(false);
  });

  it('defines a hidden frameless menu bar popover window', () => {
    const tauriConfig = JSON.parse(
      readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
    ) as {
      app?: {
        windows?: Array<{
          label?: string;
          url?: string;
          visible?: boolean;
          decorations?: boolean;
          resizable?: boolean;
          skipTaskbar?: boolean;
          alwaysOnTop?: boolean;
        }>;
      };
    };

    const popoverWindow = tauriConfig.app?.windows?.find(
      (window) => window.label === 'menubar',
    );

    expect(popoverWindow).toMatchObject({
      url: '/?surface=menubar',
      visible: false,
      decorations: false,
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
    });
  });

  it('does not force macOS LSUIElement because runtime activation owns mode changes', () => {
    const infoPlistPath = new URL('../src-tauri/Info.plist', import.meta.url);

    if (!existsSync(infoPlistPath)) {
      expect(existsSync(infoPlistPath)).toBe(false);
      return;
    }

    const infoPlist = readFileSync(infoPlistPath, 'utf8');
    expect(infoPlist).not.toContain('<key>LSUIElement</key>');
  });

  it('does not configure a second tray icon in tauri config', () => {
    const tauriConfig = JSON.parse(
      readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
    ) as {
      app?: {
        trayIcon?: unknown;
      };
    };

    expect(tauriConfig.app).not.toHaveProperty('trayIcon');
  });
});
