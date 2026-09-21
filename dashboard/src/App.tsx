import { Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { Chrome } from "./chrome/Chrome";
import { BrowsePage } from "./pages/BrowsePage";
import { ChunkDetailPage } from "./pages/ChunkDetailPage";
import { EntityDetailPage } from "./pages/EntityDetailPage";
import { GraphPage } from "./pages/GraphPage";
import { ImportPage } from "./pages/ImportPage";
import { MaintenancePage } from "./pages/MaintenancePage";
import { NeighborhoodPage } from "./pages/NeighborhoodPage";
import { SourceDetailPage } from "./pages/SourceDetailPage";
import { SourcesPage } from "./pages/SourcesPage";
import { StatsPage } from "./pages/StatsPage";
import { TimelinePage } from "./pages/TimelinePage";

export function App() {
  // T8 — graph node → entity. The router boundary owns navigation;
  // GraphPage is router-agnostic and receives the handler via prop so
  // existing tests that render it without a Router wrapper keep
  // working.
  const navigate = useNavigate();
  const onSelectNode = (id: string): void => {
    navigate(`/browse/entities/${id}`);
  };
  return (
    <div className="dash-shell min-h-screen bg-bg text-ink">
      <div className="dash-top-glow" aria-hidden="true" />
      <div className="dash-inner">
        <Chrome />
        <Routes>
          <Route path="/" element={<StatsPage />} />
          <Route path="/sources" element={<SourcesPage />} />
          <Route path="/sources/:id" element={<SourceDetailPage />} />
          <Route path="/import" element={<ImportPage />} />
          <Route path="/browse" element={<BrowsePage />} />
          <Route path="/browse/chunks/:id" element={<ChunkDetailPage />} />
          <Route
            path="/browse/entities/:id/neighborhood"
            element={<NeighborhoodPage />}
          />
          <Route path="/browse/entities/:id" element={<EntityDetailPage />} />
          <Route path="/timeline" element={<TimelinePage />} />
          <Route path="/maintenance" element={<MaintenancePage />} />
          <Route
            path="/graph"
            element={<GraphPage onSelectNode={onSelectNode} />}
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </div>
  );
}
