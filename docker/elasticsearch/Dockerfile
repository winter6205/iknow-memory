# Elasticsearch 8.x + analysis-ik at the matching patch.
# Infra image only — not the Node MCP server.
#
# IK zip must match ES_VERSION exactly (plugin compiled per patch).
# Current channel: https://release.infinilabs.com/analysis-ik/stable/
ARG ES_VERSION=8.19.20
FROM docker.elastic.co/elasticsearch/elasticsearch:${ES_VERSION}

ARG ES_VERSION
RUN elasticsearch-plugin install --batch \
  "https://release.infinilabs.com/analysis-ik/stable/elasticsearch-analysis-ik-${ES_VERSION}.zip"
