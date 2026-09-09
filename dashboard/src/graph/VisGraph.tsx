import { useEffect, useRef } from "react";
import { Network } from "vis-network/standalone";
import type { GraphBody } from "../api";

type VisGraphProps = {
  data: GraphBody;
};

export function VisGraph({ data }: VisGraphProps) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const network = new Network(
      el,
      {
        nodes: data.nodes.map((node) => ({
          id: node.id,
          label: node.name ?? node.id,
        })),
        edges: data.edges.map((edge) => ({
          from: edge.from,
          to: edge.to,
          label: edge.type,
        })),
      },
      {
        autoResize: true,
        physics: { enabled: data.nodes.length < 80 },
      }
    );
    return () => {
      network.destroy();
    };
  }, [data]);

  return (
    <div
      ref={host}
      data-testid="graph-canvas"
      className="h-[480px] w-full rounded-md border border-line bg-surface"
    />
  );
}
