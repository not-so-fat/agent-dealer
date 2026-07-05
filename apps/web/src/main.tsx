import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ensureMonacoFontLoaded } from "./fonts";
import "./index.css";

void ensureMonacoFontLoaded();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
