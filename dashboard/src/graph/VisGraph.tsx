import { useLayoutEffect, useRef } from "react";
import { Network } from "vis-network/standalone";
import type { GraphBody } from "../api";
import { INK_ACTOR, INK_ARTIFACT, inkForType } from "./graphInk";

const NODE_FONT = { color: "#eee6d8", size: 12 };

type VisGraphProps = {
  data: GraphBody;
  /**
   * Click-to-entity handler (operator-console T8). A click on a graph
   * node opens the **entity** route (the existing
   * `/browse/entities/:id` page), never the 资料 route. The callback
   * receives the clicked node's id; the caller is responsible for
   * navigating (graph page wires this to `useNavigate`).
   */
  onSelectNode?: (id: string) => void;
};

/**
 * Board graph: Variant D — borderless canvas, top-left HUD,
 * labeled dots, two inks (actor vs artifact).
 */
export function VisGraph({ data, onSelectNode }: VisGraphProps) {
  const host = useRef<HTMLDivElement>(null);
  const networkRef = useRef<Network | null>(null);

  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const nodeIds = new Set(data.nodes.map((n) => n.id));
    const network = new Network(
      el,
      {
        nodes: data.nodes.map((node) => ({
          id: node.id,
          label: node.name ?? node.id,
          color: inkForType(node.type),
          font: NODE_FONT,
          borderWidth: 1,
          shape: "dot",
          size: 14,
        })),
        edges: data.edges
          .filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to))
          .map((edge) => ({
            from: edge.from,
            to: edge.to,
            title: edge.type ? `${edge.type} → ${edge.to}` : `→ ${edge.to}`,
            color: {
              color: "rgba(255,230,203,0.15)",
              highlight: "rgba(255,189,56,0.5)",
            },
            width: 1,
            arrows: { to: { enabled: true, scaleFactor: 0.4 } },
            smooth: { type: "continuous" },
          })),
      },
      {
        autoResize: true,
        physics: {
          enabled: true,
          solver: "forceAtlas2Based",
          forceAtlas2Based: {
            gravitationalConstant: -36,
            centralGravity: 0.012,
            springLength: 110,
            springConstant: 0.06,
            damping: 0.42,
          },
          stabilization: { enabled: true, iterations: 180, fit: true },
        },
        interaction: {
          hover: true,
          tooltipDelay: 200,
          zoomView: true,
          dragView: true,
          dragNodes: true,
          multiselect: false,
          navigationButtons: false,
        },
        nodes: {
          font: NODE_FONT,
          shape: "dot",
          hover: {
            borderColor: "rgba(255,189,56,0.6)",
            borderWidth: 2,
          },
        },
        edges: { smooth: { type: "continuous" } },
        layout: { improvedLayout: true },
      }
    );
    networkRef.current = network;
    const handler = onSelectNode;
    if (handler !== undefined) {
      network.on("selectNode", (params: { nodes: string[] }) => {
        const id = params.nodes[0];
        if (typeof id === "string" && id.length > 0) handler(id);
      });
    }
    return () => {
      networkRef.current = null;
      network.destroy();
    };
  }, [data, onSelectNode]);

  function fitView() {
    networkRef.current?.fit({
      animation: { duration: 280, easingFunction: "easeInOutQuad" },
    });
  }

  return (
    <div
      className="relative h-[calc(100vh-52px)] min-h-[400px] w-full overflow-hidden bg-transparent"
      data-testid="graph-stage"
    >
      <div
        ref={host}
        data-testid="graph-canvas"
        className="absolute inset-0 bg-transparent"
      />
      <div
        className="pointer-events-none absolute left-4 top-4 z-[2] font-sans text-[var(--title)]"
        data-testid="graph-hud"
      >
        <div className="flex items-center gap-3 text-[11px] uppercase tracking-wide text-[var(--text-secondary)]">
          <span>
            {data.nodes.length} nodes · {data.edges.length} edges
          </span>
          <button
            type="button"
            onClick={fitView}
            className="pointer-events-auto border-0 bg-transparent p-0 font-mono text-[11px] uppercase tracking-wide text-[var(--text-secondary)] underline-offset-2 hover:text-[var(--title)] hover:underline"
          >
            归位
          </button>
        </div>
        <div className="mt-2.5 flex flex-wrap gap-x-3 gap-y-1.5 text-[10px] text-[var(--text)] opacity-80">
          <span className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-1.5 w-1.5 rounded-full"
              style={{
                background: INK_ACTOR.background,
                border: `1px solid ${INK_ACTOR.border}`,
              }}
            />
            person / company
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-1.5 w-1.5 rounded-full"
              style={{
                background: INK_ARTIFACT.background,
                border: `1px solid ${INK_ARTIFACT.border}`,
              }}
            />
            project / doc / note / meeting
          </span>
        </div>
      </div>
    </div>
  );
}
