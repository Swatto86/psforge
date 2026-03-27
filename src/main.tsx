import React from "react";
import ReactDOM from "react-dom/client";
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import "monaco-editor/esm/vs/basic-languages/powershell/powershell.contribution.js";
// Vite ?worker suffix bundles the Monaco editor worker into the production output
// and exposes it as a constructor.  Using new URL(…, import.meta.url) does NOT
// work for bare npm specifiers in Rollup — Vite resolves them relative to the
// HTML root and the build fails.  The ?worker pattern is the correct Vite-native
// approach and produces a properly hashed asset file in dist/.
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import App from "./App";
import "./styles.css";

// Configure Monaco to use the locally installed monaco-editor package instead of
// the default CDN (cdn.jsdelivr.net).  Tauri's Content Security Policy blocks
// external script sources, so the CDN load silently fails and the editor stays
// perpetually on "Loading editor...".
(self as unknown as Record<string, unknown>).MonacoEnvironment = {
  getWorker(_moduleId: string, _label: string): Worker {
    return new EditorWorker();
  },
};

loader.config({ monaco });

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
