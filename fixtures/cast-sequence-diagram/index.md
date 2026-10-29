---
title: A sequence diagram
---

Two actors and one message.

```mermaid
sequenceDiagram
  participant A as The tab
  participant B as The server
  A->>B: a request
  B-->>A: an answer
```
