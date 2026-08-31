---
"kimaki": patch
---

Prevent external shuvcode session sync from repeatedly posting complete session histories to Discord by preserving stable message-part identifiers and rejecting malformed parts without identifiers.
