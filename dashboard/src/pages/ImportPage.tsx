import { useNavigate } from "react-router-dom";
import { PageChrome } from "./PageChrome";
import { SourceIngestForm } from "./SourceIngestForm";

/** Standalone import surface — prototype ImportView is not the 资料 list. */
export function ImportPage() {
  const navigate = useNavigate();
  return (
    <PageChrome title="导入" state="idle">
      <SourceIngestForm onDone={() => navigate("/sources")} />
    </PageChrome>
  );
}
