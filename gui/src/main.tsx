import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { LanguageProvider } from "./i18n";
import { installLocalKeyFetch } from "./local-key";
import "./styles.css";

// Must run before any page fetches so an authenticated relay sees the key on the first request.
installLocalKeyFetch();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LanguageProvider>
      <App />
    </LanguageProvider>
  </React.StrictMode>
);
