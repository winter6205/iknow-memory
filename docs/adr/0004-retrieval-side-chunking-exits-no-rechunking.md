# 0004. Chunking exits the retrieval service: no re-chunking

Date: 2026-08-31
Status: accepted

## Context

The retrieval service must preserve the text boundary established by the upstream parser and chunker. The binding contract is `specs/retrieval-stack.md` §B4 不二次切分 and change record C-11: “fin 推送的文本即最终文本。检索服务对推送内容不做任何形式的二次切分、截断、重组或归一化改写，按原样存储与召回；召回返回的块文本与推送文本逐字节相同”.

This boundary is required by the citation gate: the citation gate requires an answer span to be a contiguous substring of the frozen unit text. Re-chunking, truncating, reassembling, or rewriting pushed text could break that relationship.

## Decision

fin is the sole chunking authority. The decision is: no re-chunking, pushed text is final text. iknow-memory accepts the pushed text as-is and does not split, truncate, reassemble, or normalize/rewrite it. It stores and recalls that text byte-for-byte, so returned chunk text remains identical to the pushed text.

## Consequences

- The retrieval service no longer owns a chunking step in its ingest pipeline.
- The `chunk` and `ingest` terms, and the `content → chunker → chunk[]` relationship in `docs/CONTEXT.md`, describe fin-owned chunking and retrieval-side storage of final pushed text.
- Citation checking can compare answer spans against the same frozen text that fin produced and pushed.

Evidence pointers: `specs/retrieval-stack.md` §B4 不二次切分 and C-11.
