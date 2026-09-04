import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import { resetBrowserStateForBuild } from "./browserState";
import "./styles.css";

resetBrowserStateForBuild();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
