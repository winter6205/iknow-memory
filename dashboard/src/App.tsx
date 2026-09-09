import { Navigate, Route, Routes } from "react-router-dom";
import { Chrome } from "./chrome/Chrome";
import { BrowsePage } from "./pages/BrowsePage";
import { ChunkDetailPage } from "./pages/ChunkDetailPage";
import { EntityDetailPage } from "./pages/EntityDetailPage";
import { GraphPage } from "./pages/GraphPage";
import { NeighborhoodPage } from "./pages/NeighborhoodPage";
import { QueryPage } from "./pages/QueryPage";
import { StatsPage } from "./pages/StatsPage";
import { TimelinePage } from "./pages/TimelinePage";

export function App() {
  return (
    <div className="dash-shell min-h-screen bg-bg text-ink">
      <div className="dash-top-glow" aria-hidden="true" />
      <div className="dash-inner">
        <Chrome />
        <Routes>
          <Route path="/" element={<StatsPage />} />
          <Route path="/query" element={<QueryPage />} />
          <Route path="/browse" element={<BrowsePage />} />
          <Route path="/browse/chunks/:id" element={<ChunkDetailPage />} />
          <Route
            path="/browse/entities/:id/neighborhood"
            element={<NeighborhoodPage />}
          />
          <Route path="/browse/entities/:id" element={<EntityDetailPage />} />
          <Route path="/timeline" element={<TimelinePage />} />
          <Route path="/graph" element={<GraphPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </div>
  );
}
