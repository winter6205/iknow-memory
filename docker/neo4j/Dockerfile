# Neo4j 5.26 LTS + GDS 2.13.x (the pairing in scripts/neo4j.sh).
# Infra image only — not the Node MCP server.
# Baking the plugin avoids a first-start download of graphdatascience.ninja
# that can leave Bolt down past the healthcheck window.
ARG NEO4J_VERSION=5.26.0
ARG GDS_VERSION=2.13.2

FROM alpine:3.20 AS gds
ARG GDS_VERSION
RUN apk add --no-cache curl unzip \
  && curl -fsSL -o /tmp/gds.zip \
    "https://graphdatascience.ninja/neo4j-graph-data-science-${GDS_VERSION}.zip" \
  && mkdir -p /plugins \
  && unzip -q -o -j /tmp/gds.zip "*.jar" -d /plugins \
  && rm -f /tmp/gds.zip

FROM neo4j:${NEO4J_VERSION}-community
COPY --from=gds /plugins/*.jar /var/lib/neo4j/plugins/
