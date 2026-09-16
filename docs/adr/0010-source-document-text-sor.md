# 0010. 资料 is the prose system of record; chunk is a derived index row

Date: 2026-09-10
Status: accepted

Prose used to treat **chunk** text as the sole authoritative body. That made the dashboard a flat slice list and left no row for “the thing the operator put in.” **资料** is now the prose system of record (full body as pushed by the injector). Each **chunk** is a derived index row: slice text, embedding, ordinal, back-pointer to that 资料. iknow-memory still does not re-chunk (ADR-0004); fin remains the sole chunking authority. A one-item ingest creates one 资料 and one chunk whose texts match. Rebuild means drop/recreate chunks for a 资料 from the injector’s slices or, for the one-item path, from the 资料 body — not a second in-process chunker. ADR-0003 still governs vector/lexical indexes as derived; this ADR only moves the prose SoR from chunk to 资料.
