import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { applyTheme, useThemeStore } from "./theme/store";
import "./index.css";

const mount = document.getElementById("root");
if (!mount) {
  throw new Error("missing #root");
}

applyTheme(useThemeStore.getState().theme, document.documentElement);

createRoot(mount).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>
);
