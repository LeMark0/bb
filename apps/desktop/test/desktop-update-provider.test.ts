import { describe, expect, it } from "vitest";
import { resolveDesktopBuildUpdates } from "../scripts/desktop-release-channel.mjs";
import {
  createDesktopUpdateFeedUrl,
  resolveDesktopUpdateSupport,
} from "../src/desktop-update-provider.js";

describe("desktop update feed url", () => {
  it("gives each platform its own feed file inside one release tag", () => {
    expect(createDesktopUpdateFeedUrl("macos")).toBe(
      "https://github.com/get-bb/bb/releases/download/desktop-latest/desktop-version.json",
    );
    expect(createDesktopUpdateFeedUrl("linux")).toBe(
      "https://github.com/get-bb/bb/releases/download/desktop-latest/desktop-version-linux.json",
    );
    expect(createDesktopUpdateFeedUrl("windows")).toBe(
      "https://github.com/get-bb/bb/releases/download/desktop-latest/desktop-version-windows.json",
    );
  });
});

const APP_IMAGE_PATH = "/home/user/Apps/bb-0.37.0-x86_64.AppImage";
const alwaysReplaceable = () => true;
const neverReplaceable = () => false;

describe("desktop update support", () => {
  it("enables both update paths on macOS", () => {
    expect(
      resolveDesktopUpdateSupport({
        canReplaceAppImage: neverReplaceable,
        env: {},
        platform: "macos",
        updates: "enabled",
      }),
    ).toEqual({ autoUpdate: true, versionCheck: true });
  });

  it("checks for and installs updates on Windows", () => {
    expect(
      resolveDesktopUpdateSupport({
        canReplaceAppImage: alwaysReplaceable,
        env: { APPIMAGE: APP_IMAGE_PATH },
        platform: "windows",
        updates: "enabled",
      }),
    ).toEqual({ autoUpdate: true, versionCheck: true });
  });

  it("installs updates on Linux only inside an AppImage", () => {
    expect(
      resolveDesktopUpdateSupport({
        canReplaceAppImage: alwaysReplaceable,
        env: { APPIMAGE: APP_IMAGE_PATH },
        platform: "linux",
        updates: "enabled",
      }),
    ).toEqual({ autoUpdate: true, versionCheck: true });
    expect(
      resolveDesktopUpdateSupport({
        canReplaceAppImage: alwaysReplaceable,
        env: {},
        platform: "linux",
        updates: "enabled",
      }),
    ).toEqual({ autoUpdate: false, versionCheck: true });
    expect(
      resolveDesktopUpdateSupport({
        canReplaceAppImage: alwaysReplaceable,
        env: { APPIMAGE: "  " },
        platform: "linux",
        updates: "enabled",
      }),
    ).toEqual({ autoUpdate: false, versionCheck: true });
  });

  it("refuses to install into an AppImage it cannot replace", () => {
    const checked: Array<string> = [];

    expect(
      resolveDesktopUpdateSupport({
        canReplaceAppImage: (path) => {
          checked.push(path);
          return false;
        },
        env: { APPIMAGE: APP_IMAGE_PATH },
        platform: "linux",
        updates: "enabled",
      }),
    ).toEqual({ autoUpdate: false, versionCheck: true });
    expect(checked).toEqual([APP_IMAGE_PATH]);
  });

  it("does not consult the filesystem on macOS", () => {
    let consulted = false;

    resolveDesktopUpdateSupport({
      canReplaceAppImage: () => {
        consulted = true;
        return true;
      },
      env: { APPIMAGE: APP_IMAGE_PATH },
      platform: "macos",
      updates: "enabled",
    });

    expect(consulted).toBe(false);
  });

  it.each(["macos", "windows", "linux"] as const)(
    "turns off checks and installs on %s when the build disables updates",
    (platform) => {
      let consulted = false;

      expect(
        resolveDesktopUpdateSupport({
          canReplaceAppImage: () => {
            consulted = true;
            return true;
          },
          env: { APPIMAGE: APP_IMAGE_PATH },
          platform,
          updates: "disabled",
        }),
      ).toEqual({ autoUpdate: false, versionCheck: false });
      expect(consulted).toBe(false);
    },
  );
});

describe("desktop build updates setting", () => {
  it("keeps updates on when BB_DESKTOP_UPDATES is unset or blank", () => {
    expect(resolveDesktopBuildUpdates({})).toBe("enabled");
    expect(resolveDesktopBuildUpdates({ BB_DESKTOP_UPDATES: " " })).toBe(
      "enabled",
    );
  });

  it("accepts disabled with surrounding whitespace", () => {
    expect(
      resolveDesktopBuildUpdates({ BB_DESKTOP_UPDATES: " disabled " }),
    ).toBe("disabled");
  });

  it.each(["0", "false", "off", "Disabled"])(
    "fails the build for the unsupported value %s",
    (value) => {
      expect(() =>
        resolveDesktopBuildUpdates({ BB_DESKTOP_UPDATES: value }),
      ).toThrow(
        `BB_DESKTOP_UPDATES must be enabled or disabled, got ${value}.`,
      );
    },
  );
});
