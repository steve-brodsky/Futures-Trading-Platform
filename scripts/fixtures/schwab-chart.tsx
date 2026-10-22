// Browser demo only: exercise the complete App-to-chart filtering path with
// Schwab's ETF response classification. Never exposes native broker commands.
import { createRoot } from "react-dom/client";
import App from "../../src/App";
import { demoSchwabOrders, demoSchwabPositions } from "../../src/lib/demo";
import "../../src/styles.css";

if ("__TAURI_INTERNALS__" in window) throw new Error("Run this fixture in a browser without a broker connection");
for (const row of [...demoSchwabOrders, ...demoSchwabPositions]) {
  if (row.assetType === "EQUITY") row.assetType = "COLLECTIVE_INVESTMENT";
}
createRoot(document.getElementById("root")!).render(<App />);
