import { describe, expect, it } from "vitest";
import {
  cssFontFamilyFromWtFace,
  parseWindowsTerminalAppearance,
  resolveConsoleFontFamily,
  windowsTerminalSchemeToXtermTheme,
} from "../terminal/windows-terminal-theme";

const FIXTURE = `{
  "defaultProfile": "{574e775e-4f2a-5b96-ac1e-a2962a402336}",
  "profiles": {
    "defaults": {
      "colorScheme": "Tokyo Night",
      "font": { "face": "JetBrainsMono Nerd Font, Cascadia Code", "size": 11 }
    },
    "list": [
      {
        "guid": "{574e775e-4f2a-5b96-ac1e-a2962a402336}",
        "name": "PowerShell",
        "source": "Windows.Terminal.PowershellCore"
      }
    ]
  },
  "schemes": [
    {
      "background": "#1A1B26",
      "black": "#32344A",
      "blue": "#7AA2F7",
      "brightBlack": "#444B6A",
      "brightBlue": "#7DA6FF",
      "brightCyan": "#0DB9D7",
      "brightGreen": "#B9F27C",
      "brightPurple": "#BB9AF7",
      "brightRed": "#FF7A93",
      "brightWhite": "#ACB0D0",
      "brightYellow": "#FF9E64",
      "cursorColor": "#C0CAF5",
      "cyan": "#449DAB",
      "foreground": "#A9B1D6",
      "green": "#9ECE6A",
      "name": "Tokyo Night",
      "purple": "#AD8EE6",
      "red": "#F7768E",
      "selectionBackground": "#283457",
      "white": "#787C99",
      "yellow": "#E0AF68"
    }
  ]
}`;

describe("Windows Terminal appearance", () => {
  it("parses default profile scheme and nerd font face", () => {
    const appearance = parseWindowsTerminalAppearance(FIXTURE);
    expect(appearance).not.toBeNull();
    expect(appearance!.colorSchemeName).toBe("Tokyo Night");
    expect(appearance!.fontFace).toBe(
      "JetBrainsMono Nerd Font, Cascadia Code",
    );
    expect(appearance!.fontSize).toBe(11);
    expect(appearance!.scheme?.name).toBe("Tokyo Night");
    expect(appearance!.scheme?.background).toBe("#1A1B26");
  });

  it("maps purple to xterm magenta", () => {
    const appearance = parseWindowsTerminalAppearance(FIXTURE)!;
    const theme = windowsTerminalSchemeToXtermTheme(appearance.scheme!);
    expect(theme.magenta).toBe("#AD8EE6");
    expect(theme.brightMagenta).toBe("#BB9AF7");
    expect(theme.background).toBe("#1A1B26");
    expect(theme.cursor).toBe("#C0CAF5");
  });

  it("quotes nerd font faces for CSS font-family", () => {
    expect(cssFontFamilyFromWtFace("JetBrainsMono Nerd Font, Cascadia Code")).toContain(
      "'JetBrainsMono Nerd Font'",
    );
    expect(cssFontFamilyFromWtFace("JetBrainsMono Nerd Font, Cascadia Code")).toContain(
      "Cascadia Code",
    );
  });

  it("prefers Terminal face over settings font", () => {
    expect(
      resolveConsoleFontFamily("CaskaydiaCove NF", "Consolas"),
    ).toContain("CaskaydiaCove NF");
    expect(resolveConsoleFontFamily(null, "Consolas")).toBe("Consolas");
  });

  it("returns null for invalid JSON", () => {
    expect(parseWindowsTerminalAppearance("{")).toBeNull();
  });
});
